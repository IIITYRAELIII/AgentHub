import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { normalizeCommandTraceSpan } from "../domain/command-trace-span.mjs";

export class CommandTraceService {
  constructor({
    store,
    clock = Date.now,
    monotonicClock = () => performance.now(),
    createSpanId = randomUUID,
    metadata = {},
    logger = console,
  }) {
    if (!store) throw new TypeError("store is required");
    this.store = store;
    this.clock = clock;
    this.monotonicClock = monotonicClock;
    this.createSpanId = createSpanId;
    this.metadata = { ...metadata };
    this.logger = logger;
  }

  record(input) {
    return this.store.append(normalizeCommandTraceSpan({ ...input, metadata: { ...input?.metadata, ...this.metadata } }, {
      clock: this.clock,
      createSpanId: this.createSpanId,
    }));
  }

  recordMany(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError("inputs must be an array");
    return this.store.appendMany(inputs.map((input) => normalizeCommandTraceSpan({ ...input, metadata: { ...input?.metadata, ...this.metadata } }, {
      clock: this.clock,
      createSpanId: this.createSpanId,
    })));
  }

  recordBestEffort(input) {
    if (!String(input?.commandId ?? "").trim()) return false;
    try {
      const span = normalizeCommandTraceSpan({ ...input, metadata: { ...input?.metadata, ...this.metadata } }, {
        clock: this.clock,
        createSpanId: this.createSpanId,
      });
      if (typeof this.store.appendBestEffort === "function") {
        return this.store.appendBestEffort(span);
      }
      this.#report(new Error("trace store has no off-main-thread best-effort boundary"));
      return false;
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  startBestEffortSpan(input) {
    if (!String(input?.commandId ?? "").trim()) {
      return Object.freeze({ spanId: null, startedAtMs: null, finish: () => false });
    }
    let spanId;
    let startedAtMs;
    let startedMonotonicMs;
    try {
      spanId = input.spanId ?? this.createSpanId();
      startedAtMs = this.clock();
      startedMonotonicMs = this.monotonicClock();
    } catch (error) {
      this.#report(error);
      return Object.freeze({ spanId: null, startedAtMs: null, finish: () => false });
    }
    if (input.recordStarted === true) {
      this.recordBestEffort({
        commandId: input.commandId, stage: input.stage, transport: input.transport,
        outcome: "started", observedAtMs: startedAtMs,
        metadata: { ...input.metadata, operationSpanId: spanId, startedAtMs },
      });
    }
    let finished = false;
    return Object.freeze({
      spanId,
      startedAtMs,
      finish: (details = {}) => {
        if (finished) return false;
        finished = true;
        try {
          return this.recordBestEffort({
            spanId,
            commandId: input.commandId,
            stage: input.stage,
            outcome: details.outcome,
            transport: input.transport,
            observedAtMs: details.observedAtMs ?? this.clock(),
            monotonicDurationMs: Math.max(0, this.monotonicClock() - startedMonotonicMs),
            queueDepth: details.queueDepth,
            lockWaitMs: details.lockWaitMs,
            sqliteBusyWaitMs: details.sqliteBusyWaitMs,
            metadata: { ...input.metadata, ...details.metadata, startedAtMs,
              ...(input.recordStarted === true ? { operationSpanId: spanId } : {}) },
          });
        } catch (error) {
          this.#report(error);
          return false;
        }
      },
    });
  }

  async measureBestEffort(input, operation) {
    const span = this.startBestEffortSpan({ ...input, recordStarted: true });
    try {
      const result = await operation();
      span.finish({ outcome: "succeeded" });
      return result;
    } catch (error) {
      // Error messages can contain prompts, paths and credentials. The owning
      // service retains its existing error reporting; timing records only state.
      span.finish({ outcome: "failed" });
      throw error;
    }
  }

  startSpan({ commandId, stage, transport, spanId = this.createSpanId(), metadata = {} }) {
    const startedAtMs = this.clock();
    const startedMonotonicMs = this.monotonicClock();
    let finished = false;
    return Object.freeze({
      spanId,
      startedAtMs,
      finish: async ({
        outcome,
        observedAtMs = this.clock(),
        queueDepth = null,
        lockWaitMs = null,
        sqliteBusyWaitMs = null,
        metadata: finishMetadata = {},
      } = {}) => {
        if (finished) throw new Error(`command trace span ${spanId} is already finished`);
        finished = true;
        try {
          return await this.record({
            spanId,
            commandId,
            stage,
            outcome,
            transport,
            observedAtMs,
            monotonicDurationMs: Math.max(0, this.monotonicClock() - startedMonotonicMs),
            queueDepth,
            lockWaitMs,
            sqliteBusyWaitMs,
            metadata: { ...metadata, ...finishMetadata, startedAtMs },
          });
        } catch (error) {
          finished = false;
          throw error;
        }
      },
    });
  }

  readCommandTimeline(commandId, options = {}) {
    return this.store.readCommandTimeline(commandId, options);
  }

  readStagePercentiles(query = {}) {
    return this.store.readStagePercentiles(query);
  }

  prune() {
    return this.store.prune();
  }

  backpressureStats() {
    return this.store.stats?.() ?? null;
  }

  #report(error) {
    try {
      this.logger?.warn?.(`Command trace write skipped: ${error?.message ?? error}`);
    } catch {
      // Diagnostics must never alter the command outcome.
    }
  }
}
