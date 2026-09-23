import { createHash } from "node:crypto";

export const MAX_RELEASE_METADATA_BYTES = 8 * 1024 * 1024;

export const RELEASE_OPERATION_STATES = Object.freeze({
  COMPOSE: "compose",
  VALIDATE: "validate",
  PUBLISH: "publish",
  FINALIZE: "finalize",
  WAITING: "waiting",
  DONE: "done",
  FAILED: "failed",
});

export const RELEASE_OPERATION_STEPS = Object.freeze([
  RELEASE_OPERATION_STATES.COMPOSE,
  RELEASE_OPERATION_STATES.VALIDATE,
  RELEASE_OPERATION_STATES.PUBLISH,
  RELEASE_OPERATION_STATES.FINALIZE,
]);

const TERMINAL_STATES = new Set([
  RELEASE_OPERATION_STATES.DONE,
  RELEASE_OPERATION_STATES.FAILED,
]);
const STATE_TRANSITIONS = new Map([
  [RELEASE_OPERATION_STATES.COMPOSE, new Set(["validate", "waiting", "failed"])],
  [RELEASE_OPERATION_STATES.VALIDATE, new Set(["compose", "publish", "waiting", "failed"])],
  [RELEASE_OPERATION_STATES.PUBLISH, new Set(["compose", "finalize", "waiting", "failed"])],
  [RELEASE_OPERATION_STATES.FINALIZE, new Set(["done", "waiting", "failed"])],
  [RELEASE_OPERATION_STATES.WAITING, new Set(["compose", "validate", "publish", "finalize", "failed"])],
]);

function requiredText(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function optionalText(value) {
  return String(value ?? "").trim() || null;
}

function timestamp(value, fallback = new Date().toISOString()) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
  return value;
}

export function releaseIdentitySha256(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function uniqueTextList(value, name) {
  const values = [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item ?? "").trim()).filter(Boolean))].sort();
  if (!values.length) throw new TypeError(`${name} requires at least one value`);
  return values;
}

function normalizedTargets(value) {
  const targets = (Array.isArray(value) ? value : []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("approved target must be an object");
    }
    return {
      targetId: requiredText(entry.targetId ?? entry.id, "approved target id"),
      kind: requiredText(entry.kind, "approved target kind"),
      ...(optionalText(entry.repositoryRoot) ? { repositoryRoot: optionalText(entry.repositoryRoot) } : {}),
      ...(optionalText(entry.environment) ? { environment: optionalText(entry.environment) } : {}),
      ...(optionalText(entry.approvedLocalMainCommit)
        ? { approvedLocalMainCommit: optionalText(entry.approvedLocalMainCommit) } : {}),
      ...(optionalText(entry.approvedOriginMainCommit)
        ? { approvedOriginMainCommit: optionalText(entry.approvedOriginMainCommit) } : {}),
    };
  }).sort((left, right) => left.targetId.localeCompare(right.targetId));
  if (!targets.length) throw new TypeError("approvedTargets requires at least one target");
  if (new Set(targets.map((entry) => entry.targetId)).size !== targets.length) {
    throw new TypeError("approved target ids must be unique");
  }
  return targets;
}

function normalizedReleaseMetadata(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("releaseMetadata must be an object");
  const sourcePath = requiredText(value.sourcePath, "release metadata source path");
  const byteLength = Number(value.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_RELEASE_METADATA_BYTES) {
    throw new TypeError("release metadata size is invalid or too large");
  }
  const rawSha256 = requiredText(value.rawSha256, "release metadata raw digest");
  const canonicalSha256 = requiredText(value.canonicalSha256, "release metadata canonical digest");
  if (!/^[a-f0-9]{64}$/u.test(rawSha256) || !/^[a-f0-9]{64}$/u.test(canonicalSha256)) {
    throw new TypeError("release metadata digest is invalid");
  }
  return { sourcePath, byteLength, rawSha256, canonicalSha256 };
}

function normalizedAuthorization(value = {}) {
  const authorization = {
    taskIds: uniqueTextList(value.taskIds, "authorization taskIds"),
    approvedTargets: normalizedTargets(value.approvedTargets),
    validationMode: requiredText(value.validationMode, "validationMode"),
    ...(value.releaseMetadata ? { releaseMetadata: normalizedReleaseMetadata(value.releaseMetadata) } : {}),
  };
  return { ...authorization, fingerprint: releaseIdentitySha256(authorization) };
}

