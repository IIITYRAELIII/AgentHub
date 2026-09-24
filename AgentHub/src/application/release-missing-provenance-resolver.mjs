import path from "node:path";

import { mcpArgumentsHash } from "../domain/mcp-arguments-hash.mjs";

// Supplemental authority for one legacy failed-frozen candidate whose
// immutable manifest and checkpoint lack base provenance. It never repairs
// that candidate. It re-reads the original terminal hub_release_preflight
// receipt bytes and the historical immutable selected Task upstream adoption
// from their owners and derives the approved published/local/origin/base tuple
// from them alone. The adoption proof is historical: it is not current
// admission or publication readiness.
export const MISSING_PROVENANCE_RECOVERY_KIND = "missing-provenance-recovery-v1";
export const SUPPLEMENTAL_PROVENANCE_KIND = "supplemental-reviewed-adoption-v1";
export const HISTORICAL_ADOPTION_VALIDATION = "historical-immutable-v1";

const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PREFLIGHT_TOOL = "hub_release_preflight";
const PREFLIGHT_ARGUMENT_KEYS = new Set([
  "request_id", "workspace_id", "expected_plan_revision", "conflicts_resolved", "approved_repositories",
]);
const APPROVAL_KEYS = new Set(["projectRoot", "approvedLocalMainCommit", "approvedOriginMainCommit"]);

function reject(message) {
  const error = new Error(`missing-provenance recovery rejected: ${message}`);
  error.code = "RELEASE_MISSING_PROVENANCE_REJECTED";
  return error;
}

