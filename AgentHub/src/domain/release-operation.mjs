import { normalizeTestSelection, verifyTestPlan } from "./test-selection.mjs";
import { createHash } from "node:crypto";
import path from "node:path";
import { selectedCompositionFields } from "./task-selected-composition.mjs";
import { normalizedNativeResolution } from "./native-resolution-input.mjs";
import { semanticVersion } from "./agent-hub-version.mjs";


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

export function releaseSelectionSha256(results) {
  return releaseIdentitySha256(normalizedResults(results).map(({ tree, ...result }) => result));
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
      ...(entry.nativeResolutionReview != null
        ? { nativeResolutionReview: normalizedNativeResolution(entry.nativeResolutionReview) } : {}),
    };
  }).sort((left, right) => left.targetId.localeCompare(right.targetId));
  if (!targets.length) throw new TypeError("approvedTargets requires at least one target");
  if (new Set(targets.map((entry) => entry.targetId)).size !== targets.length) {
    throw new TypeError("approved target ids must be unique");
  }
  return targets;
}

export function normalizeReleaseVersion(value) {
  const version = semanticVersion(value);
  if (version.prerelease.length || version.metadata) throw new TypeError("Release version must be a complete X.Y.Z public version");
  return value;
}

export function normalizedReleaseMetadata(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("releaseMetadata must be an object");
  const sourcePath = requiredText(value.sourcePath, "release metadata source path");
  const byteLength = Number(value.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
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
    ...(value.testSelection != null ? { testSelection: normalizeTestSelection(value.testSelection) } : {}),
    ...(value.releaseMetadata ? { releaseMetadata: normalizedReleaseMetadata(value.releaseMetadata) } : {}),
    ...(value.releaseVersion !== undefined ? { releaseVersion: normalizeReleaseVersion(value.releaseVersion) } : {}),
  };
  return { ...authorization, fingerprint: releaseIdentitySha256(authorization) };
}