function normalizedResults(value) {
  return (Array.isArray(value) ? value : []).map((entry) => ({
    taskId: requiredText(entry?.taskId, "selected result taskId"),
    resultCommit: requiredText(entry?.resultCommit, "selected result commit"),
    ...(optionalText(entry?.tree) ? { tree: optionalText(entry.tree) } : {}),
    acceptanceRevision: Number.isSafeInteger(Number(entry?.acceptanceRevision))
      ? Number(entry.acceptanceRevision)
      : null,
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function normalizedEffects(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return structuredClone(value);
}

function normalizedWaitReason(value) {
  if (value == null) return null;
  if (typeof value === "string") return { code: requiredText(value, "wait reason") };
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("waitReason must be an object");
  return {
    code: requiredText(value.code, "wait reason code"),
    ...(optionalText(value.message) ? { message: optionalText(value.message) } : {}),
    ...(value.details && typeof value.details === "object" && !Array.isArray(value.details)
      ? { details: structuredClone(value.details) } : {}),
    ...(value.retryAt ? { retryAt: timestamp(value.retryAt) } : {}),
  };
}

function normalizedError(value) {
  if (value == null) return null;
  if (typeof value === "string") return { message: value };
  if (typeof value !== "object" || Array.isArray(value)) return { message: String(value) };
  return {
    message: requiredText(value.message ?? value.error ?? "release operation failed", "error message"),
    ...(optionalText(value.code) ? { code: optionalText(value.code) } : {}),
    ...(optionalText(value.step) ? { step: optionalText(value.step) } : {}),
  };
}

function normalizedOwner(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("owner must be an object");
  return {
    ownerId: requiredText(value.ownerId, "owner id"),
    epoch: Number.isSafeInteger(Number(value.epoch)) && Number(value.epoch) > 0 ? Number(value.epoch) : 1,
    processId: Number.isSafeInteger(Number(value.processId)) && Number(value.processId) > 0
      ? Number(value.processId) : null,
    heartbeatAt: timestamp(value.heartbeatAt),
    leaseExpiresAt: timestamp(value.leaseExpiresAt),
  };
}

export function releaseOperationIsTerminal(operation) {
  return TERMINAL_STATES.has(String(operation?.state ?? ""));
}

export function createReleaseOperation({
  operationId,
  requestId,
  workspaceId,
  streamId,
  threadId,
  authorization,
  runnerVersion,
  createdAt,
  updatedAt = createdAt,
  state = RELEASE_OPERATION_STATES.COMPOSE,
  currentGeneration = 0,
  currentStep = RELEASE_OPERATION_STATES.COMPOSE,
  attempt = 0,
  resumeState = null,
  waitReason = null,
  selectedResults = [],
  publicationEffects = {},
  owner = null,
  nextAction = "compose authorized candidate",
  lastError = null,
  migration = null,
} = {}) {
  const normalizedState = requiredText(state, "release operation state");
  if (!Object.values(RELEASE_OPERATION_STATES).includes(normalizedState)) {
    throw new TypeError(`unsupported release operation state: ${normalizedState}`);
  }
  const created = timestamp(createdAt);
  const operation = {
    entityType: "release-operation",
    schemaVersion: 1,
    operationId: requiredText(operationId, "operationId"),
    requestId: requiredText(requestId, "requestId"),
    workspaceId: requiredText(workspaceId, "workspaceId"),
    streamId: requiredText(streamId, "streamId"),
    threadId: requiredText(threadId, "threadId"),
    authorization: normalizedAuthorization(authorization),
    runnerVersion: requiredText(runnerVersion, "runnerVersion"),
    state: normalizedState,
    currentGeneration: Math.max(0, Number(currentGeneration) || 0),
    currentStep: optionalText(currentStep),
    attempt: Math.max(0, Number(attempt) || 0),
    resumeState: optionalText(resumeState),
    waitReason: normalizedWaitReason(waitReason),
    selectedResults: normalizedResults(selectedResults),
    publicationEffects: normalizedEffects(publicationEffects),
    owner: normalizedOwner(owner),
    nextAction: optionalText(nextAction),
    lastError: normalizedError(lastError),
    revision: 1,
    createdAt: created,
    updatedAt: timestamp(updatedAt, created),
    completedAt: null,
    ...(migration && typeof migration === "object" && !Array.isArray(migration)
      ? { migration: structuredClone(migration) } : {}),
  };
  if (releaseOperationIsTerminal(operation)) operation.completedAt = operation.updatedAt;
  return operation;
}

export function restoreReleaseOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const operation = createReleaseOperation(value);
    const revision = Number(value.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    operation.revision = revision;
    operation.completedAt = releaseOperationIsTerminal(operation)
      ? timestamp(value.completedAt, operation.updatedAt)
      : null;
    return operation;
  } catch {
    return null;
  }
}

export function transitionReleaseOperation(current, patch = {}, {
  expectedRevision = current?.revision,
  updatedAt = new Date().toISOString(),
} = {}) {
  const operation = restoreReleaseOperation(current);
  if (!operation) throw new TypeError("valid current release operation is required");
  if (expectedRevision !== operation.revision) return { operation, applied: false, reason: "stale-revision" };
  if (releaseOperationIsTerminal(operation)) return { operation, applied: false, reason: "terminal" };
  for (const name of ["operationId", "requestId", "workspaceId", "streamId", "threadId", "authorization", "runnerVersion"]) {
    if (patch[name] !== undefined && releaseIdentitySha256(patch[name]) !== releaseIdentitySha256(operation[name])) {
      throw new Error(`${name} is immutable`);
    }
  }
  const state = requiredText(patch.state ?? operation.state, "release operation state");
  if (!Object.values(RELEASE_OPERATION_STATES).includes(state)) throw new TypeError(`unsupported release operation state: ${state}`);
  if (state !== operation.state && !STATE_TRANSITIONS.get(operation.state)?.has(state)) {
    return { operation, applied: false, reason: "invalid-transition" };
  }
  const next = {
    ...operation,
    state,
    currentGeneration: patch.currentGeneration === undefined
      ? operation.currentGeneration : Math.max(0, Number(patch.currentGeneration) || 0),
    currentStep: patch.currentStep === undefined ? operation.currentStep : optionalText(patch.currentStep),
    attempt: patch.attempt === undefined ? operation.attempt : Math.max(0, Number(patch.attempt) || 0),
    resumeState: patch.resumeState === undefined ? operation.resumeState : optionalText(patch.resumeState),
    waitReason: patch.waitReason === undefined ? operation.waitReason : normalizedWaitReason(patch.waitReason),
    selectedResults: patch.selectedResults === undefined ? operation.selectedResults : normalizedResults(patch.selectedResults),
    publicationEffects: patch.publicationEffects === undefined
      ? operation.publicationEffects : normalizedEffects(patch.publicationEffects),
    owner: patch.owner === undefined ? operation.owner : normalizedOwner(patch.owner),
    nextAction: patch.nextAction === undefined ? operation.nextAction : optionalText(patch.nextAction),
    lastError: patch.lastError === undefined ? operation.lastError : normalizedError(patch.lastError),
    revision: operation.revision + 1,
    updatedAt: timestamp(updatedAt),
  };
  if (state !== RELEASE_OPERATION_STATES.WAITING) {
    next.resumeState = null;
    next.waitReason = null;
  }
  if (releaseOperationIsTerminal(next)) {
    next.owner = null;
    next.currentStep = null;
    next.nextAction = null;
    next.completedAt = next.updatedAt;
  }
  return { operation: next, applied: true, reason: null };
}

function normalizedRepositoryBase(value) {
  return {
    repositoryRoot: requiredText(value?.repositoryRoot, "repository base root"),
    baseCommit: requiredText(value?.baseCommit, "repository base commit"),
  };
}

function normalizedCandidate(value) {
  return {
    repositoryRoot: requiredText(value?.repositoryRoot, "candidate repository root"),
    releaseRoot: requiredText(value?.releaseRoot, "candidate release root"),
    commit: requiredText(value?.commit ?? value?.preReleaseHead, "candidate commit"),
    tree: requiredText(value?.tree, "candidate tree"),
    manifestHash: requiredText(value?.manifestHash, "candidate manifest hash"),
    ...(optionalText(value?.generationRoot) ? { generationRoot: optionalText(value.generationRoot) } : {}),
    ...(optionalText(value?.planRevision) ? { planRevision: optionalText(value.planRevision) } : {}),
    ...(optionalText(value?.baseCommit) ? { baseCommit: optionalText(value.baseCommit) } : {}),
    ...(Array.isArray(value?.frozenTasks) ? { frozenTasks: structuredClone(value.frozenTasks) } : {}),
    ...(value?.manifest && typeof value.manifest === "object" && !Array.isArray(value.manifest)
      ? { manifest: structuredClone(value.manifest) } : {}),
  };
}

export function createCandidateGeneration({
  operationId,
  generation,
  supersedesGeneration = null,
  repositoryBases,
  selectedResults,
  candidates,
  runnerVersion,
  createdAt,
  sourceFingerprint = null,
} = {}) {
  const value = {
    entityType: "release-candidate-generation",
    schemaVersion: 1,
    operationId: requiredText(operationId, "operationId"),
    generation: Number(generation),
    supersedesGeneration: supersedesGeneration == null ? null : Number(supersedesGeneration),
    repositoryBases: (Array.isArray(repositoryBases) ? repositoryBases : []).map(normalizedRepositoryBase)
      .sort((left, right) => left.repositoryRoot.localeCompare(right.repositoryRoot)),
    selectedResults: normalizedResults(selectedResults),
    candidates: (Array.isArray(candidates) ? candidates : []).map(normalizedCandidate)
      .sort((left, right) => left.repositoryRoot.localeCompare(right.repositoryRoot)),
    runnerVersion: requiredText(runnerVersion, "runnerVersion"),
    createdAt: timestamp(createdAt),
    sourceFingerprint: optionalText(sourceFingerprint),
  };
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new TypeError("generation must be positive");
  if (!value.repositoryBases.length || !value.selectedResults.length || !value.candidates.length) {
    throw new TypeError("candidate generation requires bases, results and candidates");
  }
  value.identitySha256 = releaseIdentitySha256(value);
  return value;
}
