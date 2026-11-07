import { ownedGitArguments } from "../filesystem/preparation-git-isolation.mjs";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizedTaskSquashTransfer } from "../../domain/task-squash-transfer.mjs";
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  return tasks.map((task) => {
    const resultReleaseRevision = task?.resultReleaseRevision == null
      ? null
      : Number(task.resultReleaseRevision);
    if (resultReleaseRevision != null
        && (!Number.isInteger(resultReleaseRevision) || resultReleaseRevision < 1)) {
      throw new Error(`release Task ${task?.taskId ?? "unknown"} has an invalid result release revision`);
    }
    return {
      taskId: String(task?.taskId ?? ""),
      taskRevision: Number(task?.taskRevision),
      ...(resultReleaseRevision != null ? { resultReleaseRevision } : {}),
      resultCommit: String(task?.resultCommit ?? ""),
      ...(task?.squashTransfer
        ? { squashTransfer: normalizedTaskSquashTransfer(task.squashTransfer) }
        : {}),
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
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
      || (task.resultReleaseRevision ?? null) !== (expectedTask.resultReleaseRevision ?? null)
      || String(task.squashTransfer?.transferHash ?? "")
        !== String(expectedTask.squashTransfer?.transferHash ?? "")
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

async function gitOutput(args, { cwd }) {
  const { stdout } = await execFileAsync("git", ownedGitArguments(args), { cwd, windowsHide: true, encoding: "utf8" });
  return String(stdout).trim();
}

async function gitSnapshot(root) {
  const [head, tree, status] = await Promise.all([
    gitOutput(["rev-parse", "HEAD^{commit}"], { cwd: root }),
    gitOutput(["rev-parse", "HEAD^{tree}"], { cwd: root }),
    gitOutput(["status", "--porcelain=v1", "--untracked-files=no"], { cwd: root }),
  ]);
  return { head, tree, trackedStatus: status };
}

async function fileSha256(file, { root }) {
  const bytes = await readFile(file);
  return {
    path: path.relative(root, file).replaceAll(path.sep, "/"),
    size: (await stat(file)).size,
    sha256: sha256(bytes),
  };
}

async function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).catch(() => {});
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
}

async function runCommand(command, args, { cwd, timeoutMs = 30 * 60 * 1000 }) {
  const executable = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)
    ? "cmd.exe"
    : command;
  const finalArgs = executable === "cmd.exe" ? ["/d", "/s", "/c", command, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, finalArgs, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child).finally(() => reject(new Error(`release validation command timed out: ${command}`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBytes = Buffer.concat(stdout);
      const stderrBytes = Buffer.concat(stderr);
      const result = {
        command,
        args,
        cwd,
        exitCode: code,
        stdoutSha256: sha256(stdoutBytes),
        stderrSha256: sha256(stderrBytes),
        stdoutBytes: stdoutBytes.length,
        stderrBytes: stderrBytes.length,
      };
      if (code === 0) resolve(result);
      else {
        const error = new Error(`release validation command failed: ${command} exited ${code}`);
        error.result = result;
        reject(error);
      }
    });
  });
}

async function writeEvidence(file, evidence) {
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceHash = sha256(bytes);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, "utf8");
  await rename(temporary, file);
  const readback = await readFile(file, "utf8");
  if (sha256(readback) !== evidenceHash) {
    throw new Error("release validation evidence readback does not match its digest");
  }
  return { evidenceHash };
}

function validationRoot(dataDir, runId) {
  const root = path.resolve(String(dataDir ?? "").trim() || path.join(os.tmpdir(), "agent-hub-release-validation"));
  return {
    root,
    worktree: path.join(root, "worktrees", runId),
    evidenceFile: path.join(root, "evidence", `${runId}.json`),
  };
}

export async function runRepositoryValidationCommands({
  policy, repository, workspaceId, planRevision, dataDir = null,
}) {
  const candidate = repository.frozenCandidate;
  const runId = randomUUID();
  const layout = validationRoot(dataDir, runId);
  const startedAt = new Date().toISOString();
  const commandResults = [];
  let before = null;
  let after = null;
  let artifacts = [];
  try {
    await mkdir(path.dirname(layout.worktree), { recursive: true });
    await gitOutput(["clone", "--no-checkout", path.resolve(candidate.releaseRoot), layout.worktree], { cwd: path.dirname(layout.worktree) });
    await gitOutput(["checkout", "--detach", candidate.preReleaseHead], { cwd: layout.worktree });
    before = await gitSnapshot(layout.worktree);
    if (before.head !== candidate.preReleaseHead || (candidate.tree != null && before.tree !== candidate.tree) || before.trackedStatus) {
      throw new Error("release validation checkout is not the exact frozen candidate");
    }
    for (const command of policy.check.commands) {
      const cwd = path.resolve(layout.worktree, command.cwd);
      if (!pathInsideOrSame(cwd, layout.worktree)) throw new Error("release validation command cwd escapes frozen candidate");
      commandResults.push(await runCommand(command.command, command.args, { cwd }));
    }
    after = await gitSnapshot(layout.worktree);
    if (after.head !== candidate.preReleaseHead) {
      throw new Error("release validation command moved the frozen candidate HEAD");
    }
    if (candidate.tree != null && after.tree !== candidate.tree) {
      throw new Error("release validation command changed the frozen candidate tree");
    }
    if (after.trackedStatus) {
      throw new Error("release validation command left tracked candidate changes");
    }
    artifacts = [];
    for (const artifact of policy.check.artifacts) {
      const file = path.resolve(layout.worktree, artifact);
      if (!pathInsideOrSame(file, layout.worktree)) throw new Error("release validation artifact escapes frozen candidate");
      artifacts.push(await fileSha256(file, { root: layout.worktree }));
    }
    const evidence = {
      schemaVersion: 1,
      runId,
      status: "passed",
      workspaceId,
      planRevision,
      repositoryRoot: repository.projectRoot,
      candidateCommit: candidate.preReleaseHead,
      tree: candidate.tree ?? null,
      manifestHash: candidate.manifestHash,
      manifest: {
        workspaceId: candidate.manifest?.workspaceId ?? null,
        planRevision: candidate.manifest?.planRevision ?? candidate.planRevision,
        tasks: normalizeTasks(candidate.manifest?.tasks ?? []),
      },
      policy: {
        id: policy.check.id,
        kind: policy.check.kind,
        commands: policy.check.commands,
        artifacts: policy.check.artifacts,
      },
      buildInputs: {
        releaseRoot: path.resolve(candidate.releaseRoot),
        validationRoot: layout.worktree,
        manifestHash: candidate.manifestHash,
        baseCommit: candidate.baseCommit ?? null,
      },
      before,
      after,
      commands: commandResults,
      artifacts,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    const { evidenceHash } = await writeEvidence(layout.evidenceFile, evidence);
    return {
      ...evidence,
      evidenceFile: layout.evidenceFile,
      evidenceHash,
    };
  } finally {
    await rm(layout.worktree, { recursive: true, force: true }).catch(() => {});
  }
}

export function createRepositoryProductionValidationAdapter({
  policies = [],
  runCheck = runRepositoryValidationCommands,
  dataDir = null,
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
        dataDir,
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
        evidenceFile: result.evidenceFile ?? null,
        evidenceHash: result.evidenceHash ?? null,
        runId: result.runId ?? null,
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
