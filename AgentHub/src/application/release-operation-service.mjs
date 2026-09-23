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
    processAlive = (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    processId = process.pid,
    deliveryRetryMs = 1_000,
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
    if (typeof reservePublication !== "function") throw new TypeError("reservePublication must be a function");
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
    this.#scheduleDelivery(0);
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
    const selectedTaskId = requiredText(taskId, "taskId");
    const accepted = this.prepareForTaskAcceptance(selectedTaskId).map((item) => item.operationId);
    const operations = this.store.forTask(selectedTaskId);
    for (const operation of operations) {
      if (releaseOperationIsTerminal(operation)) continue;
      if (operation.state === "waiting" && ["validation_failed", "correction_required"].includes(operation.waitReason?.code)) {
        const resumed = this.continue(operation.operationId);
        if (resumed.accepted && !accepted.includes(operation.operationId)) accepted.push(operation.operationId);
      }
    }
    return accepted;
  }

  prepareForTaskAcceptance(taskId) {
    const operations = this.store.forTask(requiredText(taskId, "taskId"));
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
    if (this.#deliveryRunning) return { delivered: 0, failed: 0, skipped: true };
    this.#deliveryRunning = true;
    let delivered = 0;
    let failed = 0;
    let read = 0;
    let retryAttempt = 0;
    try {
      const events = this.store.pendingEvents({ limit });
      read = events.length;
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
    let owner = null;
    let heartbeat = null;
    try {
      const prior = this.store.get(operationId);
      const takeoverAllowed = Boolean(prior?.owner?.processId && !this.processAlive(prior.owner.processId));
      const acquired = this.store.acquire(operationId, this.ownerId, {
        leaseMs: this.leaseMs, processId: this.processId, takeoverAllowed,
      });
      if (!acquired.acquired) return;
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
          const latest = this.store.get(operationId) ?? operation;
          if (!ownsRelease(latest, owner)) break;
          const patch = classifiedFailure(error, latest.state, this.now, this.retryDelayMs);
          const failed = this.store.transition(operationId, patch, {
            expectedRevision: latest.revision,
            expectedOwner: owner,
            eventKind: patch.state === "waiting" ? "operation.waiting" : "operation.failed",
          });
          operation = failed.operation;
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (owned) this.store.release(operationId, owner);
      this.#running.delete(operationId);
      const current = this.store.get(operationId);
      if (current?.state === "waiting") this.#scheduleRetry(current);
      else if (current && !releaseOperationIsTerminal(current)) this.#schedule(operationId);
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

  async #compose(operation, owner) {
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
      expectedOwner: owner,
    });
    const existingGeneration = this.store.generation(operation.operationId, generationNumber);
    if (!started.created && ["intent", "unknown"].includes(started.receipt.status) && existingGeneration) {
      this.store.finishStep(started.receipt, {
        status: "applied",
        effect: { identitySha256: existingGeneration.identitySha256 },
        expectedOwner: owner,
      });
      return this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: existingGeneration.selectedResults,
        nextAction: "validate immutable candidate generation",
      }, owner);
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
      return this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: generation.selectedResults,
        nextAction: "validate immutable candidate generation",
      }, owner);
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
      this.store.putGeneration(generation, { expectedOwner: owner });
      this.store.finishStep(started.receipt, {
        status: "applied",
        effect: { identitySha256: generation.identitySha256 }, expectedOwner: owner,
      });
      return this.#advance(operation.operationId, "validate", {
        currentGeneration: generationNumber,
        selectedResults: generation.selectedResults,
        nextAction: "validate immutable candidate generation",
      }, owner);
    } catch (error) {
      this.store.finishStep(started.receipt, { status: "failed", error, expectedOwner: owner });
      throw error;
    }
  }

  async #validate(operation, owner) {
    const generation = this.#generation(operation);
    const started = this.store.beginStep({
      operationId: operation.operationId,
      generation: generation.generation,
      stepId: "validate",
      input: { candidate: generation.identitySha256, mode: operation.authorization.validationMode },
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
    if (!latest.publicationEffects?.publishStarted) {
      const boundary = await this.reservePublication({
        operation: latest,
        generation,
        reserve: () => this.store.transition(latest.operationId, {
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
          expectedRevision: latest.revision,
          expectedOwner: owner,
          emitEvent: false,
        }),
        recompose: () => this.store.transition(latest.operationId, {
          state: "compose",
          currentStep: "compose",
          nextAction: "compose the accepted selection before publication",
          lastError: null,
        }, {
          expectedRevision: latest.revision,
          expectedOwner: owner,
          eventKind: "operation.selection-changed",
        }),
      });
      if (!boundary.applied) throw new Error(`release publication reservation failed: ${boundary.reason}`);
      latest = boundary.operation;
      if (latest.state === "compose") return latest;
    }
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
      this.store.finishStep(started.receipt, { status: "failed", error, expectedOwner: owner });
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
