import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathInsideOrSame, samePath } from "../filesystem/config.mjs";

const execFileAsync = promisify(execFile);

function pathKey(value) {
  const resolved = path.resolve(String(value ?? "").trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function normalizePolicy(policy = {}) {
  const projectRoot = path.resolve(requiredText(policy.projectRoot ?? policy.root, "release validation projectRoot"));
  const check = policy.check ?? {};
  const commands = Array.isArray(check.commands) ? check.commands : [];
  if (policy.enabled !== true) {
    return { ...policy, enabled: false, projectRoot, check: { ...check, commands } };
  }
  const id = requiredText(check.id ?? check.checkId, "release validation check id");
  const kind = requiredText(check.kind, "release validation check kind");
  if (!commands.length) throw new Error(`release validation policy for ${projectRoot} requires commands`);
  return {
    ...policy,
    enabled: true,
    projectRoot,
    check: {
      ...check,
      id,
      kind,
      commands: commands.map((command, index) => ({
        command: requiredText(command.command, `release validation command[${index}].command`),
        args: Array.isArray(command.args) ? command.args.map((item) => String(item)) : [],
        cwd: String(command.cwd ?? ".").trim() || ".",
      })),
      artifacts: Array.isArray(check.artifacts) ? check.artifacts.map((item) => String(item).trim()).filter(Boolean) : [],
    },
  };
}

function normalizeTasks(tasks = []) {
  return tasks.map((task) => ({
    taskId: String(task?.taskId ?? ""),
    taskRevision: Number(task?.taskRevision),
    resultCommit: String(task?.resultCommit ?? ""),
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function sameTaskEvidence(candidateTasks = [], repository = {}) {
  const expectedTasks = normalizeTasks(repository.frozenTasks ?? []);
  const expected = new Map(expectedTasks.length
    ? expectedTasks.map((task) => [task.taskId, task])
    : (repository.taskIds ?? []).map((taskId) => [String(taskId), null]));
  const resultCommits = new Set((repository.resultCommits ?? []).map((item) => String(item)));
  const actual = new Map(normalizeTasks(candidateTasks).map((task) => [task.taskId, task]));
  if (actual.size !== expected.size) return false;
  for (const [taskId, expectedTask] of expected.entries()) {
    const task = actual.get(taskId);
    if (!task || !Number.isInteger(task.taskRevision) || !resultCommits.has(task.resultCommit)) return false;
    if (expectedTask && (
      task.taskRevision !== expectedTask.taskRevision
      || task.resultCommit !== expectedTask.resultCommit
    )) return false;
  }
  return true;
}

function assertFrozenCandidate(repository, { workspaceId, planRevision } = {}) {
  const candidate = repository?.frozenCandidate;
  if (!candidate?.releaseRoot || !candidate?.preReleaseHead || !candidate?.manifestHash) {
    throw new Error(`release validation requires frozen candidate evidence for ${repository?.projectRoot}`);
  }
  if (String(candidate.planRevision ?? "") !== String(planRevision)) {
    throw new Error(`release validation candidate plan is stale for ${repository.projectRoot}`);
  }
  if (!samePath(candidate.repositoryRoot, repository.projectRoot)) {
    throw new Error(`release validation candidate belongs to another repository: ${repository.projectRoot}`);
  }
  if (candidate.manifest?.workspaceId != null && String(candidate.manifest.workspaceId) !== String(workspaceId)) {
    throw new Error(`release validation candidate belongs to another Workspace: ${repository.projectRoot}`);
  }
  if (!sameTaskEvidence(candidate.manifest?.tasks ?? [], repository)) {
    throw new Error(`release validation candidate Task evidence is stale for ${repository.projectRoot}`);
  }
  return candidate;
}

async function fileSha256(file) {
  const bytes = await readFile(file);
  return {
    path: file,
    size: (await stat(file)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function runCommand(command, args, { cwd }) {
  const executable = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)
    ? "cmd.exe"
    : command;
  const finalArgs = executable === "cmd.exe" ? ["/d", "/s", "/c", command, ...args] : args;
  const { stdout, stderr } = await execFileAsync(executable, finalArgs, {
    cwd,
    windowsHide: true,
    timeout: 30 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    command,
    args,
    cwd,
    exitCode: 0,
    stdoutSha256: createHash("sha256").update(String(stdout ?? "")).digest("hex"),
    stderrSha256: createHash("sha256").update(String(stderr ?? "")).digest("hex"),
  };
}

export async function runRepositoryValidationCommands({ policy, repository }) {
  const candidate = repository.frozenCandidate;
  const releaseRoot = path.resolve(candidate.releaseRoot);
  const commandResults = [];
  for (const command of policy.check.commands) {
    const cwd = path.resolve(releaseRoot, command.cwd);
    if (!pathInsideOrSame(cwd, releaseRoot)) throw new Error("release validation command cwd escapes frozen candidate");
    commandResults.push(await runCommand(command.command, command.args, { cwd }));
  }
  const artifacts = [];
  for (const artifact of policy.check.artifacts) {
    const file = path.resolve(releaseRoot, artifact);
    if (!pathInsideOrSame(file, releaseRoot)) throw new Error("release validation artifact escapes frozen candidate");
    artifacts.push(await fileSha256(file));
  }
  return {
    status: "passed",
    repositoryRoot: repository.projectRoot,
    candidateCommit: candidate.preReleaseHead,
    tree: candidate.tree ?? null,
    commands: commandResults,
    artifacts,
    buildInputs: {
      releaseRoot,
      manifestHash: candidate.manifestHash,
      baseCommit: candidate.baseCommit ?? null,
    },
  };
}

export function createRepositoryProductionValidationAdapter({
  policies = [],
  runCheck = runRepositoryValidationCommands,
} = {}) {
  const policyByRoot = new Map(policies.map((policy) => {
    const normalized = normalizePolicy(policy);
    return [pathKey(normalized.projectRoot), normalized];
  }));
  return async function validateProductionCandidate({
    workspaceId, planRevision, repositories = [], source = {},
  } = {}) {
    if (!repositories.length) throw new Error("repository production validation requires repositories");
    const evidence = [];
    const checkedRepositories = [];
    for (const repository of repositories) {
      const projectRoot = path.resolve(requiredText(repository.projectRoot, "validation repository projectRoot"));
      const policy = policyByRoot.get(pathKey(projectRoot));
      if (!policy?.enabled) {
        throw new Error(
          `release preflight requires configured repository-owned validation for ${projectRoot}; `
          + "enable an explicit releaseValidation repository policy before retrying",
        );
      }
      const candidate = assertFrozenCandidate({ ...repository, projectRoot }, { workspaceId, planRevision });
      const result = await runCheck({
        policy,
        repository: { ...repository, projectRoot, frozenCandidate: candidate },
        workspaceId,
        planRevision,
        source,
      });
      if (result?.status !== "passed") {
        throw new Error(`repository production validation failed for ${projectRoot}`);
      }
      if (String(result.candidateCommit ?? "") !== String(candidate.preReleaseHead)) {
        throw new Error(`repository production validation evidence is stale for ${projectRoot}`);
      }
      if (candidate.tree != null && result.tree != null && String(result.tree) !== String(candidate.tree)) {
        throw new Error(`repository production validation tree evidence is stale for ${projectRoot}`);
      }
      evidence.push({
        repositoryRoot: projectRoot,
        candidateCommit: candidate.preReleaseHead,
        candidateTree: candidate.tree ?? null,
        manifestHash: candidate.manifestHash,
        checkId: policy.check.id,
        checkKind: policy.check.kind,
        commands: result.commands ?? [],
        artifacts: result.artifacts ?? [],
        buildInputs: result.buildInputs ?? null,
      });
      checkedRepositories.push({
        projectRoot,
        headCommit: repository.headCommit,
        resultCommits: [...(repository.resultCommits ?? [])],
        taskIds: [...(repository.taskIds ?? [])],
        frozenTasks: normalizeTasks(repository.frozenTasks ?? []),
        candidateCommit: candidate.preReleaseHead,
        candidateTree: candidate.tree ?? null,
        manifestHash: candidate.manifestHash,
      });
    }
    return {
      status: "ready",
      workspaceId,
      planRevision,
      repositories: checkedRepositories,
      check: {
        kind: "repository-owned-production-validation",
        id: evidence.map((item) => `${item.repositoryRoot}:${item.checkId}:${item.candidateCommit}`).join("|"),
      },
      evidence,
    };
  };
}