function normalizedResults(value) {
  return (Array.isArray(value) ? value : []).map((entry) => ({
    taskId: requiredText(entry?.taskId, "selected result taskId"),
    resultCommit: requiredText(entry?.resultCommit, "selected result commit"),
    ...selectedCompositionFields(entry),
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

const repositoryKey = value => {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export function reviewedMainBinding(operation, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
      || !Array.isArray(value.approvedRepositories) || !value.approvedRepositories.length) throw new TypeError("Invalid reviewed-main binding");
  const roots = new Set(operation.authorization.approvedTargets.map(target => {
    if (target.kind !== "agent-hub-publication" || !target.repositoryRoot) {
      throw new Error("Reviewed-main binding requires original repository publication targets");
    }
    return repositoryKey(target.repositoryRoot);
  }));
  const seen = new Set();
  const approvedRepositories = value.approvedRepositories.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof entry.projectRoot !== "string" || !entry.projectRoot.trim()) {
      throw new TypeError("Reviewed-main repository must be a primitive string");
    }
    const key = repositoryKey(entry.projectRoot);
    if (!roots.has(key) || seen.has(key)) throw new Error("Reviewed-main repository binding is foreign or duplicated");
    seen.add(key);
    for (const field of ["approvedLocalMainCommit", "approvedOriginMainCommit"]) {
      if (typeof entry[field] !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(entry[field])) {
        throw new TypeError("Reviewed-main commit must be a primitive exact Git commit string");
      }
    }
    return { projectRoot: entry.projectRoot, approvedLocalMainCommit: entry.approvedLocalMainCommit,
      approvedOriginMainCommit: entry.approvedOriginMainCommit };
  }).sort((a, b) => repositoryKey(a.projectRoot).localeCompare(repositoryKey(b.projectRoot)));
  if (seen.size !== roots.size) throw new Error("Reviewed-main binding must cover every original repository");
  return { expectedRevision: value.expectedRevision, approvedRepositories };
}

export function failedComposeRecoveryEligible(operation) {
  return operation?.state === "failed" && operation.owner == null
    && operation.currentGeneration > 0 && operation.lastError?.step === "compose";
}

function normalizedReviewedMain(value, operation) {
  if (value == null) return null;
  const { identitySha256, ...contents } = value;
  const binding = reviewedMainBinding(operation, { expectedRevision: value.priorRevision,
    approvedRepositories: value.approvedRepositories });
  if (typeof value.requestId !== "string" || !value.requestId.trim()
      || value.authorizationFingerprint !== operation.authorization.fingerprint
      || releaseIdentitySha256(contents) !== identitySha256
      || releaseIdentitySha256(binding.approvedRepositories) !== releaseIdentitySha256(value.approvedRepositories)
      || !value.priorFailure?.completedAt || !value.planRevision
      || !Number.isSafeInteger(value.priorGeneration) || value.priorGeneration < 1 || value.priorGeneration > operation.currentGeneration
      || !Array.isArray(value.selectedResults) || !Array.isArray(value.preparedCandidates)
      || JSON.stringify(value.selectedResults.map(item => item.taskId).sort())
        !== JSON.stringify(releaseTaskIdsAtBoundary(operation, value.priorRevision, value.priorGeneration))
      || !Array.isArray(value.readbacks) || value.readbacks.length !== operation.authorization.approvedTargets.length
      || operation.authorization.approvedTargets.some(target => value.readbacks.filter(item =>
        item.targetId === target.targetId && item.generation === value.priorGeneration && item.evidence?.status === "not_applied").length !== 1)) {
    throw new Error("Reviewed-main recovery identity changed");
  }
  return structuredClone(value);
}

export function releaseApprovedTargets(operation) {
  return operation.authorization.approvedTargets.map(target => {
    const approval = operation.reviewedMain?.approvedRepositories.find(entry =>
      repositoryKey(entry.projectRoot) === repositoryKey(target.repositoryRoot));
    return approval ? { ...target, approvedLocalMainCommit: approval.approvedLocalMainCommit,
      approvedOriginMainCommit: approval.approvedOriginMainCommit } : target;
  });
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
  reviewedMain = null,
  testSelectionAmendments = [],
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
  if (testSelectionAmendments.length) operation.testSelectionAmendments = testSelectionAmendments.map(item => normalizeTestSelectionAmendment(item, operation));
  if (reviewedMain != null) operation.reviewedMain = normalizedReviewedMain(reviewedMain, operation);
  if (releaseOperationIsTerminal(operation)) operation.completedAt = operation.updatedAt;
  return operation;
}

export function restoreReleaseOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const operation = createReleaseOperation(value);
    if (value.authorization?.fingerprint !== operation.authorization.fingerprint) return null;
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
  reviewedMainRecovery = null,
  testSelectionAmendment = null,
} = {}) {
  const operation = restoreReleaseOperation(current);
  if (!operation) throw new TypeError("valid current release operation is required");
  if (expectedRevision !== operation.revision) return { operation, applied: false, reason: "stale-revision" };
  const recovery = reviewedMainRecovery == null ? null : normalizedReviewedMain(reviewedMainRecovery, operation);
  if (recovery && (!failedComposeRecoveryEligible(operation) || recovery.priorRevision !== operation.revision
      || recovery.priorGeneration !== operation.currentGeneration
      || releaseIdentitySha256(recovery.priorFailure) !== releaseIdentitySha256({ completedAt: operation.completedAt, error: operation.lastError })
      || patch.state !== "compose")) throw new Error("Reviewed-main recovery does not match original failed operation");
  const amendment = testSelectionAmendment == null ? null : normalizeTestSelectionAmendment(testSelectionAmendment, operation);
  if (amendment && (operation.owner || operation.state === "done" || !["waiting", "failed"].includes(operation.state)
      || amendment.priorRevision !== operation.revision || amendment.priorGeneration !== operation.currentGeneration
      || patch.state !== "compose" || releaseIdentitySha256(amendment.priorPublicationEffects) !== releaseIdentitySha256(operation.publicationEffects)
      || releaseIdentitySha256(amendment.priorWaitReason) !== releaseIdentitySha256(operation.waitReason)
      || amendment.priorResumeState !== operation.resumeState || releaseIdentitySha256(amendment.priorFailure) !== releaseIdentitySha256({ state: operation.state, completedAt: operation.completedAt, error: operation.lastError }))) throw new Error("Test selection amendment changed its original boundary");
  if (patch.testSelectionAmendments !== undefined) throw new Error("testSelectionAmendments requires its amendment boundary");
  if (releaseOperationIsTerminal(operation) && !recovery && !amendment) return { operation, applied: false, reason: "terminal" };
  if (patch.reviewedMain !== undefined) throw new Error("reviewedMain requires its recovery boundary");
  for (const name of ["operationId", "requestId", "workspaceId", "streamId", "threadId", "authorization", "runnerVersion"]) {
    if (patch[name] !== undefined && releaseIdentitySha256(patch[name]) !== releaseIdentitySha256(operation[name])) {
      throw new Error(`${name} is immutable`);
    }
  }
  const state = requiredText(patch.state ?? operation.state, "release operation state");
  if (!Object.values(RELEASE_OPERATION_STATES).includes(state)) throw new TypeError(`unsupported release operation state: ${state}`);
  if (state !== operation.state && !recovery && !amendment && !STATE_TRANSITIONS.get(operation.state)?.has(state)) {
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
    ...(recovery ? { reviewedMain: recovery, completedAt: null } : {}),
    ...(amendment ? { testSelectionAmendments: [...(operation.testSelectionAmendments ?? []), amendment], completedAt: null } : {}),
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

// The release owner and retrospective readers share the same completed-generation
// proof. This is read-only evidence, never permission to replay publication.
export function completedReleaseGenerationEvidence({ operation, generation, validation, finalization } = {}) {
  const number = generation?.generation;
  if (operation?.state !== "done" || !operation.completedAt || operation.currentGeneration !== number
      || generation?.operationId !== operation.operationId || generation.candidates?.length > 32) return null;
  const { identitySha256, ...contents } = generation;
  if (releaseIdentitySha256(contents) !== identitySha256) return null;
  const effects = operation.publicationEffects;
  if (effects?.generation !== number || effects.publishStarted?.candidate !== identitySha256
      || !operation.authorization.approvedTargets.every(target =>
        ["applied", "already_applied"].includes(effects.targets?.[target.targetId]?.status))) return null;
  for (const receipt of [validation, finalization]) {
    if (receipt?.status !== "applied" || receipt.operationId !== operation.operationId || receipt.generation !== number
        || receipt.input?.candidate !== identitySha256 || releaseIdentitySha256(receipt.input) !== receipt.inputSha256) return null;
  }
  if (releaseIdentitySha256(finalization.input.effects) !== releaseIdentitySha256(effects)
      || releaseIdentitySha256(finalization.input.selectedResults) !== releaseIdentitySha256(generation.selectedResults)) return null;
  return { operationId: operation.operationId, generation: number, operationRevision: operation.revision,
    completedAt: operation.completedAt, identitySha256,
    candidates: generation.candidates.map(({ repositoryRoot, releaseRoot, generationRoot, commit, tree, manifestHash }) =>
      ({ repositoryRoot, releaseRoot, generationRoot, commit, tree, manifestHash })) };
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
  testPlans = null,
  testSelectionAmendmentId = null,
  authorizedTaskIds = null,
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
    ...(authorizedTaskIds != null ? { authorizedTaskIds: normalizeReleaseTaskIds(authorizedTaskIds) } : {}),
    ...(testPlans != null ? { testPlans: testPlans.map(item => ({ repositoryRoot: requiredText(item.repositoryRoot, "test plan repository"), plan: verifyTestPlan(item.plan) })),
      testSelectionAmendmentId: optionalText(testSelectionAmendmentId) } : {}),
  };
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new TypeError("generation must be positive");
  if (!value.repositoryBases.length || !value.selectedResults.length || !value.candidates.length) {
    throw new TypeError("candidate generation requires bases, results and candidates");
  }
  if (authorizedTaskIds != null && JSON.stringify(value.authorizedTaskIds) !== JSON.stringify([...new Set(value.selectedResults.map(item => item.taskId))].sort())) {
    throw new Error("Generation results differ from explicitly authorized Task membership");
  }
  if (testPlans != null && (testPlans.length !== value.candidates.length
      || value.candidates.some(candidate => testPlans.filter(item => repositoryKey(item.repositoryRoot) === repositoryKey(candidate.repositoryRoot)).length !== 1))) {
    throw new Error("Test plans must cover every immutable candidate exactly once");
  }
  value.identitySha256 = releaseIdentitySha256(value);
  return value;
}

export function normalizeTestSelectionAmendment(value, operation) {
  const { identitySha256, ...contents } = value ?? {};
  if (typeof contents.requestId !== "string" || !contents.requestId.trim()
      || !Number.isSafeInteger(contents.priorRevision) || contents.priorRevision < 1
      || !Number.isSafeInteger(contents.priorGeneration) || contents.priorGeneration < 1
      || contents.authorizationFingerprint !== operation.authorization.fingerprint
      || releaseIdentitySha256(contents) !== identitySha256
      || contents.selection != null && releaseIdentitySha256(normalizeTestSelection(contents.selection)) !== releaseIdentitySha256(contents.selection)
      || releaseIdentitySha256(normalizeReleaseTaskIds(contents.taskIds)) !== releaseIdentitySha256(contents.taskIds)
      || contents.taskSelection != null && JSON.stringify([...new Set(contents.taskSelection.map(item => item.taskId))].sort()) !== JSON.stringify(contents.taskIds)
      || contents.releaseMetadata != null && releaseIdentitySha256(normalizedReleaseMetadata(contents.releaseMetadata)) !== releaseIdentitySha256(contents.releaseMetadata)
      || contents.requestArguments != null && !validAmendmentRequest(contents)
      || !Array.isArray(contents.readbacks) || contents.readbacks.length !== operation.authorization.approvedTargets.length
      || operation.authorization.approvedTargets.some(target => contents.readbacks.filter(item => item.targetId === target.targetId
        && item.generation === contents.priorGeneration && item.evidence?.status === "not_applied").length !== 1)) {
    throw new Error("Invalid original test selection amendment");
  }
  return structuredClone(value);
}

export function effectiveReleaseMetadata(operation) {
  const amendments = operation.testSelectionAmendments ?? [];
  for (let index = amendments.length - 1; index >= 0; index -= 1) {
    if (amendments[index].releaseMetadata != null) return amendments[index].releaseMetadata;
  }
  return operation.authorization.releaseMetadata ?? null;
}

export function effectiveTestSelection(operation) {
  return operation.testSelectionAmendments?.at(-1)?.selection ?? operation.authorization.testSelection ?? null;
}

export function normalizeReleaseTaskIds(value) {
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== "string" || !id.trim() || id !== id.trim())
      || new Set(value).size !== value.length) throw new TypeError("Explicit Task membership requires unique exact Task IDs");
  return [...value].sort();
}

