import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createMissingProvenanceResolver,
  MISSING_PROVENANCE_RECOVERY_KIND,
} from "./src/application/release-missing-provenance-resolver.mjs";
import { loadConfig } from "./src/infrastructure/filesystem/config.mjs";
import { ReleaseGitWorkspaceService } from "./src/infrastructure/filesystem/release-git-workspace.mjs";
import { TaskGitWorkspaceService } from "./src/infrastructure/filesystem/task-git-workspace.mjs";
import { WorkspaceCatalogStore } from "./src/infrastructure/persistence/workspace-catalog-store.mjs";

const execute = promisify(execFile);
const moduleFile = fileURLToPath(import.meta.url);
const sourceRoot = path.dirname(moduleFile);
const ownerFile = path.join(sourceRoot, "src", "infrastructure", "filesystem", "release-git-workspace.mjs");
const commitPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const FREEZING_MODE = "abandon-freezing-candidate-v1";
const FAILED_FROZEN_MODE = "abandon-failed-frozen-candidate-v1";
const reviewedOriginNames = [
  "reviewed-origin-main", "reviewed-origin-parent", "reviewed-origin-tree",
  "reviewed-origin-diff-sha256", "reviewed-origin-diff-hash-object", "reviewed-origin-patch-id",
  "release-tracking-origin-main", "origin-url-sha256",
];
const missingProvenanceNames = [
  "preflight-request-id", "preflight-arguments-file", "expected-preflight-arguments-hash",
  "expected-preflight-result-sha256", "expected-preflight-stream", "expected-preflight-provider",
  "expected-preflight-thread", "expected-adoption-task", "expected-adoption-ref", "expected-adoption-blob",
];

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
    if (["confirm-recovery", "expected-publication-checkpoint-absent"].includes(name)) {
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
  const reviewedOriginValues = reviewedOriginNames
    .map((name) => String(values[`expected-${name}`] ?? "").trim());
  if (recoveryMode !== FAILED_FROZEN_MODE && reviewedOriginValues.some(Boolean)) {
    throw new Error("reviewed origin advance applies only to failed-frozen recovery");
  }
  if (recoveryMode === FAILED_FROZEN_MODE) {
    parsed.expected.publicationRunId = required(values, "expected-publication-run-id");
    parsed.expected.publicationRunSha256 = required(values, "expected-publication-run-sha256").toLowerCase();
    const checkpointSha256 = String(values["expected-publication-checkpoint-sha256"] ?? "").trim().toLowerCase();
    const checkpointAbsent = values["expected-publication-checkpoint-absent"] === true;
    if (Boolean(checkpointSha256) === checkpointAbsent) {
      throw new Error("failed-frozen recovery requires exactly one checkpoint digest or explicit absence");
    }
    if (checkpointSha256) parsed.expected.publicationCheckpointSha256 = checkpointSha256;
    if (checkpointAbsent) parsed.expected.publicationCheckpointAbsent = true;
    parsed.expected.publicationLogSha256 = required(values, "expected-publication-log-sha256").toLowerCase();
    if (reviewedOriginValues.some(Boolean)) {
      if (!reviewedOriginValues.every(Boolean)) {
        throw new Error("failed-frozen recovery reviewed origin advance identity is incomplete");
      }
      const [reviewedOriginMain, reviewedOriginParent, reviewedOriginTree, reviewedOriginDiffSha256,
        reviewedOriginDiffHashObject, reviewedOriginPatchId, releaseTrackingOriginMain,
        originUrlSha256] = reviewedOriginValues;
      Object.assign(parsed.expected, {
        reviewedOriginMain: reviewedOriginMain.toLowerCase(),
        reviewedOriginParent: reviewedOriginParent.toLowerCase(),
        reviewedOriginTree: reviewedOriginTree.toLowerCase(),
        reviewedOriginDiffSha256: reviewedOriginDiffSha256.toLowerCase(),
        reviewedOriginDiffHashObject: reviewedOriginDiffHashObject.toLowerCase(),
        reviewedOriginPatchId: reviewedOriginPatchId.toLowerCase(),
        releaseTrackingOriginMain: releaseTrackingOriginMain.toLowerCase(),
        originUrlSha256: originUrlSha256.toLowerCase(),
      });
    }
  }
  const missingProvenanceKind = String(values["missing-provenance-recovery"] ?? "").trim();
  const missingProvenanceValues = missingProvenanceNames.map((name) => String(values[name] ?? "").trim());
  if (missingProvenanceKind || missingProvenanceValues.some(Boolean)) {
    if (recoveryMode !== FAILED_FROZEN_MODE) {
      throw new Error("missing-provenance recovery applies only to failed-frozen recovery");
    }
    if (missingProvenanceKind !== MISSING_PROVENANCE_RECOVERY_KIND || !missingProvenanceValues.every(Boolean)) {
      throw new Error("missing-provenance recovery identity is incomplete");
    }
    const [preflightRequestId, argumentsFile, argumentsHash, resultSha256, stream, provider, thread,
      adoptionTask, adoptionRef, adoptionBlob] = missingProvenanceValues;
    parsed.missingProvenanceRecovery = {
      kind: missingProvenanceKind,
      preflightRequestId,
      preflightArgumentsFile: path.resolve(argumentsFile),
      expectedArgumentsHash: argumentsHash.toLowerCase(),
      expectedResultSha256: resultSha256.toLowerCase(),
      expectedCaller: { streamId: stream, provider, threadId: thread },
      expectedAdoption: { taskId: adoptionTask, recordRef: adoptionRef, recordHash: adoptionBlob.toLowerCase() },
    };
    if (!digestPattern.test(parsed.missingProvenanceRecovery.expectedArgumentsHash)
        || !digestPattern.test(parsed.missingProvenanceRecovery.expectedResultSha256)
        || !commitPattern.test(parsed.missingProvenanceRecovery.expectedAdoption.recordHash)) {
      throw new Error("invalid exact missing-provenance recovery identity");
    }
  }
  for (const [name, value] of Object.entries(parsed.expected)) {
    if (["publicationRunId", "publicationCheckpointAbsent"].includes(name)) continue;
    const pattern = ["planRevision", "manifestHash", "publicationRunSha256", "publicationCheckpointSha256",
      "publicationLogSha256", "reviewedOriginDiffSha256", "originUrlSha256"].includes(name)
      ? digestPattern : commitPattern;
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

// Exact original arguments are hash input only: the owner accepts them solely
// when they reproduce the durable receipt's own argumentsHash.
export async function readMissingProvenanceRequest(request, { read = readFile } = {}) {
  if (!request) return null;
  const { preflightArgumentsFile, ...rest } = request;
  let preflightArguments;
  try {
    preflightArguments = JSON.parse((await read(preflightArgumentsFile)).toString("utf8"));
  } catch (error) {
    throw new Error(`missing-provenance recovery cannot read exact preflight arguments: ${error.message}`);
  }
  return { ...rest, preflightArguments };
}

export async function createReleaseMissingProvenanceResolver(config) {
  const workspaceCatalog = await new WorkspaceCatalogStore({
    databaseFile: path.join(config.dataDir, "journal.sqlite"), readOnly: true,
  }).load();
  return {
    resolver: createMissingProvenanceResolver({
      workspaceCatalog,
      taskGitWorkspaces: new TaskGitWorkspaceService({ dataDir: config.dataDir }),
    }),
    close: () => workspaceCatalog.close(),
  };
}

export async function executeReleaseFreezeRecovery(input, {
  inspectSource = inspectReleaseFreezeRecoverySource,
  load = loadConfig,
  createService = (config) => new ReleaseGitWorkspaceService({ dataDir: config.dataDir }),
  createResolver = createReleaseMissingProvenanceResolver,
  read = readFile,
} = {}) {
  const source = await inspectSource(input);
  const config = await load();
  const { missingProvenanceRecovery: requested, ...recovery } = input;
  const missingProvenanceRecovery = await readMissingProvenanceRequest(requested, { read });
  const owned = missingProvenanceRecovery ? await createResolver(config) : null;
  try {
    const result = await createService(config).recoverFreezingPublicationCandidate({
      ...recovery,
      sourceIdentity: { commit: source.head, ownerSha256: source.ownerSha256 },
      ...(owned ? { missingProvenanceRecovery, missingProvenanceResolver: owned.resolver } : {}),
    });
    return { source, result };
  } finally {
    owned?.close?.();
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(moduleFile)) {
  executeReleaseFreezeRecovery(parseReleaseFreezeRecoveryArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
