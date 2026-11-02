import { createHash, randomUUID } from "node:crypto";
import { MAINTENANCE_OPERATION_KINDS } from "../domain/maintenance-operation.mjs";
import { AsyncSqliteMutationQueue } from "../infrastructure/persistence/async-sqlite-mutation-queue.mjs";

export const STORAGE_RETENTION_VERSION = 1;
export const STORAGE_RETENTION_POLICY_VERSION = 4;
const KIND = MAINTENANCE_OPERATION_KINDS.STORAGE_RETENTION;
const ROOT_ID = `storage-retention:v${STORAGE_RETENTION_VERSION}`;
const SCOPE = Object.freeze({ streamId: "agent-hub-runtime", threadId: "storage-retention" });
const TIMER = "storage-retention";
const TERMINAL = new Set(["succeeded", "failed"]);
const OUTCOMES = new Set(["removed", "already-removed", "retained", "unknown", "partial"]);

function bounded(value, bytes = 64 * 1024) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > bytes) throw new Error("retention-binding-budget");
  return JSON.parse(encoded);
}

function reason(value) {
  return /^[a-z0-9-]{1,64}$/u.test(String(value ?? "")) ? value : "owner-unavailable";
}

function running(operation) {
  return operation.status === "reconciling" ? "reconciling" : "running";
}

function summary() {
  return { removed: 0, alreadyRemoved: 0, logicalBytes: 0, retained: 0, reasons: {} };
}

// The scheduler owns only cadence/cursors/intent. Each artifact owner supplies
// eligibility, its leases, fresh effect guards and authoritative reconciliation.
// No filesystem sweep or deletion authority lives in this service.
export class StorageRetentionService {
  #flight = null;
  #stopped = true;
  #closed = false;
  #last = { state: "not-run" };
  #mutations = new AsyncSqliteMutationQueue();

  constructor({ store, owners, readContext, withLease, timers = null,
    isStopping = () => false, now = () => new Date(), clock = () => performance.now(),
    intervalMs = 6 * 60 * 60_000, budgetMs = 20_000, maxUnits = 3, logger = console } = {}) {
    for (const name of ["get", "create", "transition", "activeFor", "settle"]) {
      if (typeof store?.[name] !== "function") throw new TypeError(`Retention store requires ${name}`);
    }
    if (!Array.isArray(owners) || owners.length > 16 || new Set(owners.map(o => o.id)).size !== owners.length
        || typeof readContext !== "function" || typeof withLease !== "function") throw new TypeError("Invalid retention owners/context/lease");
    for (const owner of owners) {
      if (!/^[a-z0-9-]{1,48}$/u.test(owner.id)
          || ["list", "preview", "prune", "reconcile"].some(name => typeof owner[name] !== "function")) {
        throw new TypeError("Retention owner must implement bounded discovery, preview, effect and reconciliation");
      }
    }
    Object.assign(this, { store, owners, readContext, withLease, timers, isStopping, now, clock, logger });
    this.intervalMs = Math.max(60_000, Number(intervalMs) || 6 * 60 * 60_000);
    this.budgetMs = Math.min(20_000, Math.max(1, Number(budgetMs) || 20_000));
    this.maxUnits = Math.min(3, Math.max(1, Math.trunc(Number(maxUnits) || 3)));
  }

  status() {
    return { ...structuredClone(this.#last), owners: Object.fromEntries(this.owners
      .filter(owner => typeof owner.status === "function").map(owner => [owner.id, owner.status()])) };
  }

  scheduleInitial() {
    this.#stopped = false;
    this.#closed = false;
    this.#schedule(5_000);
  }