export function effectiveReleaseTaskIds(operation) {
  return operation.testSelectionAmendments?.at(-1)?.taskIds ?? operation.authorization.taskIds;
}

function releaseTaskIdsAtBoundary(operation, revision, generation) {
  let taskIds = operation.authorization.taskIds;
  for (const amendment of operation.testSelectionAmendments ?? []) {
    // Its CAS changes revision r to r+1. A historical proof at revision r
    // therefore still belongs to the membership preceding that amendment.
    if (amendment.priorRevision >= revision) continue;
    if (amendment.priorGeneration > generation) throw new Error("Reviewed-main generation membership changed");
    taskIds = amendment.taskIds;
  }
  return taskIds;
}

function validAmendmentRequest(contents) {
  const args = contents.requestArguments;
  return args && typeof args === "object" && !Array.isArray(args)
    && Object.keys(args).every(key => ["expectedRevision", "expectedGeneration", "testSelection", "taskIds", "releaseMetadata"].includes(key))
    && args.expectedRevision === contents.priorRevision && args.expectedGeneration === contents.priorGeneration
    && (args.testSelection === undefined || releaseIdentitySha256(normalizeTestSelection(args.testSelection)) === releaseIdentitySha256(contents.selection))
    && (args.taskIds === undefined || releaseIdentitySha256(normalizeReleaseTaskIds(args.taskIds)) === releaseIdentitySha256(contents.taskIds))
    && (args.releaseMetadata === undefined || releaseIdentitySha256(normalizedReleaseMetadata(args.releaseMetadata)) === releaseIdentitySha256(contents.releaseMetadata));
}
