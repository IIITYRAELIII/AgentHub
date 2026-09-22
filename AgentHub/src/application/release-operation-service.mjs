import { randomUUID } from "node:crypto";

import {
  createCandidateGeneration,
  RELEASE_OPERATION_STATES,
  releaseIdentitySha256,
  releaseOperationIsTerminal,
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

  constructor({
    store,
    compose,
    validate,
    publishTarget,
    readTarget,
    finalize,
    deliverEvent = null,
    schedule = (operation) => setImmediate(operation),
    ownerId = `release-worker-${process.pid}-${randomUUID()}`,
    runnerVersion = "release-operation-v1",
    now = () => new Date().toISOString(),
    leaseMs = DEFAULT_LEASE_MS,
    retryDelayMs = DEFAULT_RETRY_MS,
  } = {}) {
    for (const name of [
      "create", "get", "snapshot", "transition", "acquire", "heartbeat", "release",
      "putGeneration", "generation", "beginStep", "finishStep", "latestStep",
      "runnable", "active", "forTask", "pendingEvents", "settleEvent",
    ]) requiredMethod(store, name);
    for (const [value, name] of [
      [compose, "compose"], [validate, "validate"], [publishTarget, "publishTarget"],
      [readTarget, "readTarget"], [finalize, "finalize"],
    ]) {
      if (typeof value !== "function") throw new TypeError(`${name} is required`);
    }
    if (deliverEvent != null && typeof deliverEvent !== "function") throw new TypeError("deliverEvent must be a function");
    if (typeof schedule !== "function") throw new TypeError("schedule is required");
    this.store = store;
    this.compose = compose;
    this.validate = validate;
    this.publishTarget = publishTarget;
    this.readTarget = readTarget;
    this.finalize = finalize;
    this.deliverEvent = deliverEvent;
    this.scheduleTask = schedule;
    this.ownerId = requiredText(ownerId, "ownerId");
    this.runnerVersion = requiredText(runnerVersion, "runnerVersion");
    this.now = now;
    this.leaseMs = Math.max(100, Number(leaseMs) || DEFAULT_LEASE_MS);
    this.retryDelayMs = Math.max(1_000, Number(retryDelayMs) || DEFAULT_RETRY_MS);
  }

  start({ requestId, workspaceId, streamId, threadId, authorization } = {}) {
    const created = this.store.create({
      requestId, workspaceId, streamId, threadId, authorization,
      runnerVersion: this.runnerVersion,
    });
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
    void this.deliverPendingEvents().catch(() => {});
  }

  get(operationId) {
    const snapshot = this.store.snapshot(requiredText(operationId, "operationId"));
    if (!snapshot) throw new Error("release operation was not found");
    return snapshot;
  }

  continue(operationId) {
    const current = this.store.get(requiredText(operationId, "operationId"));
    if (!current) throw new Error("release operation was not found");
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

  wakeForTask(taskId) {
    const operations = this.store.forTask(requiredText(taskId, "taskId"));
    const accepted = [];
    for (const operation of operations) {
      if (releaseOperationIsTerminal(operation)) continue;
      if (operation.state === "waiting" && ["validation_failed", "correction_required"].includes(operation.waitReason?.code)) {
        const resumed = this.continue(operation.operationId);
        if (resumed.accepted) accepted.push(operation.operationId);
      }
    }
    return accepted;
  }

  recover() {
    const operations = this.store.active();
    for (const operation of operations) {
      if (operation.state === "waiting") this.#scheduleRetry(operation);
      else this.#schedule(operation.operationId);
    }
    return { scheduled: operations.map((operation) => operation.operationId) };
  }

  async deliverPendingEvents({ limit = 100 } = {}) {
    if (!this.deliverEvent) return { delivered: 0, failed: 0, skipped: true };
    let delivered = 0;
    let failed = 0;
    for (const event of this.store.pendingEvents({ limit })) {
      try {
        await this.deliverEvent(event);
        this.store.settleEvent(event, { delivered: true });
        delivered += 1;
      } catch (error) {
        this.store.settleEvent(event, { delivered: false, error });
        failed += 1;
      }
    }
    return { delivered, failed };
  }

  async drain(operationId) {
    const id = requiredText(operationId, "operationId");
    while (this.#scheduled.has(id) || this.#running.has(id)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.get(id);
  }

  #schedule(operationId) {
    const timer = this.#retryTimers.get(operationId);
    if (timer) clearTimeout(timer);
    this.#retryTimers.delete(operationId);
    if (this.#scheduled.has(operationId) || this.#running.has(operationId)) return;
    this.#scheduled.add(operationId);
    this.scheduleTask(() => {
      this.#scheduled.delete(operationId);
      void this.#run(operationId);
    });
  }

  async #run(operationId) {
    if (this.#running.has(operationId)) return;
    this.#running.add(operationId);
    let owned = false;
    let heartbeat = null;
    try {
      const acquired = this.store.acquire(operationId, this.ownerId, { leaseMs: this.leaseMs });
      if (!acquired.acquired) return;
      owned = true;
      heartbeat = setInterval(() => {
        try { this.store.heartbeat(operationId, this.ownerId, { leaseMs: this.leaseMs }); } catch {}
      }, Math.max(50, Math.floor(this.leaseMs / 3)));
      heartbeat.unref?.();
      let operation = acquired.operation;
      while (operation && !releaseOperationIsTerminal(operation) && operation.state !== "waiting") {
        this.store.heartbeat(operationId, this.ownerId, { leaseMs: this.leaseMs });
        try {
          if (operation.state === "compose") operation = await this.#compose(operation);
          else if (operation.state === "validate") operation = await this.#validate(operation);
          else if (operation.state === "publish") operation = await this.#publish(operation);
          else if (operation.state === "finalize") operation = await this.#finalize(operation);
          else throw new Error(`unsupported release operation state: ${operation.state}`);
        } catch (error) {
          const latest = this.store.get(operationId) ?? operation;
          const patch = classifiedFailure(error, latest.state, this.now, this.retryDelayMs);
          const failed = this.store.transition(operationId, patch, {
            expectedRevision: latest.revision,
            eventKind: patch.state === "waiting" ? "operation.waiting" : "operation.failed",
          });
          operation = failed.operation;
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (owned) this.store.release(operationId, this.ownerId);
      this.#running.delete(operationId);
      const current = this.store.get(operationId);
      if (current?.state === "waiting") this.#scheduleRetry(current);
      await this.deliverPendingEvents().catch(() => {});
    }
  }

  #scheduleRetry(operation) {
    const retryAtMs = Date.parse(String(operation?.waitReason?.retryAt ?? ""));
    if (!Number.isFinite(retryAtMs)) return;
    const delay = Math.max(0, retryAtMs - Date.parse(this.now()));
    const existing = this.#retryTimers.get(operation.operationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#retryTimers.delete(operation.operationId);
      const current = this.store.get(operation.operationId);
      if (current?.state !== "waiting" || current.revision !== operation.revision) return;
      this.continue(operation.operationId);
    }, Math.min(delay, 2_147_000_000));
    timer.unref?.();
    this.#retryTimers.set(operation.operationId, timer);
  }

  async #compose(operation) {
    const generationNumber = operation.currentGeneration + 1;
    const input = {
      authorization: operation.authorization,
      priorGeneration: operation.currentGeneration,
    };
    const started = this.store.beginStep({
      operationId: operation.operationId,
      generation: generationNumber,
      stepId: "compose",
      input,
    });
    const existingGeneration = this.store.generation(operation.operationId, generationNumber);
    if (!started.created && ["intent", "unknown"].includes(started.receipt.status) && existingGeneration) {
      this.store.finishStep(started.receipt, {
        status: "applied",
        effect: { identitySha256: existingGeneration.identitySha256 },
      });
      return this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: existingGeneration.selectedResults,
        nextAction: "validate immutable candidate generation",
      });
    }
    if (!started.created && started.receipt.status === "unknown") {
      const error = new Error("composition intent has no authoritative local outcome");
      error.code = "RELEASE_CORRECTION_REQUIRED";
      throw error;
    }
    if (!started.created && started.receipt.status === "applied") {
      const generation = this.store.generation(operation.operationId, generationNumber);
      if (!generation || generation.identitySha256 !== started.receipt.effect?.identitySha256) {
        throw new Error("composed generation receipt does not match immutable candidate evidence");
      }
      return this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: generation.selectedResults,
        nextAction: "validate immutable candidate generation",
      });
    }
    try {
      const composed = await this.compose({ operation, generation: generationNumber });
      const generation = createCandidateGeneration({
        ...composed,
        operationId: operation.operationId,
        generation: generationNumber,
        supersedesGeneration: operation.currentGeneration || null,
        runnerVersion: operation.runnerVersion,
        createdAt: started.receipt.createdAt,
      });
      this.store.putGeneration(generation);
      this.store.finishStep(started.receipt, {
        status: "applied",
        effect: { identitySha256: generation.identitySha256 },
      });
      return this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: generation.selectedResults,
        nextAction: "validate immutable candidate generation",
      });
    } catch (error) {
      this.store.finishStep(started.receipt, { status: "failed", error });
      throw error;
    }
  }

  async #validate(operation) {
    const generation = this.#generation(operation);
    const started = this.store.beginStep({
      operationId: operation.operationId,
      generation: generation.generation,
      stepId: "validate",
      input: { candidate: generation.identitySha256, mode: operation.authorization.validationMode },
    });
    if (!started.created && started.receipt.status === "applied") {
      return this.#advance(operation.operationId, "publish", { nextAction: "publish authorized targets" });
    }
    try {
      const evidence = await this.validate({ operation, generation });
      this.store.finishStep(started.receipt, { status: "applied", effect: evidence ?? { status: "passed" } });
      return this.#advance(operation.operationId, "publish", { nextAction: "publish authorized targets" });
    } catch (cause) {
      this.store.finishStep(started.receipt, { status: "failed", error: cause });
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!error.code) error.code = "RELEASE_VALIDATION_FAILED";
      throw error;
    }
  }

  async #publish(operation) {
    const generation = this.#generation(operation);
    let latest = this.store.get(operation.operationId);
    let effects = targetEffects(latest);
    for (const target of latest.authorization.approvedTargets) {
      if (publishedTarget(effects[target.targetId])) continue;
      const stepId = `publish:${target.targetId}`;
      const input = { candidate: generation.identitySha256, target };
      const started = this.store.beginStep({
        operationId: latest.operationId,
        generation: generation.generation,
        stepId,
        input,
      });
      let effect = null;
      if (!started.created && ["intent", "unknown"].includes(started.receipt.status)) {
        const readback = normalizeReadback(await this.readTarget({
          operation: latest, generation, target, receipt: started.receipt,
        }));
        if (publishedTarget(readback)) effect = readback;
        else if (readback.status === "unknown") {
          this.store.finishStep(started.receipt, { status: "unknown", effect: readback, reconcileCursor: readback.cursor ?? null });
          const error = new Error(`publication effect for ${target.targetId} is unknown`);
          error.code = "RELEASE_EXTERNAL_EFFECT_UNKNOWN";
          throw error;
        }
      }
      if (!effect) {
        try {
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
        });
        throw error;
      }
      this.store.finishStep(started.receipt, { status: "applied", effect });
      effects = { ...effects, [target.targetId]: effect };
      const beforeSave = this.store.get(latest.operationId);
      const saved = this.store.transition(beforeSave.operationId, {
        publicationEffects: { ...beforeSave.publicationEffects, generation: generation.generation, targets: effects },
        nextAction: "publish remaining authorized targets",
      }, {
        expectedRevision: beforeSave.revision,
        eventKind: "operation.target-published",
        event: { operationId: beforeSave.operationId, generation: generation.generation, targetId: target.targetId, effect },
      });
      if (!saved.applied) throw new Error("release operation changed while recording target publication");
      latest = saved.operation;
    }
    return this.#advance(operation.operationId, "finalize", { nextAction: "finalize exact published results" });
  }

  async #finalize(operation) {
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
    });
    if (!started.created && started.receipt.status === "applied") {
      return this.#advance(operation.operationId, "done", { lastError: null });
    }
    try {
      const effect = await this.finalize({ operation, generation });
      this.store.finishStep(started.receipt, { status: "applied", effect: effect ?? { status: "completed" } });
      return this.#advance(operation.operationId, "done", { lastError: null });
    } catch (error) {
      this.store.finishStep(started.receipt, { status: "failed", error });
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

  #advance(operationId, state, patch = {}) {
    const current = this.store.get(operationId);
    const result = this.store.transition(operationId, {
      ...patch,
      state,
      currentStep: state === "done" ? null : state,
      attempt: current.attempt + 1,
      lastError: patch.lastError === undefined ? null : patch.lastError,
    }, {
      expectedRevision: current.revision,
      eventKind: state === "done" ? "operation.completed" : "operation.progress",
    });
    if (!result.applied) throw new Error(`release operation could not advance: ${result.reason}`);
    return result.operation;
  }
}
