// Historical Task proof decoder only. No operation writer, worker or transition API.
import { createHash } from "node:crypto";
import { normalizeTestSelection } from "./test-selection.mjs";
import path from "node:path";
import { selectedCompositionFields } from "./task-selected-composition.mjs";
import { semanticVersion } from "./agent-hub-version.mjs";
import { normalizedRuntimeInstallation, PUBLIC_RUNTIME_INSTALLATION } from "./legacy-release-authorization.mjs";
import { normalizedRecipeAuthorization } from "./legacy-task-publication-authorization.mjs";


const RELEASE_OPERATION_STATES = Object.freeze({
  COMPOSE: "compose",
  VALIDATE: "validate",
  PUBLISH: "publish",
  FINALIZE: "finalize",
  WAITING: "waiting",
  DONE: "done",
  FAILED: "failed",
});


const TERMINAL_STATES = new Set([
  RELEASE_OPERATION_STATES.DONE,
  RELEASE_OPERATION_STATES.FAILED,
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

function releaseIdentitySha256(value) {
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
    const retainedReview = entry.nativeResolutionReview;
    if (retainedReview != null && (typeof retainedReview !== "object"
      || ![Object.prototype, null].includes(Object.getPrototypeOf(retainedReview)))) {
      throw new TypeError("Invalid exact native resolution bundle");
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
      // Preserve immutable historical authorization bytes, without treating
      // their obsolete native-review field as an execution capability.
      ...(entry.nativeResolutionReview != null
        ? { nativeResolutionReview: structuredClone(entry.nativeResolutionReview) } : {}),
    };
  }).sort((left, right) => left.targetId.localeCompare(right.targetId));
  if (!targets.length) throw new TypeError("approvedTargets requires at least one target");
  if (new Set(targets.map((entry) => entry.targetId)).size !== targets.length) {
    throw new TypeError("approved target ids must be unique");
  }
  return targets;
}

function normalizeReleaseVersion(value) {
  const version = semanticVersion(value);
  if (version.prerelease.length || version.metadata) throw new TypeError("Release version must be a complete X.Y.Z public version");
  return value;
}

