import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadConfig } from "./src/infrastructure/filesystem/config.mjs";
import { ReleaseGitWorkspaceService } from "./src/infrastructure/filesystem/release-git-workspace.mjs";

const execute = promisify(execFile);
const moduleFile = fileURLToPath(import.meta.url);
const sourceRoot = path.dirname(moduleFile);
const ownerFile = path.join(sourceRoot, "src", "infrastructure", "filesystem", "release-git-workspace.mjs");
const commitPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const FREEZING_MODE = "abandon-freezing-candidate-v1";
const FAILED_FROZEN_MODE = "abandon-failed-frozen-candidate-v1";

function required(values, name) {
  const value = String(values[name] ?? "").trim();
  if (!value) throw new Error(`Missing value for --${name}`);
  return value;
}

export function parseReleaseFreezeRecoveryArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === "confirm-recovery") {
      values[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values[name] = value;
    index += 1;
  }
  const expectedSourceCommit = required(values, "expected-source-commit").toLowerCase();
  const expectedOwnerSha256 = required(values, "expected-owner-sha256").toLowerCase();
  const recoveryMode = String(values["recovery-mode"] ?? FREEZING_MODE).trim();
  if (!commitPattern.test(expectedSourceCommit)) throw new Error("--expected-source-commit must be an exact commit");
  if (!digestPattern.test(expectedOwnerSha256)) throw new Error("--expected-owner-sha256 must be a SHA-256 digest");
  const parsed = {
    projectRoot: path.resolve(required(values, "repository")),
    workspaceId: required(values, "workspace"),
    requestId: required(values, "request-id"),
    expectedSourceCommit,
    expectedOwnerSha256,
    recoveryMode,
    expected: {
      planRevision: required(values, "expected-plan-revision"),
      manifestHash: required(values, "expected-manifest-hash").toLowerCase(),
      preparedHead: required(values, "expected-prepared-head").toLowerCase(),
      frozenHead: required(values, "expected-frozen-head").toLowerCase(),
      frozenTree: required(values, "expected-frozen-tree").toLowerCase(),
      publishedRevision: required(values, "expected-published-revision").toLowerCase(),
      approvedOriginMain: required(values, "expected-origin-main").toLowerCase(),
    },
    confirm: values["confirm-recovery"] === true,
    expectedProofHash: String(values["expected-proof"] ?? "").trim().toLowerCase() || null,
  };
  if (![FREEZING_MODE, FAILED_FROZEN_MODE].includes(recoveryMode)) {
    throw new Error("--recovery-mode is unsupported");
  }
  if (recoveryMode === FAILED_FROZEN_MODE) {
    parsed.expected.publicationRunId = required(values, "expected-publication-run-id");
    parsed.expected.publicationRunSha256 = required(values, "expected-publication-run-sha256").toLowerCase();
    parsed.expected.publicationCheckpointSha256 = required(
      values, "expected-publication-checkpoint-sha256",
    ).toLowerCase();
    parsed.expected.publicationLogSha256 = required(values, "expected-publication-log-sha256").toLowerCase();
  }
  for (const [name, value] of Object.entries(parsed.expected)) {
    if (name === "publicationRunId") continue;
    const pattern = ["planRevision", "manifestHash", "publicationRunSha256", "publicationCheckpointSha256",
      "publicationLogSha256"].includes(name) ? digestPattern : commitPattern;
    if (!pattern.test(value)) throw new Error(`invalid exact recovery identity: ${name}`);
  }
  if (parsed.confirm !== Boolean(parsed.expectedProofHash)) {
    throw new Error("confirmation requires both --confirm-recovery and --expected-proof");
  }
  if (parsed.expectedProofHash && !digestPattern.test(parsed.expectedProofHash)) {
    throw new Error("--expected-proof must be a SHA-256 digest");
  }
  return parsed;
}

export async function inspectReleaseFreezeRecoverySource(input, {
  exec = execute,
  read = readFile,
} = {}) {
  const git = async (...args) => String((await exec("git", args, {
    cwd: sourceRoot, windowsHide: true, encoding: "utf8",
  })).stdout).trim();
  const [head, dirty, ownerBytes] = await Promise.all([
    git("rev-parse", "HEAD^{commit}"),
    git("status", "--porcelain=v1", "--untracked-files=all"),
    read(ownerFile),
  ]);
  if (head !== input.expectedSourceCommit) throw new Error("release freeze recovery source commit changed");
  if (dirty) throw new Error("release freeze recovery source checkout is dirty");
  const ownerSha256 = createHash("sha256").update(ownerBytes).digest("hex");
  if (ownerSha256 !== input.expectedOwnerSha256) throw new Error("release freeze recovery owner hash changed");
  return { sourceRoot, head, ownerFile, ownerSha256 };
}

export async function executeReleaseFreezeRecovery(input, {
  inspectSource = inspectReleaseFreezeRecoverySource,
  load = loadConfig,
  createService = (config) => new ReleaseGitWorkspaceService({ dataDir: config.dataDir }),
} = {}) {
  const source = await inspectSource(input);
  const config = await load();
  const result = await createService(config).recoverFreezingPublicationCandidate({
    ...input,
    sourceIdentity: { commit: source.head, ownerSha256: source.ownerSha256 },
  });
  return { source, result };
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(moduleFile)) {
  executeReleaseFreezeRecovery(parseReleaseFreezeRecoveryArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
