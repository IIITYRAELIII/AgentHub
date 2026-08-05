import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { withInterprocessLocks } from "./src/infrastructure/process/interprocess-lock.mjs";
import { writeTextAtomic } from "./state-store.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function commandFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export class DurableCommandRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = "DurableCommandRetryableError";
    this.code = "DURABLE_COMMAND_RETRYABLE";
  }
}

function serializedResult(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function defaultProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class DurableCommandReceipts {
  #file;
  #maxItems;
  #maxPending;
  #records = new Map();
  #loaded = false;
  #inFlight = new Map();
  #isProcessAlive;
  #effectWaitMs;
  #effectWaitTimeoutMs;
  #effectStaleMs;
  #effectMaxAgeMs;

  constructor({
    file,
    maxItems = 2_000,
    maxPending = 500,
    isProcessAlive = defaultProcessAlive,
    effectWaitMs = 25,
    effectWaitTimeoutMs = 30_000,
    effectStaleMs = 60_000,
    effectMaxAgeMs = 5 * 60_000,
  }) {
    this.#file = path.resolve(file);
    this.#maxItems = Math.max(100, Math.trunc(maxItems) || 2_000);
    this.#maxPending = Math.max(10, Math.trunc(maxPending) || 500);
    this.#isProcessAlive = isProcessAlive;
    this.#effectWaitMs = Math.max(1, Math.trunc(effectWaitMs) || 25);
    this.#effectWaitTimeoutMs = Math.max(this.#effectWaitMs, Math.trunc(effectWaitTimeoutMs) || 30_000);
    this.#effectStaleMs = Math.max(0, Number.isFinite(Number(effectStaleMs))
      ? Math.trunc(effectStaleMs)
      : 60_000);
    this.#effectMaxAgeMs = Math.max(this.#effectWaitTimeoutMs, Number.isFinite(Number(effectMaxAgeMs))
      ? Math.trunc(effectMaxAgeMs)
      : 5 * 60_000);
  }

  async #load({ fresh = false } = {}) {
    if (this.#loaded && !fresh) return;
    const records = new Map();
    try {
      const value = JSON.parse(await readFile(this.#file, "utf8"));
      if (value?.version !== 1 || !Array.isArray(value.records)) {
        throw new Error("invalid durable command receipt journal");
      }
      for (const record of value.records) {
        if (!record || typeof record.id !== "string" || typeof record.fingerprint !== "string") {
          throw new Error("invalid durable command receipt record");
        }
        records.set(record.id, record);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.#records = records;
    this.#loaded = true;
  }

  async #persist() {
    const ordered = [...this.#records.values()]
      .sort((left, right) => Number(left.updatedAtMs) - Number(right.updatedAtMs));
    // Never evict a prepared/effect-started receipt: dropping it could turn a
    // replay into a second external side effect. Terminal results are bounded.
    const pending = ordered.filter((record) => ["prepared", "effect-started"].includes(record.phase));
    const terminal = ordered.filter((record) => !["prepared", "effect-started"].includes(record.phase));
    // A pending receipt may resolve after the terminal capacity has filled.
    // Retain it rather than dropping a completed external effect; admission of
    // new effects is still bounded in #execute.
    if (pending.length > this.#maxPending) {
      throw new Error("durable command receipt journal exceeds its bounded capacity");
    }
    const records = [...pending, ...terminal];
    this.#records = new Map(records.map((record) => [record.id, record]));
    await mkdir(path.dirname(this.#file), { recursive: true });
    await writeTextAtomic(this.#file, `${JSON.stringify({ version: 1, records }, null, 2)}\n`);
  }

  #withLock(operation) {
    return withInterprocessLocks([this.#file], async () => {
      await this.#load({ fresh: true });
      return operation();
    });
  }

  #effectOwnerIsLive(record) {
    const owner = record?.effectOwner;
    const startedAtMs = Number(record?.effectStartedAtMs ?? record?.updatedAtMs ?? 0);
    if (Date.now() - startedAtMs >= this.#effectMaxAgeMs) return false;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) return this.#isProcessAlive(owner.pid);
    return Date.now() - startedAtMs < this.#effectStaleMs;
  }

  async #settle(commandId, fingerprint, { result, phase = "completed", error = null, effectToken = null }) {
    return this.#withLock(async () => {
      const record = this.#records.get(commandId);
      if (!record || record.fingerprint !== fingerprint) {
        throw new Error("durable command receipt changed while the effect was running");
      }
      if (record.phase === "completed" || record.phase === "reconciled") return record.result;
      if (record.phase === "failed") throw new Error(record.error || "command failed");
      if (effectToken && record.effectOwner?.token !== effectToken) {
        throw new Error("durable command effect ownership changed while it was running");
      }
      if (record.phase !== "effect-started") {
        throw new Error("durable command receipt is not awaiting an effect");
      }
      record.phase = error ? "failed" : phase;
      if (error) {
        record.error = String(error?.message ?? error ?? "command failed").slice(0, 4_096);
        delete record.result;
      } else {
        record.result = serializedResult(result);
        delete record.error;
      }
      record.updatedAtMs = Date.now();
      delete record.effectOwner;
      delete record.effectStartedAtMs;
      await this.#persist();
      if (error) throw new Error(record.error);
      return record.result;
    });
  }

  async execute({ id, fingerprint, action, effect, reconcile = null }) {
    const commandId = String(id ?? "").trim();
    const requestFingerprint = String(fingerprint ?? "").trim();
    if (!commandId || !requestFingerprint || typeof effect !== "function") {
      throw new Error("durable command receipt requires id, fingerprint and effect");
    }
    if (this.#inFlight.has(commandId)) return this.#inFlight.get(commandId);
    const operation = this.#execute(
      { commandId, requestFingerprint, action, effect, reconcile },
      Date.now() + this.#effectWaitTimeoutMs,
    );
    this.#inFlight.set(commandId, operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(commandId);
    }
  }

  async forget(id) {
    return this.#withLock(async () => {
      if (!this.#records.delete(String(id ?? "").trim())) return false;
      await this.#persist();
      return true;
    });
  }

  async #execute({ commandId, requestFingerprint, action, effect, reconcile }, deadline) {
    const decision = await this.#withLock(async () => {
      let record = this.#records.get(commandId);
      if (record && record.fingerprint !== requestFingerprint) {
        throw new Error("durable command receipt fingerprint conflict");
      }
      if (record?.phase === "completed" || record?.phase === "reconciled") {
        return { kind: "result", result: record.result };
      }
      if (record?.phase === "failed") throw new Error(record.error || "command failed");
      if (record?.phase === "effect-started") {
        return this.#effectOwnerIsLive(record)
          ? { kind: "wait" }
          : { kind: "reconcile", record: { ...record } };
      }
      if (!record) {
        const pendingCount = [...this.#records.values()]
          .filter((item) => ["prepared", "effect-started"].includes(item.phase)).length;
        if (pendingCount >= this.#maxPending) {
          throw new Error("durable command receipt capacity is exhausted by unresolved effects");
        }
        const terminalCount = [...this.#records.values()]
          .filter((item) => !["prepared", "effect-started"].includes(item.phase)).length;
        if (terminalCount >= this.#maxItems) {
          throw new Error("durable command receipt capacity is exhausted by unacknowledged results");
        }
        record = {
          id: commandId,
          fingerprint: requestFingerprint,
          action: String(action ?? ""),
          phase: "prepared",
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        };
        this.#records.set(commandId, record);
      }
      record.phase = "effect-started";
      record.updatedAtMs = Date.now();
      record.effectStartedAtMs = record.updatedAtMs;
      record.effectOwner = { token: randomUUID(), pid: process.pid };
      await this.#persist();
      return { kind: "effect", effectToken: record.effectOwner.token };
    });
    if (decision.kind === "result") return decision.result;
    if (decision.kind === "wait") {
      if (Date.now() >= deadline) {
        throw new DurableCommandRetryableError("command effect is still active in another process");
      }
      await delay(Math.min(this.#effectWaitMs, Math.max(1, deadline - Date.now())));
      return this.#execute({ commandId, requestFingerprint, action, effect, reconcile }, deadline);
    }
    if (decision.kind === "reconcile") {
      if (typeof reconcile !== "function") {
        return this.#settle(commandId, requestFingerprint, {
          error: "command outcome is unknown after an interrupted effect",
        });
      }
      try {
        const reconciliation = await reconcile(decision.record);
        if (!reconciliation?.resolved) {
          if (reconciliation?.terminal === true) {
            return this.#settle(commandId, requestFingerprint, {
              error: reconciliation.error || "command outcome is unknown after an interrupted effect",
            });
          }
          throw new DurableCommandRetryableError(
            reconciliation?.error || "command reconciliation is not complete",
          );
        }
        return this.#settle(commandId, requestFingerprint, {
          result: reconciliation.result,
          phase: "reconciled",
        });
      } catch (error) {
        if (error instanceof DurableCommandRetryableError) throw error;
        return this.#settle(commandId, requestFingerprint, { error });
      }
    }
    let result;
    try {
      result = await effect();
    } catch (error) {
      return this.#settle(commandId, requestFingerprint, { error, effectToken: decision.effectToken });
    }
    return this.#settle(commandId, requestFingerprint, { result, effectToken: decision.effectToken });
  }
}