function normalizedReleaseMetadata(value) {
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

function normalizeReleaseTaskScope(value) {
  if (value !== "all_await") throw new TypeError("taskScope must be all_await");
  return value;
}

function normalizedAuthorization(value = {}) {
  const approvedTargets = normalizedTargets(value.approvedTargets);
  const authorization = {
    taskIds: uniqueTextList(value.taskIds, "authorization taskIds"),
    ...(value.taskScope == null ? {} : { taskScope: normalizeReleaseTaskScope(value.taskScope) }),
    approvedTargets,
    validationMode: requiredText(value.validationMode, "validationMode"),
    ...(value.testSelection != null ? { testSelection: normalizeTestSelection(value.testSelection) } : {}),
    ...(value.releaseMetadata ? { releaseMetadata: normalizedReleaseMetadata(value.releaseMetadata) } : {}),
    ...(value.releaseVersion !== undefined ? { releaseVersion: normalizeReleaseVersion(value.releaseVersion) } : {}),
    ...normalizedRuntimeInstallation(value.runtimeInstallation, approvedTargets),
    ...normalizedRecipeAuthorization(value.recipe, approvedTargets),
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

function releaseOperationIsTerminal(operation) {
  return TERMINAL_STATES.has(String(operation?.state ?? ""));
}

const repositoryKey = value => {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

function reviewedMainBinding(operation, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
      || !Array.isArray(value.approvedRepositories) || !value.approvedRepositories.length) throw new TypeError("Invalid reviewed-main binding");
  const roots = new Set(operation.authorization.approvedTargets.map(target => {
    if (!target.repositoryRoot) {
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

function normalizedFirstComposeRecovery(value, operation) {
  const { identitySha256, ...contents } = value;
  if (identitySha256 !== releaseIdentitySha256(contents) || !contents.requestId
      || contents.operationId !== operation.operationId || contents.priorGeneration !== 0
      || !Number.isSafeInteger(contents.priorRevision) || contents.priorRevision < 1
      || contents.authorizationFingerprint !== operation.authorization.fingerprint
      || contents.inputSha256 !== releaseIdentitySha256(contents.input)
      || contents.input?.priorGeneration !== 0
      || releaseIdentitySha256(contents.input?.authorization) !== releaseIdentitySha256(operation.authorization)
      || !/^[a-f0-9]{64}$/u.test(contents.receiptSha256 ?? "")
      || !Number.isSafeInteger(contents.attempt) || contents.attempt < 1
      || !Array.isArray(contents.candidates) || !contents.candidates.length) {
    throw new Error("First compose recovery does not bind its original frozen input");
  }
  return structuredClone(value);
}

// Validate an archived recovery binding; this decoder never reserves a generation.
function normalizedPublicationRecovery(value, operation) {
  const { identitySha256, ...contents } = value ?? {};
  if (!contents.requestId || contents.operationId !== operation.operationId
    || contents.authorizationFingerprint !== operation.authorization.fingerprint
    || !Number.isSafeInteger(contents.priorRevision) || contents.priorRevision < 1
    || contents.generation !== operation.currentGeneration || !contents.boundary || !contents.evidence
    || releaseIdentitySha256(contents) !== identitySha256) throw new Error("Invalid publication recovery");
  if (contents.boundary.kind === "not-applied-publication-recovery-v1"
    && (!Array.isArray(contents.readbacks) || contents.readbacks.length !== releaseApprovedTargets(operation).length
      || releaseApprovedTargets(operation).some(target => contents.readbacks.filter(item =>
        item.targetId === target.targetId && item.generation === contents.generation
        && item.evidence?.status === "not_applied").length !== 1))) {
    throw new Error("Not-applied publication recovery requires every exact target readback");
  }
  return structuredClone(value);
}

function normalizedRetainedGenerationRecovery(value, operation) {
  const { identitySha256, ...contents } = value ?? {};
  if (!contents.requestId || contents.operationId !== operation.operationId
      || contents.authorizationFingerprint !== operation.authorization.fingerprint
      || !Number.isSafeInteger(contents.priorRevision) || contents.priorRevision < 1
      || contents.generation !== operation.currentGeneration
      || !contents.boundary || !Array.isArray(contents.evidence)
      || !Array.isArray(contents.readbacks) || contents.readbacks.length !== releaseApprovedTargets(operation).length
      || releaseApprovedTargets(operation).some(target => contents.readbacks.filter(item => item.targetId === target.targetId
        && item.generation === contents.generation && item.evidence?.status === "not_applied").length !== 1)
      || releaseIdentitySha256(contents) !== identitySha256) throw new Error("Invalid retained generation recovery");
  return structuredClone(value);
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

function releaseApprovedTargets(operation) {
  const targets = operation.authorization.approvedTargets.map(target => {
    const approval = operation.reviewedMain?.approvedRepositories.find(entry =>
      repositoryKey(entry.projectRoot) === repositoryKey(target.repositoryRoot));
    return approval ? { ...target, approvedLocalMainCommit: approval.approvedLocalMainCommit,
      approvedOriginMainCommit: approval.approvedOriginMainCommit } : target;
  });
  if (operation.authorization.recipe) {
    return operation.authorization.recipe.targetOrder.map(id => targets.find(target => target.targetId === id));
  }
  return operation.authorization.runtimeInstallation === PUBLIC_RUNTIME_INSTALLATION
    ? [...targets.filter(target => target.environment === "github-release"),
      ...targets.filter(target => target.environment !== "github-release")]
    : targets;
}

function decodeHistoricalOperation({
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
  firstComposeRecovery = null,
  retainedGenerationRecoveries = [],
  publicationRecoveries = [],
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
  if (firstComposeRecovery != null) operation.firstComposeRecovery = normalizedFirstComposeRecovery(firstComposeRecovery, operation);
  if (retainedGenerationRecoveries.length) operation.retainedGenerationRecoveries = retainedGenerationRecoveries.map(item => normalizedRetainedGenerationRecovery(item, { ...operation, currentGeneration: item.generation }));
  if (publicationRecoveries.length) operation.publicationRecoveries = publicationRecoveries.map(item => normalizedPublicationRecovery(item, { ...operation, currentGeneration: item.generation }));
  if (releaseOperationIsTerminal(operation)) operation.completedAt = operation.updatedAt;
  return operation;
}

function restoreReleaseOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const operation = decodeHistoricalOperation(value);
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

function completedReleaseGenerationEvidence({ operation, generation, validation, finalization } = {}) {
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

function normalizeTestSelectionAmendment(value, operation) {
  const { identitySha256, ...contents } = value ?? {};
  const first = contents.firstComposeRecovery;
  if (first != null) {
    normalizedFirstComposeRecovery(first, operation);
    if (contents.priorGeneration !== 0 || first.requestId !== contents.requestId
        || first.priorRevision !== contents.priorRevision || contents.taskScope !== "all_await"
        || !contents.requestArguments?.taskIds || !contents.requestArguments?.testSelection
        || !contents.taskSelection?.length
        || first.candidates.some(candidate => candidate.kind !== "uncaptured-first-generation-v1" || !candidate.preparedSource)) {
      throw new Error("Invalid first compose amendment authority");
    }
  }
  if (typeof contents.requestId !== "string" || !contents.requestId.trim()
      || !Number.isSafeInteger(contents.priorRevision) || contents.priorRevision < 1
      || !Number.isSafeInteger(contents.priorGeneration) || contents.priorGeneration < 0
      || contents.priorGeneration === 0 && first == null
      || contents.authorizationFingerprint !== operation.authorization.fingerprint
      || releaseIdentitySha256(contents) !== identitySha256
      || contents.taskScope != null && normalizeReleaseTaskScope(contents.taskScope) !== contents.taskScope
      || contents.selection != null && releaseIdentitySha256(normalizeTestSelection(contents.selection)) !== releaseIdentitySha256(contents.selection)
      || releaseIdentitySha256(normalizeReleaseTaskIds(contents.taskIds)) !== releaseIdentitySha256(contents.taskIds)
      || contents.taskSelection != null && JSON.stringify([...new Set(contents.taskSelection.map(item => item.taskId))].sort()) !== JSON.stringify(contents.taskIds)
      || contents.releaseMetadata != null && releaseIdentitySha256(normalizedReleaseMetadata(contents.releaseMetadata)) !== releaseIdentitySha256(contents.releaseMetadata)
      || contents.requestArguments != null && !validAmendmentRequest(contents)
      || contents.admission != null && (contents.admission.kind !== "uncaptured-test-selection-amendment-v1"
        || contents.admission.boundary?.operationId !== operation.operationId
        || contents.admission.boundary.priorRevision !== contents.priorRevision
        || contents.admission.boundary.generation !== contents.priorGeneration
        || !/^[a-f0-9]{64}$/u.test(contents.admission.amendmentsSha256 ?? ""))
      || !Array.isArray(contents.readbacks)
      || (first ? contents.readbacks.length !== 0 : contents.readbacks.length !== operation.authorization.approvedTargets.length
        || operation.authorization.approvedTargets.some(target => contents.readbacks.filter(item => item.targetId === target.targetId
          && item.generation === contents.priorGeneration && item.evidence?.status === "not_applied").length !== 1))) {
    throw new Error("Invalid original test selection amendment");
  }
  return structuredClone(value);
}

function normalizeReleaseTaskIds(value) {
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== "string" || !id.trim() || id !== id.trim())
      || new Set(value).size !== value.length) throw new TypeError("Explicit Task membership requires unique exact Task IDs");
  return [...value].sort();
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
    && Object.keys(args).every(key => ["expectedRevision", "expectedGeneration", "testSelection", "taskIds", "taskScope", "releaseMetadata"].includes(key))
    && args.expectedRevision === contents.priorRevision && args.expectedGeneration === contents.priorGeneration
    && (args.testSelection === undefined || releaseIdentitySha256(normalizeTestSelection(args.testSelection)) === releaseIdentitySha256(contents.selection))
    && (args.taskScope === undefined || normalizeReleaseTaskScope(args.taskScope) === contents.taskScope)
    && (args.taskIds === undefined || releaseIdentitySha256(normalizeReleaseTaskIds(args.taskIds)) === releaseIdentitySha256(contents.taskIds))
    && (args.releaseMetadata === undefined || releaseIdentitySha256(normalizedReleaseMetadata(args.releaseMetadata)) === releaseIdentitySha256(contents.releaseMetadata));
}

export { releaseIdentitySha256, completedReleaseGenerationEvidence, restoreReleaseOperation, releaseApprovedTargets };
