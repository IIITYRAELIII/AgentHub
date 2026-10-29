import { normalizeTestSelection } from "../domain/test-selection.mjs";
import { randomUUID } from "node:crypto";

import {
  createCandidateGeneration,
  completedReleaseGenerationEvidence,
  RELEASE_OPERATION_STATES,
  releaseIdentitySha256,
  releaseOperationIsTerminal,
  reviewedMainBinding,
  failedComposeRecoveryEligible,
  releaseApprovedTargets,
  effectiveTestSelection,
  effectiveReleaseTaskIds,
  effectiveReleaseTaskScope,
  normalizeReleaseTaskScope,
  normalizeReleaseTaskIds,
  normalizedReleaseMetadata,
} from "../domain/release-operation.mjs";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 30_000;

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredText(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function releaseError(error) {
  return {
    message: String(error?.message ?? error ?? "release operation failed"),
    ...(String(error?.code ?? "").trim() ? { code: String(error.code).trim() } : {}),
    ...(String(error?.taskId ?? "").trim() ? { taskId: String(error.taskId).trim() } : {}),
    ...(String(error?.priorResultCommit ?? "").trim()
      ? { priorResultCommit: String(error.priorResultCommit).trim() } : {}),
    ...(String(error?.resultCommit ?? "").trim() ? { resultCommit: String(error.resultCommit).trim() } : {}),
    ...(String(error?.correctionOperationId ?? "").trim()
      ? { correctionOperationId: String(error.correctionOperationId).trim() } : {}),
  };
}

function retryAt(now, delayMs) {
  return new Date(Date.parse(now()) + Math.max(1_000, Number(delayMs) || DEFAULT_RETRY_MS)).toISOString();
}

function targetEffects(operation) {
  return operation.publicationEffects?.targets && typeof operation.publicationEffects.targets === "object"
    ? { ...operation.publicationEffects.targets }
    : {};
}

function publishedTarget(effect) {
  return effect?.status === "applied" || effect?.status === "already_applied";
}

function ownsRelease(operation, owner) {
  return operation?.owner?.ownerId === owner?.ownerId
    && operation?.owner?.epoch === owner?.epoch;
}

function normalizeReadback(value) {
  const status = String(value?.status ?? "unknown").trim();
  if (!["applied", "already_applied", "partial", "not_applied", "unknown"].includes(status)) {
    throw new Error(`unsupported publication readback status: ${status || "missing"}`);
  }
  return { ...value, status };
}

function classifiedFailure(error, state, now, retryDelayMs) {
  const details = releaseError(error);
  switch (details.code) {
    case "RELEASE_PREPARATION_REJECTED":
    case "RELEASE_NATIVE_MERGE_CONFLICT":
    case "RELEASE_NATIVE_REVIEW_REQUIRED":
      return {
        state: "waiting", currentStep: "compose", resumeState: "compose",
        waitReason: { code: "preparation_refused", message: details.message, details },
        nextAction: "correct the owned preparation boundary, then continue this same release",
        lastError: { ...details, step: "compose" },
      };
    case "AWAIT_PREPARATION_UNKNOWN":
    case "AWAIT_ACCEPTANCE_UNKNOWN":
      return {
        state: "waiting", currentStep: state,
        waitReason: { code: "preparation_effect_unknown", message: details.message, details },
        nextAction: "read back this original candidate effect before continuation",
        lastError: { ...details, step: state },
      };
    case "RELEASE_MAIN_APPROVAL_STALE":
    case "RELEASE_PREPARED_CANDIDATE_STALE":
      return {
        state: "waiting", currentStep: state, resumeState: "compose",
        waitReason: { code: "prepared_candidate_stale", message: details.message, details },
        nextAction: "prepare and verify the current selected PreRelease candidate through its normal owner, then continue this operation",
        lastError: { ...details, step: state },
      };
    case "RELEASE_VALIDATION_FAILED":
      return {
        state: "waiting", currentStep: "validate", resumeState: "compose",
        waitReason: { code: "validation_failed", message: details.message, details },
        nextAction: "accept a corrected selected result and compose the next candidate generation",
        lastError: { ...details, step: "validate" },
      };
    case "RELEASE_CORRECTION_REQUIRED":
    case "RELEASE_RESULT_LINEAGE_MISMATCH":
      return {
        state: "waiting", currentStep: state, resumeState: "compose",
        waitReason: { code: "correction_required", message: details.message, details },
        nextAction: "prepare and review the selected Task correction, then continue automatically",
        lastError: { ...details, step: state },
      };
    case "RELEASE_EXTERNAL_CONDITION":
      return {
        state: "waiting", currentStep: state, resumeState: state,
        waitReason: {
          code: "external_condition", message: details.message, details,
          retryAt: retryAt(now, error?.retryAfterMs ?? retryDelayMs),
        },
        nextAction: "retry the same authorized stage after the external condition recovers",
        lastError: { ...details, step: state },
      };
    case "RELEASE_EXTERNAL_EFFECT_UNKNOWN":
      return {
        state: "waiting", currentStep: state, resumeState: state,
        waitReason: {
          code: "external_effect_readback", message: details.message, details,
          retryAt: retryAt(now, error?.retryAfterMs ?? retryDelayMs),
        },
        nextAction: "read back the exact external effect before any retry",
        lastError: { ...details, step: state },
      };
    default:
      return {
        state: "failed", currentStep: state,
        nextAction: null,
        lastError: { ...details, step: state },
      };
  }
}

export class ReleaseOperationService {
  #scheduled = new Set();
  #running = new Set();
  #retryTimers = new Map();
  #deliveryTimer = null;
  #deliveryRunning = false;
  #deliveryRerun = false;

  constructor({
    store,
    compose,
    validate,
    publishTarget,
    readTarget,
    finalize,
    reservePublication = ({ reserve }) => reserve(),
    deliverEvent = null,
    schedule = (operation) => setImmediate(operation),
    ownerId = `release-worker-${process.pid}-${randomUUID()}`,
    runnerVersion = "release-operation-v1",
    now = () => new Date().toISOString(),
    leaseMs = DEFAULT_LEASE_MS,
    retryDelayMs = DEFAULT_RETRY_MS,
    processAlive,
    processId = process.pid,
    deliveryRetryMs = 1_000,
    requestCorrection = null,
    cleanupGeneration = null,
    withReviewedMainRecovery = null,
    observeOperation = null,
    resolveTestPlans = null,
    withTaskSelection = null,
  } = {}) {
    for (const name of [
      "create", "get", "snapshot", "transition", "acquire", "heartbeat", "release",
      "putGeneration", "generation", "beginStep", "finishStep", "latestStep",
      "runnable", "active", "forTask", "pendingEvents", "settleEvent",
      "runOperationMutation", "isContentionError",
    ]) requiredMethod(store, name);
    for (const [value, name] of [
      [compose, "compose"], [validate, "validate"], [publishTarget, "publishTarget"],
      [readTarget, "readTarget"], [finalize, "finalize"],
    ]) {
      if (typeof value !== "function") throw new TypeError(`${name} is required`);
    }
    if (deliverEvent != null && typeof deliverEvent !== "function") throw new TypeError("deliverEvent must be a function");
    if (typeof reservePublication !== "function") throw new TypeError("reservePublication must be a function");
    if (requestCorrection != null && typeof requestCorrection !== "function") {
      throw new TypeError("requestCorrection must be a function");
    }
    if (cleanupGeneration != null && typeof cleanupGeneration !== "function") {
      throw new TypeError("cleanupGeneration must be a function");
    }
    if (typeof processAlive !== "function") throw new TypeError("processAlive is required");
    if (typeof schedule !== "function") throw new TypeError("schedule is required");
    this.store = store;
    this.compose = compose;
    this.validate = validate;
    this.publishTarget = publishTarget;
    this.readTarget = readTarget;
    this.finalize = finalize;
    this.reservePublication = reservePublication;
    this.deliverEvent = deliverEvent;
    this.scheduleTask = schedule;
    this.ownerId = requiredText(ownerId, "ownerId");
    this.runnerVersion = requiredText(runnerVersion, "runnerVersion");
    this.now = now;
    this.leaseMs = Math.max(100, Number(leaseMs) || DEFAULT_LEASE_MS);
    this.retryDelayMs = Math.max(1_000, Number(retryDelayMs) || DEFAULT_RETRY_MS);
    this.processAlive = processAlive;
    this.processId = processId;
    this.deliveryRetryMs = Math.max(100, Number(deliveryRetryMs) || 1_000);
    this.requestCorrection = requestCorrection;
    this.cleanupGeneration = cleanupGeneration;
    this.withReviewedMainRecovery = withReviewedMainRecovery;
    this.observeOperation = observeOperation;
    this.resolveTestPlans = resolveTestPlans;
    this.withTaskSelection = withTaskSelection;
  }

  start({ requestId, workspaceId, streamId, threadId, authorization, resolveAuthorization = null } = {}) {
    const created = this.store.create({
      requestId, workspaceId, streamId, threadId, authorization,
      runnerVersion: this.runnerVersion,
    }, { resolveAuthorization });
    this.#observe(created.operation.operationId);
    this.#schedule(created.operation.operationId);
    return {
      accepted: true,
      created: created.created,
      operationId: created.operation.operationId,
      state: created.operation.state,
      revision: created.operation.revision,
    };
  }

  setEventDelivery(deliverEvent) {
    if (typeof deliverEvent !== "function") throw new TypeError("deliverEvent is required");
    this.deliverEvent = deliverEvent;
    this.#scheduleDelivery(0);
  }

  get(operationId) {
    const snapshot = this.store.snapshot(requiredText(operationId, "operationId"));
    if (!snapshot) throw new Error("release operation was not found");
    return snapshot;
  }

  // Read-only eligibility from this original release owner. Directory age or a
  // local Git head is never evidence that a release finished publication.
  retentionGeneration(operationId, number) {
    const operation = this.store.get(operationId);
    const generation = this.store.generation(operationId, number);
    if (!generation || generation.operationId !== operationId || generation.generation !== number) return null;
    return completedReleaseGenerationEvidence({ operation, generation,
      validation: this.store.latestStep(operationId, number, "validate"),
      finalization: this.store.latestStep(operationId, number, "finalize") });
  }

  continue(operationId, options = {}) {
    const current = this.store.get(requiredText(operationId, "operationId"));
    if (!current) throw new Error("release operation was not found");
    // A captured amendment remains an amendment even when a replay omits all
    // optional fields. Check its identity before ordinary resume or recovery.
    if (current.testSelectionAmendments?.some(item => item.requestId === options.requestId)
        || options.testSelection != null || options.taskIds != null || options.taskScope != null || options.releaseMetadata != null) return this.#amendTestSelection(operationId, options);
    if (options.reviewedMain != null) return this.#recoverReviewedMain(operationId, options);
    // Addressed observation also works while the original is waiting on an
    // external condition. It neither resumes nor publishes that condition.
    this.#observe(current.operationId);
    if (releaseOperationIsTerminal(current)) return { accepted: false, operation: current, reason: "terminal" };
    let operation = current;
    if (current.state === RELEASE_OPERATION_STATES.WAITING) {
      const resumeState = String(current.resumeState ?? "").trim();
      if (!resumeState) {
        return { accepted: false, operation: current, reason: "external-condition" };
      }
      const resumed = this.store.transition(current.operationId, {
        state: resumeState,
        currentStep: resumeState,
        nextAction: `continue ${resumeState}`,
        lastError: null,
      }, {
        expectedRevision: current.revision,
        eventKind: "operation.resumed",
      });
      operation = resumed.operation;
      if (!resumed.applied && resumed.reason !== "stale-revision") {
        return { accepted: false, operation, reason: resumed.reason };
      }
    }
    this.#schedule(operation.operationId);
    return { accepted: true, operationId: operation.operationId, state: operation.state, revision: operation.revision };
  }

  #observe(operationId) {
    try {
      Promise.resolve(this.observeOperation?.(operationId)).catch(() => {
        console.warn('Release progress monitor unavailable: MONITOR_OBSERVATION_FAILED');
      });
    } catch {
      console.warn('Release progress monitor unavailable: MONITOR_OBSERVATION_FAILED');
    }
  }

  async #amendTestSelection(operationId, { requestId, testSelection, taskIds, taskScope, releaseMetadata, expectedRevision, expectedGeneration, reviewedMain }) {
    if (reviewedMain != null) throw new Error("Use separate original amendments for reviewed main and test selection");
    const current = this.store.get(requiredText(operationId, "operationId"));
    if (!current) throw new Error("release operation was not found");
    const requestArguments = { expectedRevision, expectedGeneration,
      ...(testSelection == null ? {} : { testSelection: normalizeTestSelection(testSelection) }),
      ...(taskIds == null ? {} : { taskIds: normalizeReleaseTaskIds(taskIds) }),
      ...(taskScope == null ? {} : { taskScope: normalizeReleaseTaskScope(taskScope) }),
      ...(releaseMetadata == null ? {} : { releaseMetadata: normalizedReleaseMetadata(releaseMetadata) }),
    };
    requiredText(requestId, "amendment requestId");
    const previous = current.testSelectionAmendments?.find(item => item.requestId === requestId);
    if (previous) {
      // Omitted arguments belong to this original request, never to a later
      // effective selection. Old records without explicit argument capture
      // retain their saved outcome as that original boundary.
      const selection = testSelection == null ? previous.selection : requestArguments.testSelection;
      const selectedTaskIds = taskIds == null ? previous.taskIds : requestArguments.taskIds;
      if (previous.priorRevision !== expectedRevision || previous.priorGeneration !== expectedGeneration
          || previous.requestArguments != null && releaseIdentitySha256(previous.requestArguments) !== releaseIdentitySha256(requestArguments)
          || releaseIdentitySha256(previous.selection) !== releaseIdentitySha256(selection)
          || JSON.stringify(previous.taskIds) !== JSON.stringify(selectedTaskIds)
          || releaseMetadata != null && (previous.releaseMetadata == null || releaseIdentitySha256(previous.releaseMetadata) !== releaseIdentitySha256(requestArguments.releaseMetadata))) throw new Error("Amendment request identity changed");
      return { accepted: true, duplicate: true, operationId, amendment: previous, revision: previous.priorRevision + 1 };
    }
    const selection = testSelection == null ? effectiveTestSelection(current) : requestArguments.testSelection;
    const selectedTaskIds = taskIds == null ? effectiveReleaseTaskIds(current) : requestArguments.taskIds;
    if (expectedRevision !== current.revision || expectedGeneration !== current.currentGeneration) {
      return { accepted: false, reason: "stale-revision", operation: current };
    }
    if (current.owner || !["waiting", "failed"].includes(current.state) || current.currentGeneration < 1) {
      return { accepted: false, reason: "ineligible", operation: current };
    }
    const generation = this.store.generation(operationId, current.currentGeneration);
    if (!generation) throw new Error("Original generation is missing");
    const scope = taskScope == null ? effectiveReleaseTaskScope(current) : requestArguments.taskScope;
    const commit = async (taskSelection = null, validateBeforeCommit = async () => {}) => {
    const readbacks = [];
    for (const target of releaseApprovedTargets(current)) {
      const evidence = normalizeReadback(await this.readTarget({ operation: current, generation, target }));
      if (evidence.status !== "not_applied") throw new Error(`Original publication effect is ${evidence.status}`);
      readbacks.push({ targetId: target.targetId, generation: current.currentGeneration, evidence });
    }
    await validateBeforeCommit();
    const capturedTaskIds = taskSelection ? [...new Set(taskSelection.map(item => item.taskId))].sort() : selectedTaskIds;
    const contents = { requestId, requestArguments, selection, taskIds: capturedTaskIds, taskSelection,
      ...(scope == null ? {} : { taskScope: scope }),
      ...(releaseMetadata == null ? {} : { releaseMetadata: requestArguments.releaseMetadata }), priorRevision: current.revision, priorGeneration: current.currentGeneration,
      authorizationFingerprint: current.authorization.fingerprint,
      priorFailure: { state: current.state, completedAt: current.completedAt, error: current.lastError },
      priorPublicationEffects: current.publicationEffects, priorWaitReason: current.waitReason, priorResumeState: current.resumeState, readbacks };
    const amendment = { ...contents, identitySha256: releaseIdentitySha256(contents) };
    const result = this.store.transition(operationId, { state: "compose", currentStep: "compose", lastError: null,
      publicationEffects: {}, nextAction: "compose the original release with explicit test selection" }, {
      expectedRevision, testSelectionAmendment: amendment, eventKind: "operation.test-selection-amended",
      event: { operationId, amendment },
    });
    if (result.applied) { this.#observe(operationId); this.#schedule(operationId); }
    return { accepted: result.applied, reason: result.reason, operationId, revision: result.operation.revision, amendment };
    };
    if (taskIds != null || scope === "all_await") {
      if (typeof this.withTaskSelection !== "function") throw new Error("Accepted Task selection owner is unavailable");
      return this.withTaskSelection({ operation: current, taskIds: taskIds == null && scope === "all_await" ? null : selectedTaskIds,
        taskScope: scope, commit });
    }
    return commit();
  }

  async #recoverReviewedMain(operationId, { requestId, reviewedMain }) {
    const current = this.store.get(requiredText(operationId, "operationId"));
    if (!current) throw new Error("release operation was not found");
    this.#observe(current.operationId);
    const binding = reviewedMainBinding(current, reviewedMain);
    if (binding.expectedRevision !== current.revision) return { accepted: false, reason: "stale-revision", operation: current };
    if (!failedComposeRecoveryEligible(current)) return { accepted: false, reason: "ineligible", operation: current };
    if (typeof requestId !== "string" || !requestId.trim()) throw new TypeError("Recovery requestId must be a primitive string");
    if (typeof this.withReviewedMainRecovery !== "function") throw new Error("Reviewed-main recovery verification is unavailable");
    return this.withReviewedMainRecovery({ workspaceId: current.workspaceId,
      taskIds: effectiveReleaseTaskIds(current), approvedRepositories: binding.approvedRepositories,
      commit: async (authority, validateBeforeCommit) => {
        if (releaseIdentitySha256(authority.approvedRepositories) !== releaseIdentitySha256(binding.approvedRepositories)) {
          throw new Error("Reviewed-main verified repository binding changed");
        }
        const generation = this.store.generation(current.operationId, current.currentGeneration);
        if (!generation) throw new Error("Original publication generation is missing");
        const readbacks = [];
        for (const target of current.authorization.approvedTargets) {
          const readback = normalizeReadback(await this.readTarget({ operation: current, generation, target, reviewedMain: authority }));
          if (readback.status !== "not_applied") throw new Error(`Original publication effect readback is ${readback.status}`);
          readbacks.push({ targetId: target.targetId, generation: generation.generation, evidence: readback });
        }
        await validateBeforeCommit();
        const contents = { ...authority, requestId, priorRevision: current.revision, priorGeneration: current.currentGeneration,
          previousBinding: current.reviewedMain?.identitySha256 ?? null,
          priorFailure: { completedAt: current.completedAt, error: current.lastError },
          authorizationFingerprint: current.authorization.fingerprint, readbacks };
        const recovery = { ...contents, identitySha256: releaseIdentitySha256(contents) };
        const result = this.store.transition(current.operationId, { state: "compose", currentStep: "compose",
          lastError: null, nextAction: "compose current reviewed main with the original selected set" }, {
          expectedRevision: binding.expectedRevision, reviewedMainRecovery: recovery, eventKind: "operation.reviewed-main-rebound",
          event: { operationId: current.operationId, state: "compose", reviewedMain: recovery },
        });
        if (result.applied) this.#schedule(current.operationId);
        return { accepted: result.applied, reason: result.reason, operationId: current.operationId,
          state: result.operation.state, revision: result.operation.revision };
      } });
  }

  wakeForTask(taskId, { workspaceId = null } = {}) {
    const selectedTaskId = requiredText(taskId, "taskId");
    const accepted = this.prepareForTaskAcceptance(selectedTaskId, { workspaceId }).map((item) => item.operationId);
    const operations = this.store.forTask(selectedTaskId, { workspaceId });
    for (const operation of operations) {
      if (releaseOperationIsTerminal(operation)) continue;
      if (operation.state === "waiting" && ["validation_failed", "correction_required"].includes(operation.waitReason?.code)) {
        const resumed = this.continue(operation.operationId);
        if (resumed.accepted && !accepted.includes(operation.operationId)) accepted.push(operation.operationId);
      }
    }
    return accepted;
  }

  prepareForTaskAcceptance(taskId, { workspaceId = null } = {}) {
    const operations = this.store.forTask(requiredText(taskId, "taskId"), { workspaceId });
    const prepared = [];
    for (const operation of operations) {
      if (releaseOperationIsTerminal(operation)) continue;
      let current = operation;
      for (;;) {
        if (current.publicationEffects?.publishStarted) {
          prepared.push({ operationId: current.operationId, generation: current.currentGeneration, preserved: true });
          break;
        }
        if (!["validate", "publish", "waiting", "compose"].includes(current.state)) break;
        if (current.state === "waiting"
            && !["validation_failed", "correction_required"].includes(current.waitReason?.code)) break;
        const revokedOwner = current.owner ? {
          ...current.owner,
          epoch: current.owner.epoch + 1,
          heartbeatAt: this.now(),
          leaseExpiresAt: this.now(),
        } : null;
        const transitioned = this.store.transition(current.operationId, {
          state: "compose",
          currentStep: "compose",
          owner: revokedOwner,
          nextAction: "compose corrected accepted results before publication",
          lastError: null,
        }, {
          expectedRevision: current.revision,
          eventKind: "operation.selection-changed",
          event: { operationId: current.operationId, taskId: String(taskId), priorGeneration: current.currentGeneration },
        });
        if (transitioned.applied) {
          this.#schedule(current.operationId);
          prepared.push({ operationId: current.operationId, generation: current.currentGeneration + 1, recomposed: true });
          break;
        }
        if (transitioned.reason !== "stale-revision") {
          throw new Error(`release selection CAS failed: ${transitioned.reason}`);
        }
        current = this.store.get(current.operationId);
        if (!current || releaseOperationIsTerminal(current)) break;
      }
    }
    return prepared;
  }

  recover() {
    const operations = this.store.active();
    for (const operation of operations) {
      if (operation.state === "waiting") this.#scheduleRetry(operation);
      else this.#schedule(operation.operationId);
    }
    this.#scheduleDelivery(0);
    return { scheduled: operations.map((operation) => operation.operationId) };
  }

  async deliverPendingEvents({ limit = 100 } = {}) {
    if (!this.deliverEvent) return { delivered: 0, failed: 0, skipped: true };
    if (this.#deliveryRunning) {
      this.#deliveryRerun = true;
      return { delivered: 0, failed: 0, skipped: true };
    }
    this.#deliveryRunning = true;
    let delivered = 0;
    let failed = 0;
    let read = 0;
    let retryAttempt = 0;
    try {
      do {
        this.#deliveryRerun = false;
        const events = this.store.pendingEvents({ limit });
        read = Math.max(read, events.length);
        for (const event of events) {
          try {
            await this.deliverEvent(event);
            this.store.settleEvent(event, { delivered: true });
            delivered += 1;
          } catch (error) {
            this.store.settleEvent(event, { delivered: false, error });
            failed += 1;
            retryAttempt = Math.max(retryAttempt, Number(event.attempts) + 1);
          }
        }
      } while (this.#deliveryRerun);
    } finally {
      this.#deliveryRunning = false;
    }
    if (failed || read >= limit) {
      const delay = failed
        ? Math.min(60_000, this.deliveryRetryMs * (2 ** Math.min(Math.max(0, retryAttempt - 1), 6)))
        : 0;
      this.#scheduleDelivery(delay);
    }
    return { delivered, failed };
  }

  #scheduleDelivery(delayMs) {
    if (!this.deliverEvent || this.#deliveryTimer) return;
    this.#deliveryTimer = setTimeout(() => {
      this.#deliveryTimer = null;
      void this.deliverPendingEvents().catch(() => this.#scheduleDelivery(this.deliveryRetryMs));
    }, Math.max(0, delayMs));
    this.#deliveryTimer.unref?.();
  }

  async drain(operationId) {
    const id = requiredText(operationId, "operationId");
    while (this.#scheduled.has(id) || this.#running.has(id)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.get(id);
  }

  async drainAddressed({ requestId, operationId, taskId } = {}) {
    // Local lifetime bookkeeping is not recovery/admission. Read the durable
    // identity of work already scheduled by this consumer and never wake it.
    const pending = new Set([...this.#scheduled, ...this.#running]);
    for (const id of pending) {
      const original = this.store.get(id);
      if (original && (operationId ? original.operationId === operationId
        : taskId ? original.authorization.taskIds.includes(taskId)
        : typeof requestId === "string" && original.requestId === requestId)) {
        await this.drain(id);
      }
    }
  }

  #schedule(operationId) {
    const timer = this.#retryTimers.get(operationId);
    if (timer) clearTimeout(timer);
    this.#retryTimers.delete(operationId);
    if (this.#scheduled.has(operationId) || this.#running.has(operationId)) return;
    this.#scheduled.add(operationId);
    this.scheduleTask(() => {
      this.#scheduled.delete(operationId);
      return this.#run(operationId).catch(error => this.#backgroundFailure(operationId, error));
    });
  }

  async #run(operationId) {
    if (this.#running.has(operationId)) return;
    this.#running.add(operationId);
    let owned = false;
    let acquisitionDenied = null;
    let owner = null;
    let heartbeat = null;
    let persistenceUnavailable = false;
    let runFailed = false;
    try {
      const acquired = await this.store.runOperationMutation(operationId, () => {
        const prior = this.store.get(operationId);
        const takeoverAllowed = Boolean(prior?.owner?.processId && !this.processAlive(prior.owner.processId));
        return this.store.acquire(operationId, this.ownerId, {
          leaseMs: this.leaseMs, processId: this.processId, takeoverAllowed,
        });
      });
      if (!acquired.acquired) {
        acquisitionDenied = acquired.reason;
        return;
      }
      owned = true;
      owner = acquired.operation.owner;
      heartbeat = setInterval(() => {
        try { this.store.heartbeat(operationId, this.ownerId, { leaseMs: this.leaseMs, epoch: owner.epoch }); } catch {}
      }, Math.max(50, Math.floor(this.leaseMs / 3)));
      heartbeat.unref?.();
      let operation = acquired.operation;
      while (operation && !releaseOperationIsTerminal(operation) && operation.state !== "waiting") {
        const beat = this.store.heartbeat(operationId, this.ownerId, { leaseMs: this.leaseMs, epoch: owner.epoch });
        if (!beat.applied) break;
        try {
          if (operation.state === "compose") operation = await this.#compose(operation, owner);
          else if (operation.state === "validate") operation = await this.#validate(operation, owner);
          else if (operation.state === "publish") operation = await this.#publish(operation, owner);
          else if (operation.state === "finalize") operation = await this.#finalize(operation, owner);
          else throw new Error(`unsupported release operation state: ${operation.state}`);
        } catch (error) {
          if (this.store.isContentionError(error)) throw error;
          const latest = this.store.get(operationId) ?? operation;
          if (!ownsRelease(latest, owner)) break;
          if (error?.code === "RELEASE_RESULT_LINEAGE_MISMATCH" && this.requestCorrection) {
            try {
              const correction = await this.requestCorrection({ operation: latest, error });
              error.correctionOperationId = correction?.operationId ?? null;
            } catch (correctionError) {
              const unavailable = new Error(`Automatic correction request failed: ${correctionError.message}`, {
                cause: correctionError,
              });
              unavailable.code = "RELEASE_EXTERNAL_CONDITION";
              unavailable.retryAfterMs = this.retryDelayMs;
              error = unavailable;
            }
          }
          const patch = classifiedFailure(error, latest.state, this.now, this.retryDelayMs);
          const failed = this.store.transition(operationId, patch, {
            expectedRevision: latest.revision,
            expectedOwner: owner,
            eventKind: patch.state === "waiting" ? "operation.waiting" : "operation.failed",
          });
          operation = failed.operation;
        }
      }
    } catch (error) {
      runFailed = true;
      persistenceUnavailable = this.store.isContentionError(error);
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try {
        if (owned) await this.store.runOperationMutation(operationId, () => this.store.release(operationId, owner));
      } catch (error) {
        this.#backgroundFailure(operationId, error, owner);
        persistenceUnavailable = this.store.isContentionError(error);
        runFailed = true;
      } finally {
        this.#running.delete(operationId);
      }
      const current = this.store.get(operationId);
      if (current && releaseOperationIsTerminal(current) && current.currentGeneration > 0) {
        const generation = this.store.generation(current.operationId, current.currentGeneration);
        if (generation) await this.cleanupGeneration?.({ operation: current, generation }).catch(() => {});
      }
      if (persistenceUnavailable) this.#scheduleOwnedRetry(operationId);
      else if (acquisitionDenied === "owned") this.#scheduleOwnedRetry(operationId);
      else if (owned && !runFailed) {
        if (current?.state === "waiting") this.#scheduleRetry(current);
        else if (current && !releaseOperationIsTerminal(current)) this.#schedule(operationId);
      }
      await this.deliverPendingEvents().catch(() => {});
    }
  }

  #backgroundFailure(operationId, error, ownerToRelease = null) {
    console.warn("Release background operation unavailable", {
      operationId,
      code: String(error?.code ?? "RELEASE_BACKGROUND_ERROR").slice(0, 64),
      sqliteCode: Number(error?.errcode) || null,
    });
    if (this.store.isContentionError(error)) this.#scheduleOwnedRetry(operationId, ownerToRelease);
  }

  #scheduleOwnedRetry(operationId, ownerToRelease = null) {
    if (this.#retryTimers.has(operationId)) return;
    const timer = setTimeout(() => {
      this.#retryTimers.delete(operationId);
      void this.store.runOperationMutation(operationId, () => {
        if (ownerToRelease) this.store.release(operationId, ownerToRelease);
        const current = this.store.get(operationId);
        if (current?.state === "waiting") this.#scheduleRetry(current);
        else if (current && !releaseOperationIsTerminal(current)) this.#schedule(operationId);
      }).catch(error => this.#backgroundFailure(operationId, error, ownerToRelease));
    }, this.retryDelayMs);
    timer.unref?.();
    this.#retryTimers.set(operationId, timer);
  }

  #scheduleRetry(operation) {
    const retryAtMs = Date.parse(String(operation?.waitReason?.retryAt ?? ""));
    if (!Number.isFinite(retryAtMs)) return;
    const delay = Math.max(0, retryAtMs - Date.parse(this.now()));
    const existing = this.#retryTimers.get(operation.operationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#retryTimers.delete(operation.operationId);
      void this.store.runOperationMutation(operation.operationId, () => {
        const current = this.store.get(operation.operationId);
        if (current?.state !== "waiting" || current.revision !== operation.revision) return;
        this.continue(operation.operationId);
      }).catch(error => this.#backgroundFailure(operation.operationId, error));
    }, Math.min(delay, 2_147_000_000));
    timer.unref?.();
    this.#retryTimers.set(operation.operationId, timer);
  }

  async #discardSupersededFailedValidation(operation) {
    if (!this.cleanupGeneration || operation.currentGeneration < 1
        || operation.publicationEffects?.publishStarted) return;
    try {
      const receipt = this.store.latestStep(operation.operationId, operation.currentGeneration, "validate");
      if (receipt?.status !== "failed") return;
      const prior = this.store.generation(operation.operationId, operation.currentGeneration);
      if (!prior) return;
      const warnings = await this.cleanupGeneration({ operation, generation: prior });
      if (warnings?.length) console.warn("Release generation cleanup retained evidence after error", warnings);
    } catch (error) {
      console.warn("Release generation cleanup retained the prior candidate", error);
    }
  }

  async #compose(operation, owner) {
    const generationNumber = operation.currentGeneration + 1;
    const input = {
      authorization: operation.authorization,
      ...(operation.testSelectionAmendments?.length ? { authorizedTaskIds: effectiveReleaseTaskIds(operation) } : {}),
      priorGeneration: operation.currentGeneration,
      ...(effectiveTestSelection(operation) ? { testSelection: effectiveTestSelection(operation), amendment: operation.testSelectionAmendments?.at(-1)?.identitySha256 ?? null } : {}),
      ...(operation.reviewedMain ? { reviewedMain: operation.reviewedMain.identitySha256 } : {}),
    };
    const started = this.store.beginStep({
      operationId: operation.operationId,
      generation: generationNumber,
      stepId: "compose",
      input,
      expectedOwner: owner,
    });
    const existingGeneration = this.store.generation(operation.operationId, generationNumber);
    if (!started.created && ["intent", "unknown"].includes(started.receipt.status) && existingGeneration) {
      this.store.finishStep(started.receipt, {
        status: "applied",
        effect: { identitySha256: existingGeneration.identitySha256 },
        expectedOwner: owner,
      });
      const advanced = this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: existingGeneration.selectedResults,
        nextAction: "validate immutable candidate generation",
      }, owner);
      await this.#discardSupersededFailedValidation(operation);
      return advanced;
    }
    if (!started.created && started.receipt.status === "unknown") {
      const error = new Error("composition intent has no authoritative local outcome");
      error.code = "RELEASE_CORRECTION_REQUIRED";
      throw error;
    }
    if (!started.created && started.receipt.status === "applied") {
      const generation = this.store.generation(operation.operationId, generationNumber);
      const recordedIdentity = String(started.receipt.effect?.identitySha256 ?? "").trim();
      if (!generation || (recordedIdentity && generation.identitySha256 !== recordedIdentity)) {
        throw new Error("composed generation receipt does not match immutable candidate evidence");
      }
      const advanced = this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: generation.selectedResults,
        nextAction: "validate immutable candidate generation",
      }, owner);
      await this.#discardSupersededFailedValidation(operation);
      return advanced;
    }
    let composedGeneration = null;
    try {
      const composed = await this.compose({ operation, generation: generationNumber });
      if (effectiveTestSelection(operation) && typeof this.resolveTestPlans !== "function") throw new Error("Release test inventory owner is unavailable");
      const generation = createCandidateGeneration({
        ...composed,
        ...(effectiveReleaseTaskScope(operation) === "all_await"
          ? { authorizedTaskIds: composed.authorizedTaskIds }
          : operation.testSelectionAmendments?.length ? { authorizedTaskIds: effectiveReleaseTaskIds(operation) } : {}),
        ...(effectiveTestSelection(operation) ? { testPlans: await this.resolveTestPlans(composed.candidates, effectiveTestSelection(operation)),
          testSelectionAmendmentId: operation.testSelectionAmendments?.at(-1)?.identitySha256 ?? null } : {}),
        operationId: operation.operationId,
        generation: generationNumber,
        supersedesGeneration: operation.currentGeneration || null,
        runnerVersion: operation.runnerVersion,
        createdAt: started.receipt.createdAt,
      });
      composedGeneration = generation;
      this.store.putGeneration(generation, { expectedOwner: owner });
      this.store.finishStep(started.receipt, {
        status: "applied",
        effect: { identitySha256: generation.identitySha256 }, expectedOwner: owner,
      });
      const advanced = this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: generation.selectedResults,
        nextAction: "validate immutable candidate generation",
      }, owner);
      await this.#discardSupersededFailedValidation(operation);
      return advanced;
    } catch (error) {
      const saved = composedGeneration && this.store.generation(operation.operationId, generationNumber);
      if (saved?.identitySha256 === composedGeneration?.identitySha256 && saved) {
        this.#assertOwner(operation.operationId, owner);
        this.store.finishStep(started.receipt, { status: "applied",
          effect: { identitySha256: saved.identitySha256 }, expectedOwner: owner });
        return this.#advance(operation.operationId, "validate", { currentGeneration: generationNumber,
          selectedResults: saved.selectedResults, nextAction: "validate immutable candidate generation" }, owner);
      }
      this.store.finishStep(started.receipt, {
        status: ["AWAIT_PREPARATION_UNKNOWN", "AWAIT_ACCEPTANCE_UNKNOWN"].includes(error?.code) ? "unknown" : "failed",
        error, expectedOwner: owner });
      throw error;
    }
  }

  async #validate(operation, owner) {
    const generation = this.#generation(operation);
    const started = this.store.beginStep({
      operationId: operation.operationId,
      generation: generation.generation,
      stepId: "validate",
      input: { candidate: generation.identitySha256, mode: operation.authorization.validationMode,
        ...(generation.testPlans ? { testPlans: generation.testPlans } : {}) },
      expectedOwner: owner,
    });
    if (!started.created && started.receipt.status === "applied") {
      return this.#advance(operation.operationId, "publish", { nextAction: "publish authorized targets" }, owner);
    }
    try {
      const evidence = await this.validate({ operation, generation });
      this.#assertOwner(operation.operationId, owner);
      this.store.finishStep(started.receipt, { status: "applied", effect: evidence ?? { status: "passed" }, expectedOwner: owner });
      return this.#advance(operation.operationId, "publish", { nextAction: "publish authorized targets" }, owner);
    } catch (cause) {
      this.store.finishStep(started.receipt, { status: "failed", error: cause, expectedOwner: owner });
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!error.code) error.code = "RELEASE_VALIDATION_FAILED";
      throw error;
    }
  }

  async #publish(operation, owner) {
    const generation = this.#generation(operation);
    let latest = this.store.get(operation.operationId);
    if (!latest.publicationEffects?.publishStarted
        || latest.publicationEffects.generation !== generation.generation) {
      // Selection is awaited under the adapter's Await boundary. A heartbeat may
      // advance the revision there; it cannot authorize a different publication.
      const transitionBoundary = (patch, options) => {
        const current = this.store.get(latest.operationId);
        if (!ownsRelease(current, owner)) return { applied: false, reason: "owner-fenced" };
        if (current.state !== "publish" || current.currentGeneration !== generation.generation
            || this.#generation(current).identitySha256 !== generation.identitySha256
            || releaseIdentitySha256(current.selectedResults) !== releaseIdentitySha256(latest.selectedResults)
            || releaseIdentitySha256(current.publicationEffects) !== releaseIdentitySha256(latest.publicationEffects)) {
          return { applied: false, reason: "publication-boundary-changed" };
        }
        return this.store.transition(current.operationId, patch, {
          ...options, expectedRevision: current.revision, expectedOwner: owner,
        });
      };
      const boundary = await this.reservePublication({
        operation: latest,
        generation,
        reserve: () => transitionBoundary({
          publicationEffects: {
            ...latest.publicationEffects,
            generation: generation.generation,
            publishStarted: {
              generation: generation.generation,
              candidate: generation.identitySha256,
              at: this.now(),
            },
          },
          nextAction: "publish exact reserved generation",
        }, {
          emitEvent: false,
        }),
        recompose: () => transitionBoundary({
          state: "compose",
          currentStep: "compose",
          nextAction: "compose the accepted selection before publication",
          lastError: null,
        }, {
          eventKind: "operation.selection-changed",
        }),
      });
      if (!boundary.applied) throw new Error(`release publication reservation failed: ${boundary.reason}`);
      latest = boundary.operation;
      if (latest.state === "compose") return latest;
    }
    let effects = targetEffects(latest);
    for (const target of releaseApprovedTargets(latest)) {
      if (publishedTarget(effects[target.targetId])) continue;
      const stepId = `publish:${target.targetId}`;
      const input = { candidate: generation.identitySha256, target };
      const started = this.store.beginStep({
        operationId: latest.operationId,
        generation: generation.generation,
        stepId,
        input,
        expectedOwner: owner,
      });
      let effect = null;
      if (!started.created && started.receipt.status === "applied") effect = started.receipt.effect;
      if (!started.created && ["intent", "unknown"].includes(started.receipt.status)) {
        const readback = normalizeReadback(await this.readTarget({
          operation: latest, generation, target, receipt: started.receipt,
        }));
        if (publishedTarget(readback)) effect = readback;
        else if (readback.status === "unknown") {
          this.store.finishStep(started.receipt, { status: "unknown", effect: readback, reconcileCursor: readback.cursor ?? null, expectedOwner: owner });
          const error = new Error(`publication effect for ${target.targetId} is unknown`);
          error.code = "RELEASE_EXTERNAL_EFFECT_UNKNOWN";
          throw error;
        }
      }
      if (!effect) {
        try {
          this.#assertOwner(operation.operationId, owner);
          effect = normalizeReadback(await this.publishTarget({
            operation: latest, generation, target, receipt: started.receipt,
          }));
        } catch (cause) {
          const readback = normalizeReadback(await this.readTarget({
            operation: latest, generation, target, receipt: started.receipt, cause,
          }));
          if (publishedTarget(readback)) effect = readback;
          else {
            this.store.finishStep(started.receipt, {
              status: ["not_applied", "partial"].includes(readback.status) ? "failed" : "unknown",
              effect: readback,
              error: cause,
              reconcileCursor: readback.cursor ?? null,
              expectedOwner: owner,
            });
            if (readback.status === "not_applied") throw cause;
            if (readback.status === "partial") {
              const error = new Error(`publication target ${target.targetId} has a resumable partial effect`);
              error.code = "RELEASE_EXTERNAL_CONDITION";
              throw error;
            }
            const error = new Error(`publication effect for ${target.targetId} requires readback`);
            error.code = "RELEASE_EXTERNAL_EFFECT_UNKNOWN";
            throw error;
          }
        }
      }
      if (!publishedTarget(effect)) {
        const error = new Error(`publication target ${target.targetId} did not confirm its effect`);
        error.code = ["not_applied", "partial"].includes(effect.status)
          ? "RELEASE_EXTERNAL_CONDITION"
          : "RELEASE_EXTERNAL_EFFECT_UNKNOWN";
        this.store.finishStep(started.receipt, {
          status: ["not_applied", "partial"].includes(effect.status) ? "failed" : "unknown",
          effect,
          expectedOwner: owner,
        });
        throw error;
      }
      this.#assertOwner(operation.operationId, owner);
      this.store.finishStep(started.receipt, { status: "applied", effect, expectedOwner: owner });
      effects = { ...effects, [target.targetId]: effect };
      const beforeSave = this.store.get(latest.operationId);
      const saved = this.store.transition(beforeSave.operationId, {
        publicationEffects: { ...beforeSave.publicationEffects, generation: generation.generation, targets: effects },
        nextAction: "publish remaining authorized targets",
      }, {
        expectedRevision: beforeSave.revision,
        expectedOwner: owner,
        eventKind: "operation.target-published",
        event: { operationId: beforeSave.operationId, generation: generation.generation, targetId: target.targetId, effect },
      });
      if (!saved.applied) throw new Error("release operation changed while recording target publication");
      latest = saved.operation;
    }
    return this.#advance(operation.operationId, "finalize", { nextAction: "finalize exact published results" }, owner);
  }

  async #finalize(operation, owner) {
    const generation = this.#generation(operation);
    const started = this.store.beginStep({
      operationId: operation.operationId,
      generation: generation.generation,
      stepId: "finalize",
      input: {
        candidate: generation.identitySha256,
        effects: operation.publicationEffects,
        selectedResults: generation.selectedResults,
      },
      expectedOwner: owner,
    });
    if (!started.created && started.receipt.status === "applied") {
      return this.#advance(operation.operationId, "done", { lastError: null }, owner);
    }
    try {
      const effect = await this.finalize({ operation, generation });
      this.#assertOwner(operation.operationId, owner);
      this.store.finishStep(started.receipt, { status: "applied", effect: effect ?? { status: "completed" }, expectedOwner: owner });
      return this.#advance(operation.operationId, "done", { lastError: null }, owner);
    } catch (error) {
      this.store.finishStep(started.receipt, { status: "failed", error,
        ...(error?.finalization ? { effect: error.finalization } : {}), expectedOwner: owner });
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (!wrapped.code) wrapped.code = "RELEASE_EXTERNAL_CONDITION";
      throw wrapped;
    }
  }

  #generation(operation) {
    const generation = this.store.generation(operation.operationId, operation.currentGeneration);
    if (!generation) throw new Error("release operation has no immutable current generation");
    return generation;
  }

  #assertOwner(operationId, owner) {
    if (!ownsRelease(this.store.get(operationId), owner)) {
      const error = new Error("release operation owner epoch changed");
      error.code = "RELEASE_OWNER_FENCED";
      throw error;
    }
  }

  #advance(operationId, state, patch = {}, owner = null) {
    const current = this.store.get(operationId);
    const result = this.store.transition(operationId, {
      ...patch,
      state,
      currentStep: state === "done" ? null : state,
      attempt: current.attempt + 1,
      lastError: patch.lastError === undefined ? null : patch.lastError,
    }, {
      expectedRevision: current.revision,
      expectedOwner: owner,
      eventKind: state === "done" ? "operation.completed" : "operation.progress",
    });
    if (!result.applied) throw new Error(`release operation could not advance: ${result.reason}`);
    return result.operation;
  }
}