function text(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalRoot(value) {
  const resolved = path.resolve(text(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sortedTasks(tasks = []) {
  return tasks.map((task) => ({
    taskId: text(task?.taskId),
    taskRevision: Number(task?.taskRevision),
    resultCommit: text(task?.resultCommit),
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function sameTasks(left, right) {
  return JSON.stringify(sortedTasks(left)) === JSON.stringify(sortedTasks(right));
}

export function normalizedMissingProvenanceRequest(value) {
  if (!plainObject(value)) throw reject("request is missing");
  const request = {
    kind: text(value.kind),
    preflightRequestId: text(value.preflightRequestId),
    preflightArguments: value.preflightArguments,
    expectedArgumentsHash: text(value.expectedArgumentsHash).toLowerCase(),
    expectedResultSha256: text(value.expectedResultSha256).toLowerCase(),
    expectedCaller: {
      streamId: text(value.expectedCaller?.streamId),
      provider: text(value.expectedCaller?.provider),
      threadId: text(value.expectedCaller?.threadId),
    },
    expectedAdoption: {
      taskId: text(value.expectedAdoption?.taskId),
      recordRef: text(value.expectedAdoption?.recordRef),
      recordHash: text(value.expectedAdoption?.recordHash).toLowerCase(),
    },
  };
  if (request.kind !== MISSING_PROVENANCE_RECOVERY_KIND) throw reject("unsupported supplemental kind");
  if (!request.preflightRequestId) throw reject("original preflight request ID is required");
  if (!plainObject(request.preflightArguments)) throw reject("exact original preflight arguments are required");
  if (!DIGEST.test(request.expectedArgumentsHash) || !DIGEST.test(request.expectedResultSha256)) {
    throw reject("exact receipt argument and result digests are required");
  }
  if (!request.expectedCaller.streamId || !request.expectedCaller.provider || !request.expectedCaller.threadId) {
    throw reject("exact original preflight caller is required");
  }
  if (!request.expectedAdoption.taskId || !request.expectedAdoption.recordRef
      || !COMMIT.test(request.expectedAdoption.recordHash)) {
    throw reject("exact selected Task adoption ref and blob are required");
  }
  return request;
}

function exactArguments(request, candidate) {
  const args = request.preflightArguments;
  for (const key of Object.keys(args)) {
    if (!PREFLIGHT_ARGUMENT_KEYS.has(key)) throw reject(`original preflight arguments contain unsupported ${key}`);
  }
  if (args.request_id != null && args.request_id !== request.preflightRequestId) {
    throw reject("original preflight arguments request_id does not match the receipt");
  }
  if (args.workspace_id != null && args.workspace_id !== candidate.workspaceId) {
    throw reject("original preflight arguments target another Workspace");
  }
  if (args.expected_plan_revision !== candidate.planRevision) {
    throw reject("original preflight arguments plan revision does not match the candidate");
  }
  if (args.conflicts_resolved !== true) throw reject("original preflight did not resolve conflicts");
  const approvals = Array.isArray(args.approved_repositories) ? args.approved_repositories : [];
  if (approvals.length !== 1 || !plainObject(approvals[0])
      || Object.keys(approvals[0]).some((key) => !APPROVAL_KEYS.has(key))) {
    throw reject("original preflight must carry exactly one repository-scoped approval");
  }
  const approval = approvals[0];
  if (canonicalRoot(approval.projectRoot) !== canonicalRoot(candidate.projectRoot)
      || !COMMIT.test(text(approval.approvedLocalMainCommit))
      || approval.approvedOriginMainCommit !== candidate.baseCommit) {
    throw reject("original preflight approval does not bind this repository and candidate base");
  }
  const argumentsHash = mcpArgumentsHash({ ...args, request_id: request.preflightRequestId });
  if (argumentsHash !== request.expectedArgumentsHash) {
    throw reject("original preflight arguments do not reproduce the expected receipt hash");
  }
  return { argumentsHash, approvedLocalMainCommit: approval.approvedLocalMainCommit };
}

function exactReceipt(receipt, request, candidate, argumentsHash) {
  if (!receipt) throw reject("original preflight receipt was not found");
  const caller = request.expectedCaller;
  if (receipt.requestId !== request.preflightRequestId || receipt.toolName !== PREFLIGHT_TOOL
      || receipt.workspaceId !== candidate.workspaceId) {
    throw reject("original receipt is not this Workspace release preflight");
  }
  if (receipt.streamId !== caller.streamId || receipt.provider !== caller.provider
      || receipt.threadId !== caller.threadId) {
    throw reject("original preflight receipt belongs to another caller");
  }
  if (receipt.status !== "succeeded" || receipt.operationStatus !== "succeeded"
      || receipt.receiptState !== "succeeded" || receipt.error !== ""
      || !Number.isSafeInteger(receipt.createdAtMs) || !Number.isSafeInteger(receipt.completedAtMs)) {
    throw reject("original preflight receipt is not an exact terminal success");
  }
  if (receipt.argumentsHash !== argumentsHash) {
    throw reject("original preflight receipt arguments do not match");
  }
  // The digest covers the exact persisted result_json bytes, never a caller
  // or parser reconstruction; a parse failure or compaction has no result.
  const result = receipt.result;
  if (typeof receipt.resultJson !== "string" || !DIGEST.test(String(receipt.resultJsonSha256 ?? ""))
      || !plainObject(result) || result.receiptCompacted === true
      || Object.hasOwn(result, "operatorReconciliation")) {
    throw reject("original preflight receipt has no full original result");
  }
  if (receipt.resultJsonSha256 !== request.expectedResultSha256) {
    throw reject("original preflight result digest changed");
  }
  return { result, resultJson: receipt.resultJson, resultSha256: receipt.resultJsonSha256 };
}

function exactReadyResult(result, candidate, approvedLocalMainCommit) {
  const taskIds = candidate.frozenTasks.map((task) => task.taskId).sort();
  if (result.status !== "ready" || result.workspaceId !== candidate.workspaceId
      || result.planRevision !== candidate.planRevision || result.conflictsResolved !== true
      || JSON.stringify(result.taskIds) !== JSON.stringify(taskIds)) {
    throw reject("original preflight result is not ready for this exact plan and Task set");
  }
  const audits = Array.isArray(result.mainAudits) ? result.mainAudits : [];
  const candidates = Array.isArray(result.releaseCandidates) ? result.releaseCandidates : [];
  const repositories = Array.isArray(result.repositories) ? result.repositories : [];
  if (audits.length !== 1 || candidates.length !== 1 || repositories.length !== 1) {
    throw reject("original preflight result must describe exactly this one repository");
  }
  const [audit] = audits;
  if (canonicalRoot(audit.projectRoot) !== canonicalRoot(candidate.projectRoot)
      || audit.publishedRevision !== candidate.publishedBaseCommit
      || audit.localMain !== approvedLocalMainCommit
      || audit.originMain !== candidate.baseCommit
      || audit.approved !== true || audit.approvalRequired !== false) {
    throw reject("original preflight main audit does not approve this published/local/origin tuple");
  }
  const [prepared] = candidates;
  const manifest = prepared?.manifest;
  if (canonicalRoot(prepared?.repositoryRoot) !== canonicalRoot(candidate.projectRoot)
      || prepared.checkpointPhase !== "prepared"
      || prepared.planRevision !== candidate.planRevision
      || prepared.preReleaseHead !== candidate.preparedHead
      || prepared.tree !== candidate.preparedTree
      || prepared.manifestHash !== candidate.preparedManifestHash
      || prepared.baseCommit !== candidate.baseCommit
      || text(prepared.preflightRequestId)
      || !plainObject(manifest)
      || manifest.manifestHash !== candidate.preparedManifestHash
      || manifest.planRevision !== candidate.planRevision
      || manifest.workspaceId !== candidate.workspaceId
      || manifest.baseCommit !== candidate.baseCommit
      || text(manifest.preflightRequestId)
      || Object.hasOwn(manifest, "baseProvenance")
      || !sameTasks(manifest.tasks, candidate.frozenTasks)) {
    throw reject("original preflight audited another prepared candidate");
  }
  const [repository] = repositories;
  if (canonicalRoot(repository?.projectRoot) !== canonicalRoot(candidate.projectRoot)
      || repository.headCommit !== candidate.preparedHead
      || repository.frozenCandidate?.preReleaseHead !== candidate.preparedHead
      || repository.frozenCandidate?.manifestHash !== candidate.preparedManifestHash) {
    throw reject("original preflight repository evidence does not match the prepared candidate");
  }
}

async function exactAdoption(taskGitWorkspaces, request, candidate, approvedLocalMainCommit) {
  const historical = await taskGitWorkspaces.historicalUpstreamAdoptionEvidence({
    projectRoot: candidate.projectRoot,
    publishedBaseCommit: candidate.publishedBaseCommit,
    tasks: candidate.frozenTasks.map((task) => ({ taskId: task.taskId, resultCommit: task.resultCommit })),
    expected: request.expectedAdoption,
    recoveryKind: MISSING_PROVENANCE_RECOVERY_KIND,
  }).catch((error) => {
    throw reject(`historical selected Task adoption is not exact: ${error.message}`);
  });
  const adoption = historical?.adoption;
  const expected = request.expectedAdoption;
  const task = candidate.frozenTasks.find((item) => item.taskId === adoption?.taskId);
  if (historical?.validation !== HISTORICAL_ADOPTION_VALIDATION
      || historical.publishedBaseCommit !== candidate.publishedBaseCommit
      || historical.adoptedBaseCommit !== candidate.baseCommit) {
    throw reject("historical selected Task adoption does not derive the candidate base");
  }
  if (adoption.taskId !== expected.taskId || adoption.recordRef !== expected.recordRef
      || adoption.recordHash !== expected.recordHash) {
    throw reject("historical selected Task adoption ref or blob changed");
  }
  if (!task || adoption.resultCommit !== task.resultCommit) {
    throw reject("adoption Task result is not an exact frozen member");
  }
  if (adoption.adoptedCommit !== candidate.baseCommit
      || adoption.acceptedLocalMainCommit !== approvedLocalMainCommit) {
    throw reject("adoption does not bind the approved local main and candidate base");
  }
  return { validation: historical.validation, taskRevision: task.taskRevision, ...adoption };
}

export function createMissingProvenanceResolver({ workspaceCatalog, taskGitWorkspaces } = {}) {
  if (typeof workspaceCatalog?.mcpOperationResultEvidence !== "function") {
    throw new TypeError("workspaceCatalog.mcpOperationResultEvidence is required");
  }
  if (typeof taskGitWorkspaces?.historicalUpstreamAdoptionEvidence !== "function") {
    throw new TypeError("taskGitWorkspaces.historicalUpstreamAdoptionEvidence is required");
  }
  return async function resolveMissingProvenance({ request: rawRequest, candidate }) {
    const request = normalizedMissingProvenanceRequest(rawRequest);
    const { argumentsHash, approvedLocalMainCommit } = exactArguments(request, candidate);
    const receipt = workspaceCatalog.mcpOperationResultEvidence(request.preflightRequestId);
    const { result, resultJson, resultSha256 } = exactReceipt(receipt, request, candidate, argumentsHash);
    exactReadyResult(result, candidate, approvedLocalMainCommit);
    const adoption = await exactAdoption(taskGitWorkspaces, request, candidate, approvedLocalMainCommit);
    return {
      authority: {
        schemaVersion: 1,
        kind: SUPPLEMENTAL_PROVENANCE_KIND,
        recoveryKind: request.kind,
        receipt: {
          requestId: receipt.requestId,
          workspaceId: receipt.workspaceId,
          streamId: receipt.streamId,
          provider: receipt.provider,
          threadId: receipt.threadId,
          toolName: receipt.toolName,
          argumentsHash: receipt.argumentsHash,
          status: receipt.status,
          createdAtMs: receipt.createdAtMs,
          completedAtMs: receipt.completedAtMs,
          resultSha256,
        },
        adoption,
        derived: {
          publishedBaseCommit: candidate.publishedBaseCommit,
          approvedLocalMainCommit,
          approvedOriginMainCommit: candidate.baseCommit,
          baseCommit: candidate.baseCommit,
        },
        candidate: {
          planRevision: candidate.planRevision,
          preparedHead: candidate.preparedHead,
          preparedTree: candidate.preparedTree,
          preparedManifestHash: candidate.preparedManifestHash,
          taskIds: candidate.frozenTasks.map((task) => task.taskId).sort(),
        },
      },
      receiptResultJson: resultJson,
    };
  };
}