  #schedule(delay) {
    if (this.#stopped || (this.#closed || this.isStopping())) return;
    this.timers?.schedule(TIMER, () => {
      void this.runOnce().catch(() => {
        this.#last = { state: "deferred", reason: "owner-unavailable", retry: true };
        this.logger.warn?.("Storage retention deferred; original owner intents are retained.");
      }).finally(() => this.#schedule(this.#last.more ? 10_000 : this.#last.pending || this.#last.retry ? 60_000 : this.intervalMs));
    }, delay);
  }

  stop() { this.#closed = true; this.#stopped = true; this.timers?.clear?.(TIMER); }
  async close() { this.stop(); await this.#flight; }

  runOnce() {
    if (this.#flight) return this.#flight;
    this.#flight = Promise.resolve().then(() => this.withLease(lease => this.#run(lease)))
      .finally(() => { this.#flight = null; });
    return this.#flight;
  }

  // An explicit operational consumer may confirm only exact owner previews.
  // This shares the scheduler's original intents/lease; it neither discovers
  // additional artifacts nor advances the background discovery cursor.
  runApproved(previews) {
    if (!Array.isArray(previews) || !previews.length || previews.length > this.maxUnits) {
      throw new TypeError("Approved retention requires a bounded nonempty preview list");
    }
    const approved = previews.map(value => bounded(value));
    const identities = new Set();
    for (const item of approved) {
      const key = `${item.ownerId}:${item.candidate?.id}`;
      if (!this.owners.some(owner => owner.id === item.ownerId)
          || typeof item.candidate?.id !== "string" || !item.candidate.id
          || typeof item.candidate.cursor !== "string" || !item.binding
          || identities.has(key)) throw new TypeError("Invalid approved retention binding");
      identities.add(key);
    }
    if (this.#flight) throw new Error("Retention owner is already running");
    this.#flight = Promise.resolve().then(() => this.withLease(lease => this.#run(lease, approved)))
      .finally(() => { this.#flight = null; });
    return this.#flight;
  }

  // Retry only canonical SQL bookkeeping, never owner preview/effect/reconcile.
  // A contended create keeps its original identity throughout the bounded wait.
  #write(lease, operation, requestId) {
    return this.#mutations.run(async () => {
      await lease.assertOwned();
      return operation();
    }, { requestId });
  }

  #create(lease, input) {
    const original = { ...input, operationId: input.operationId ?? randomUUID() };
    return this.#write(lease, () => this.store.create(original), original.operationId);
  }

  async #update(operation, patch, lease) {
    const result = await this.#write(lease, () => this.store.transition(operation.operationId, patch,
      { expectedRevision: operation.revision }), operation.operationId);
    if (!result.applied) throw new Error("retention-owner-fenced");
    return result.operation;
  }

  async #unit(owner, candidate, context, lease, record = null, approvedBinding = null) {
    const scope = `${owner.id}:${createHash("sha256").update(candidate.id).digest("hex")}`;
    let child = record ? this.store.get(record.operationId) : this.store.activeFor({ kind: KIND, ...SCOPE, threadId: scope });
    if (record && !child) return { result: { status: "unknown", reason: "original-intent-unavailable" } };
    if (child) {
      if (child.metadata?.owner !== owner.id || child.metadata?.candidate?.id !== candidate.id
          || child.metadata?.version !== STORAGE_RETENTION_VERSION) throw new Error("retention-owner-binding");
      if (TERMINAL.has(child.status)) return { child, result: child.metadata.result ?? { status: "unknown" } };
      if (child.metadata.admitted) {
        if (approvedBinding && JSON.stringify(approvedBinding) !== JSON.stringify(child.metadata.binding)) {
          return { child, result: { status: "unknown", reason: "approved-original-binding-changed" } };
        }
        await lease.assertOwned();
        let result;
        try {
          result = await owner.reconcile({ candidate: child.metadata.candidate, binding: child.metadata.binding,
            operationId: child.operationId, context });
        } catch { result = { status: "unknown", reason: "owner-outcome-unknown" }; }
        return { child, result: bounded(result) };
      }
    }
    const preview = await owner.preview({ candidate, context });
    if (preview?.status !== "eligible") return { child, result: { status: "retained", reason: reason(preview?.reason) } };
    const binding = bounded(preview.binding);
    if (approvedBinding && JSON.stringify(approvedBinding) !== JSON.stringify(binding)) {
      return { child, result: { status: "retained", reason: "approved-preview-changed" } };
    }
    if (child && JSON.stringify(binding) !== JSON.stringify(child.metadata.binding)) {
      return { child, result: { status: "retained", reason: "preview-changed" } };
    }
    return { child, prepared: { candidate: bounded(candidate, 4096), binding, scope } };
  }

  async #run(lease, approved = null) {
    const started = this.clock();
    let used = 0;
    const context = structuredClone(await this.readContext());
    if (!context?.ready || !context?.releaseId || context?.isolated || context?.busy || (this.#closed || this.isStopping())) {
      return this.#last = { state: "deferred", reason: "runtime-not-ready-or-isolated", retry: Boolean(context?.releaseId && !context?.isolated) };
    }
    await lease.assertOwned();
    let parent = this.store.get(ROOT_ID) ?? await this.#create(lease, { operationId: ROOT_ID, kind: KIND, ...SCOPE,
      metadata: { version: STORAGE_RETENTION_VERSION, ownerIds: this.owners.map(o => o.id), pending: [], summary: summary() } });
    const ownerIds = this.owners.map(o => o.id);
    const ownerListChanged = JSON.stringify(parent.metadata.ownerIds) !== JSON.stringify(ownerIds);
    const oldOwners = ["native-merge-transport", "runtime-release", "release-generation-transport"];
    const prior = parent.metadata.ownerIds;
    const knownUpgrade = Array.isArray(prior) && prior.length >= 1 && prior.length <= 3
      && JSON.stringify(prior) === JSON.stringify(oldOwners.slice(0, prior.length))
      && (JSON.stringify(ownerIds) === JSON.stringify(oldOwners)
        || JSON.stringify(ownerIds) === JSON.stringify(["runtime-update-backup", ...oldOwners]));
    if (TERMINAL.has(parent.status) || parent.metadata.version !== STORAGE_RETENTION_VERSION
        || ![undefined, 1, 2, 3, STORAGE_RETENTION_POLICY_VERSION].includes(parent.metadata.policyVersion)
        || (ownerListChanged && !knownUpgrade)) {
      return this.#last = { state: "deferred", reason: "retention-policy-incompatible" };
    }
    let state = bounded(parent.metadata);
    if (knownUpgrade) Object.assign(state, { ownerIds, ownerIndex: 0, cursor: null });
    state.policyVersion = STORAGE_RETENTION_POLICY_VERSION;
    const cycle = `${context.releaseId}:${Math.floor(this.now().getTime() / this.intervalMs)}`;
    if (!approved && state.cycle !== cycle) Object.assign(state, { cycle, ownerIndex: 0, cursor: null, summary: summary() });
    const save = async () => {
      await lease.assertOwned();
      parent = await this.#update(parent, { status: running(parent), phase: "background", metadata: bounded(state) }, lease);
    };
    const account = result => {
      if (result.status === "removed") {
        state.summary.removed += 1;
        state.summary.logicalBytes += Math.max(0, Number(result.logicalBytes) || 0);
      } else if (result.status === "partial") {
        state.summary.partialBatches = (state.summary.partialBatches ?? 0) + 1;
        state.summary.logicalBytes += Math.max(0, Number(result.logicalBytes) || 0);
      } else if (result.status === "already-removed") {
        state.summary.alreadyRemoved += 1;
      } else if (result.status === "retained") {
        state.summary.retained += 1;
        const proposed = reason(result.reason);
        const key = Object.hasOwn(state.summary.reasons, proposed) || Object.keys(state.summary.reasons).length < 32
          ? proposed : "other-owner-reasons";
        state.summary.reasons[key] = (state.summary.reasons[key] ?? 0) + 1;
      }
    };
    const settle = async (owner, candidate, record = null, approvedBinding = null) => {
      used += 1;
      const fresh = await this.readContext();
      if (!fresh?.ready || fresh.isolated || fresh.busy || fresh.releaseId !== context.releaseId || (this.#closed || this.isStopping())) return false;
      let step = await this.#unit(owner, candidate, fresh, lease, record, approvedBinding);
      if (step.prepared) {
        const admission = await this.readContext();
        if (!admission?.ready || admission.isolated || admission.busy || admission.releaseId !== context.releaseId
            || (this.#closed || this.isStopping()) || this.clock() - started >= this.budgetMs) return false;
        if (state.pending.length >= 8 && !state.pending.some(p => p.operationId === step.child?.operationId)) {
          account({ status: "retained", reason: "pending-owner-budget" }); return true;
        }
        let child = step.child ?? await this.#create(lease, { kind: KIND, ...SCOPE, threadId: step.prepared.scope,
          metadata: { version: STORAGE_RETENTION_VERSION, owner: owner.id, ...step.prepared, admitted: false } });
        if (!state.pending.some(p => p.operationId === child.operationId)) {
          state.pending.push({ operationId: child.operationId, owner: owner.id, candidate: step.prepared.candidate });
          await save(); // The discoverable original intent precedes every effect.
        }
        await lease.assertOwned();
        child = await this.#update(child, { status: running(child), phase: "pruning", metadata: { admitted: true } }, lease);
        const effectContext = await this.readContext();
        if (!effectContext?.ready || effectContext.isolated || effectContext.busy
            || effectContext.releaseId !== context.releaseId || (this.#closed || this.isStopping())) return false;
        await lease.assertOwned();
        try {
          step = { child, result: bounded(await owner.prune({ candidate: child.metadata.candidate,
            binding: child.metadata.binding, operationId: child.operationId, context: admission })) };
        } catch {
          step = { child, result: { status: "unknown", reason: "owner-outcome-unknown" } };
        }
      }
      const result = OUTCOMES.has(step.result?.status) ? step.result : { status: "unknown", reason: "owner-outcome-unknown" };
      if (step.child) {
        await lease.assertOwned();
        // An owner persists per-entry progress on this SAME child before effects.
        // Refresh its CAS only after checking the immutable admission binding.
        const latest = this.store.get(step.child.operationId);
        if (!latest || TERMINAL.has(latest.status) || latest.metadata.owner !== step.child.metadata.owner
          || latest.metadata.version !== step.child.metadata.version
          || latest.metadata.admitted !== step.child.metadata.admitted
          || JSON.stringify(latest.metadata.candidate) !== JSON.stringify(step.child.metadata.candidate)
          || JSON.stringify(latest.metadata.binding) !== JSON.stringify(step.child.metadata.binding)) {
          throw new Error("retention-owner-fenced");
        }
        step.child = latest;
        if (result.status === "unknown" || result.status === "partial") {
          if (!TERMINAL.has(step.child.status)) await this.#update(step.child, { status: "reconciling",
            phase: result.status === "partial" ? "partial" : "reconciling", outcome: "unknown", metadata: { lastObservation: bounded(result) } }, lease);
        } else {
          await this.#write(lease, () => this.store.settle(step.child.operationId,
            { succeeded: true, phase: result.status, metadata: { result } }), step.child.operationId);
          state.pending = state.pending.filter(p => p.operationId !== step.child.operationId);
        }
      }
      account(result);
      return true;
    };
    await save();
    if (approved) {
      for (const item of approved) {
        if (this.clock() - started >= this.budgetMs || (this.#closed || this.isStopping())) break;
        const owner = this.owners.find(candidate => candidate.id === item.ownerId);
        if (!await settle(owner, item.candidate, null, item.binding)) break;
        await save();
      }
      return this.#last = { state: "idle", approved: true, processed: used,
        pending: state.pending.length, ...state.summary };
    }
    // One uncertain resource cannot starve all other artifact owners. Its SAME
    // original operation is reconciled; it is never submitted as a fresh effect.
    if (state.pending.length && used < this.maxUnits && !(this.#closed || this.isStopping())) {
      const record = state.pending.shift(); state.pending.push(record);
      const owner = this.owners.find(o => o.id === record.owner);
      if (!owner) throw new Error("retention-owner-missing");
      if (!await settle(owner, record.candidate, record)) return this.#last = { state: "deferred", more: true };
      await save();
    }
    let deferred = false;
    while (state.ownerIndex < this.owners.length && used < this.maxUnits
        && this.clock() - started < this.budgetMs && !(this.#closed || this.isStopping())) {
      const owner = this.owners[state.ownerIndex];
      const page = await owner.list({ after: state.cursor, limit: this.maxUnits - used, context });
      if (!Array.isArray(page?.items) || page.items.length > this.maxUnits - used || typeof page.done !== "boolean") throw new Error("retention-discovery-budget");
      if (!page.items.length && !page.done) throw new Error("retention-discovery-no-progress");
      for (const candidate of page.items) {
        if (typeof candidate?.id !== "string" || !candidate.id || typeof candidate.cursor !== "string"
            || candidate.cursor === state.cursor) throw new Error("retention-candidate-identity");
        if (!await settle(owner, bounded(candidate, 4096))) { deferred = true; break; }
        state.cursor = candidate.cursor;
        await save();
        if (used >= this.maxUnits || this.clock() - started >= this.budgetMs || (this.#closed || this.isStopping())) break;
      }
      if (page.done && (!page.items.length || state.cursor === page.items.at(-1).cursor)) {
        state.ownerIndex += 1; state.cursor = null; await save();
      } else if ((this.#closed || this.isStopping()) || deferred) break;
    }
    this.#last = { state: "idle", policyVersion: STORAGE_RETENTION_POLICY_VERSION, cycle,
      more: state.ownerIndex < this.owners.length, pending: state.pending.length, ...state.summary };
    return this.status();
  }
}
