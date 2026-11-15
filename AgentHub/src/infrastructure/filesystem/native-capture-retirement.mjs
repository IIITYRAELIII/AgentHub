import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { MaintenanceOperationStore } from "../persistence/maintenance-operation-store.mjs";
import { nativeCaptureRetirementEvidence } from "../persistence/native-capture-retirement-evidence.mjs";
import { inventoryNativeCapture } from "./native-capture-inventory.mjs";
import { assertNativeTrackedCapture } from "./native-capture-content.mjs";
import { assertNativeCaptureNotSourcePinned } from "./native-capture-source-pins.mjs";
import { retireSealedNativeCapture, measureNativeCaptureAllocation } from "./sealed-native-capture.mjs";
import { withRuntimeInstallationLease } from "./runtime-installation-custody.mjs";
import { taskGitIdentityHash } from "../../domain/task-git-reference.mjs";
import { measureTaskOperation, recordTaskOperationTiming, withTaskOperationTiming } from "../process/task-operation-timing.mjs";
const sha = x => createHash("sha256").update(x).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const retained = reason => ({ status: "retained", reason });
const absent = e => { if (e.code === "ENOENT") return null; throw e; };
const kind = "native-capture-retirement-v1";
export const nativeCaptureCandidate = id => ({ id: id + ":repository", cursor: id + ":repository", captureId: id, kind });

// Extends NativeMergeTransportRetention's SAME owner/registry with a separately
// bound whole-repository resource. No Task closure or new state/retirement ledger.
export class NativeCaptureRetirement {
  constructor({ dataDir, taskBoard, taskGitWorkspaces, gitAt, isStopping = () => false,
    store = new MaintenanceOperationStore({ dataDir }), retire = retireSealedNativeCapture,
    sourcePins = assertNativeCaptureNotSourcePinned, readGeneration, installationLease = withRuntimeInstallationLease }) {
    Object.assign(this, { dataDir, taskBoard, taskGitWorkspaces, gitAt, isStopping, store, retire, sourcePins, readGeneration, installationLease });
    this.root = path.join(dataDir, "task-native-merges"); this.runtimeRoot = path.dirname(dataDir);
  }
  async #owned(candidate, operationId, action) {
    const started = performance.now(); let entered = false;
    try {
      return await this.#ownedContext(candidate, operationId, owned => {
        entered = true;
        recordTaskOperationTiming("native-retire:owned-setup", { durationMs: Math.max(0, performance.now() - started), outcome: "ok" });
        return action(owned);
      });
    } finally {
      if (!entered) recordTaskOperationTiming("native-retire:owned-setup", { durationMs: Math.max(0, performance.now() - started), outcome: "error" });
    }
  }
  async #ownedContext(candidate, operationId, action) {
    if (candidate?.kind !== kind || !/^[a-f0-9]{24}$/u.test(candidate.captureId || "")
        || candidate.id !== candidate.captureId + ":repository") return retained("native-capture-identity-unknown");
    const root = path.join(this.root, candidate.captureId), stateFile = path.join(root, "merge.json");
    for (const dir of [this.root, root]) {
      const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Native capture owner root redirected");
    }
    const stateInfo = await lstat(stateFile); if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.nlink !== 1) throw new Error("Native capture journal custody changed");
    const raw = await readFile(stateFile), state = JSON.parse(raw), identity = state.identity;
    if (sha(JSON.stringify(identity)).slice(0, 24) !== candidate.captureId || state.version !== 1
        || identity?.policy !== "native-dev-merge-v1" || state.next !== 1 || state.merges?.length !== 1
        || state.conflict || state.merging || state.provisioningObjects || state.head !== state.merges[0].commit
        || state.merges[0].taskId !== identity.taskId || state.merges[0].resultCommit !== identity.resultCommit) return retained("native-capture-incomplete");
    const repository = path.join(root, "repository");
    return this.taskGitWorkspaces.withTaskLock(identity.taskId, async lease => this.installationLease(this.runtimeRoot, async installation => {
      const task = this.taskBoard.task(identity.taskId);
      if (this.isStopping() || task?.status !== "done" || task.workflowStatus !== "done" || !task.completedAt || !task.gitReferences?.length) return retained("native-capture-task-not-terminal");
      const record = await this.taskGitWorkspaces.nativeCaptureRetirementRecordOwned({ taskId: identity.taskId, root, state, lease });
      const originalEvidence = nativeCaptureRetirementEvidence(this.dataDir, identity.taskId, record.operationId);
      const publication = await this.taskGitWorkspaces.cleanupPreview(identity.taskId, { gitReferences: task.gitReferences, squashAbsorbedBy: task.squashAbsorbedBy });
      if (publication.dirty || publication.unpublished.length || !publication.gitReferences.length
          || publication.gitReferences.some(r => !r.published || !r.publishedRevision || !r.publicationGeneration)) return retained("native-capture-unpublished");
      await measureTaskOperation("native-retire:source-pins", () => this.sourcePins(this.runtimeRoot, repository, { readGeneration: this.readGeneration }));
      const git = (args, options) => this.gitAt(repository, ["--no-optional-locks", "--no-lazy-fetch", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], { ...options, lease });
      const current = () => measureTaskOperation("native-retire:current", async () => {
        await lease.assertOwned(); await installation.assertOwned();
        if (this.isStopping() || this.taskBoard.task(identity.taskId)?.revision !== task.revision
            || sha(await readFile(stateFile)) !== sha(raw)
            || !same(originalEvidence, nativeCaptureRetirementEvidence(this.dataDir, identity.taskId, record.operationId))
            || !same(record, await this.taskGitWorkspaces.nativeCaptureRetirementRecordOwned({ taskId: identity.taskId, root, state, lease }))
            || !same(publication, await this.taskGitWorkspaces.cleanupPreview(identity.taskId, { gitReferences: task.gitReferences, squashAbsorbedBy: task.squashAbsorbedBy }))) throw new Error("Native capture retirement authority changed");
        await measureTaskOperation("native-retire:source-pins", () => this.sourcePins(this.runtimeRoot, repository, { readGeneration: this.readGeneration }));
        for (const dir of [this.root, root]) { const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Native capture owner root redirected"); }
      });
      const resourceCurrent = async () => {
        await lease.assertOwned(); await installation.assertOwned();
        if (this.isStopping() || this.taskBoard.task(identity.taskId)?.revision !== task.revision
            || sha(await readFile(stateFile)) !== sha(raw)) throw new Error("Native capture storage resource changed");
      };
      const row = operationId ? this.store.getReadonly(operationId) : null;
      if (operationId && (!row || row.metadata.owner !== "native-merge-transport" || row.metadata.candidate?.id !== candidate.id)) throw new Error("Native capture original missing or foreign");
      const objects = this.taskGitWorkspaces.createNativeObjectStore({ sourceRoot: repository, lease, store: this.store, assertCurrent: resourceCurrent });
      return action({ root, repository, state, stateHash: sha(raw), task, record, originalEvidence, publication, git, current, resourceCurrent, row, objects, lease });
    }), { timeoutMs: 250 });
  }
  async #preview(owned) {
    const { repository, git, state } = owned;
    for (const file of [path.join(repository, ".git"), path.join(repository, ".git/objects")]) {
      const s = await lstat(file); if (!s.isDirectory() || s.isSymbolicLink()) return retained("native-capture-not-independent");
    }
    // Legacy bundle retirement retains its own exact owner/receipt. Until that
    // owner removes transport, keep the repository needed to verify it.
    if (await lstat(path.join(owned.root, "source.bundle")).catch(absent)) return retained("native-transport-must-retire-first");
    for (const file of [".git/objects/info/alternates", ".git/shallow", ".git/info/grafts"]) if (await lstat(path.join(repository, file)).catch(absent)) return retained("native-capture-history-borrowed-or-rewritten");
    if (/^(extensions\.partialclone|remote\..*\.promisor)=/imu.test(await git(["config", "--local", "--list"]))
        || await git(["rev-parse", "--is-shallow-repository"]) !== "false"
        || (await realpath(String(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])))).toLowerCase() !== (await realpath(path.join(repository, ".git"))).toLowerCase()
        || (await realpath(String(await git(["rev-parse", "--show-toplevel"])))).toLowerCase() !== (await realpath(repository)).toLowerCase()) return retained("native-capture-not-independent");
    if (await git(["rev-parse", "HEAD^{commit}"]) !== state.head || await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored"])) return retained("native-capture-work-pinned");
    for (const ref of owned.publication.gitReferences) await this.gitAt(ref.projectRoot, ["merge-base", "--is-ancestor", state.identity.resultCommit, ref.publishedRevision], { lease: owned.lease });
    let allowSharedObjects = false;
    if (state.objectStorage) {
      if (state.identity.objectStorage?.kind !== "owned-immutable-git-objects-v1") return retained("native-capture-object-storage-unproven");
      await owned.objects.assertConsumer({ repository, storage: state.objectStorage,
        identityHash: taskGitIdentityHash(state.identity), inputs: [...new Set([state.identity.before, state.identity.resultCommit])] });
      allowSharedObjects = true;
    }
    const inventory = await inventoryNativeCapture(repository, { allowSharedObjects });
    await assertNativeTrackedCapture({ repository, inventory, git, head: state.head });
    const allocation = await measureNativeCaptureAllocation([repository]); // Also rejects ADS/reparse before eligible.
    const binding = { kind, captureId: path.basename(owned.root), stateHash: owned.stateHash, taskRevision: owned.task.revision,
      originalEvidence: owned.originalEvidence, record: owned.record, publicationSha256: sha(JSON.stringify(owned.publication)),
      root: inventory.root, inventorySha256: sha(JSON.stringify(inventory)), allocation };
    await owned.current();
    return { status: "eligible", binding, inventory };
  }
  async preview({ candidate }) {
    try {
      return await this.#owned(candidate, null, async owned => {
        const p = await this.#preview(owned);
        return p.status === "eligible" ? { status: p.status, binding: p.binding } : p;
      });
    } catch (error) { return retained("native-capture-proof-unavailable:" + String(error.message)); }
  }
  async #patch(row, patch) {
    const result = await this.store.runRestartMutation(() => this.store.transition(row.operationId, patch, { expectedRevision: row.revision }));
    if (!result.applied) throw new Error("Native capture original CAS changed");
    return result.operation;
  }
  async #effect(input) {
    const original = this.store.getReadonly(input.operationId);
    if (!original || original.metadata.owner !== "native-merge-transport" || original.metadata.candidate?.id !== input.candidate?.id) throw new Error("Native capture original missing or foreign");
    if (!same(original.metadata.binding, input.binding)) throw new Error("Native capture original binding changed");
    const candidateHash = sha(JSON.stringify(input.candidate)), batchSequence = (original.metadata.captureBatchSequence ?? 0) + 1;
    const timing = { batchSequence, candidateHash, phases: {}, nativeProducerStarts: 0, outcome: "error" }, started = performance.now();
    const identity = { operationId: input.operationId, taskId: input.binding.originalEvidence.taskId };
    const record = event => {
      if (event.stage.startsWith("native-retire:") && Number.isFinite(event.durationMs)) {
        const phase = timing.phases[event.stage] ??= { count: 0, errorCount: 0, inclusiveMs: 0 };
        phase.count++; phase.errorCount += Number(event.outcome === "error"); phase.inclusiveMs += event.durationMs;
      }
      if (event.stage === "native-retire:native-phases" && event.owningBatch) timing.nativeProducerStarts += event.producerStarts ?? 0;
      this.taskGitWorkspaces.recordTiming({ ...event, candidateHash, batchSequence });
    };
    return withTaskOperationTiming({ ...identity, record }, async () => {
      try {
        await this.#patch(original, { metadata: { captureBatchSequence: batchSequence } });
        const result = await this.#effectOwned(input, joined => withTaskOperationTiming({ ...identity,
          record: event => this.taskGitWorkspaces.recordTiming({ ...event, candidateHash, batchSequence }) },
        async () => recordTaskOperationTiming("native-retire:producer-close", joined)));
        timing.outcome = result.status;
        return result;
      } finally {
        timing.elapsedMs = Math.max(0, performance.now() - started);
        recordTaskOperationTiming("native-retire:batch", timing);
        // The existing original owns bounded diagnostic progress too. It grants
        // no effect authority and a diagnostic write never replaces its error.
        try {
          const latest = this.store.getReadonly(input.operationId);
          if (!latest || !same(latest.metadata.binding, input.binding)) throw Error("Timing original changed");
          await this.#patch(latest, { metadata: { captureTiming: timing } });
        } catch {
          recordTaskOperationTiming("native-retire:timing-save", { outcome: "error" });
        }
      }
    });
  }
  async #effectOwned(input, onProducerClose) {
    return this.#owned(input.candidate, input.operationId, async owned => {
      if (!same(owned.row.metadata.binding, input.binding)) throw new Error("Native capture original binding changed");
      let row = owned.row, archived;
      if (row.metadata.captureArchive) {
        // Carry only the immutable descriptor. The complete fresh proof and
        // exact binding checks remain inside SAME withArchiveLease below.
        archived = { archive: row.metadata.captureArchive };
      } else {
        if (row.metadata.captureArchiveIntent) archived = await owned.objects.readArchiveIntent(row.metadata.captureArchiveIntent);
        // A missing archive intent is not no-effect evidence. Continue only
        // after the complete live source proves the SAME original binding;
        // partial or changed source cannot acquire a replacement intake.
        const preview = await this.#preview(owned);
        if (preview.status !== "eligible" || !same(preview.binding, input.binding)) return retained("native-capture-preview-changed");
        const request = { sourceRoot: owned.repository, binding: { retirement: input.binding,
          state: owned.state, stateHash: owned.stateHash }, inventory: preview.inventory, assertCurrent: owned.resourceCurrent };
        const intent = owned.objects.archiveIntent(request);
        if (row.metadata.captureArchiveIntent && !same(row.metadata.captureArchiveIntent, intent)) throw new Error("Original archive intake drift");
        if (!row.metadata.captureArchiveIntent) row = await this.#patch(row, { phase: "archive-intent", metadata: { captureArchiveIntent: intent } });
        archived ??= await measureTaskOperation("native-retire:archive-intake", () => owned.objects.archive(request));
        // Verify complete preserved objects and the canonical native graph
        // under this SAME retirement original. Current result certification is
        // separate; no fake auth or new review grant is supplied.
        await measureTaskOperation("native-retire:archive-verification", () => this.taskGitWorkspaces.verifyNativeCaptureArchiveOwned({ state: owned.state, record: owned.record, archive: archived, lease: owned.lease, retirementOperationId: input.operationId }));
        row = await this.#patch(row, { metadata: { captureArchive: archived.archive }, phase: "archive-confirmed" });
      }
      await owned.current();
      return owned.objects.withArchiveLease(archived.archive, async fresh => {
        if (!same(fresh.manifest.binding.retirement, input.binding) || fresh.manifest.binding.stateHash !== owned.stateHash) throw new Error("Original archive context changed before deletion");
        const plan = fresh.manifest.inventory, bytes = Buffer.from(JSON.stringify(plan)), planSha = sha(bytes);
        const proofRoot = path.join(this.dataDir, "native-git-objects", "proofs"); await mkdir(proofRoot, { recursive: true });
        const proofRootInfo = await lstat(proofRoot);
        if (!proofRootInfo.isDirectory() || proofRootInfo.isSymbolicLink()) throw new Error("Archive derivative proof directory redirected");
        const planFile = path.join(proofRoot, planSha + ".json");
        const h = await open(planFile, "wx").catch(async e => { if (e.code !== "EEXIST") throw e; if (sha(await readFile(planFile)) !== planSha) throw new Error("Archive derivative proof changed"); return null; });
        if (h) { try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); } }
        const proofInfo = await lstat(planFile);
        if (!proofInfo.isFile() || proofInfo.isSymbolicLink() || proofInfo.nlink !== 1) throw new Error("Archive derivative proof file redirected");
        const hadPruningIntent = row.metadata.planSha256 === planSha;
        if (row.phase !== "capture-pruning") row = await this.#patch(row, { phase: "capture-pruning", metadata: { captureArchive: archived.archive, planSha256: planSha } });
        await owned.current();
        const exists = await lstat(owned.repository).catch(absent);
        if (!exists) {
          if (!hadPruningIntent) throw new Error("Native capture absence without original pruning");
          return { status: "already-removed", logicalBytes: 0, files: 0 };
        }
        const result = await this.retire(owned.repository, planFile, planSha, { allowPartial: hadPruningIntent, onProducerClose });
        if (result.status === "complete") {
          if (await lstat(owned.repository).catch(absent)) throw new Error("Native capture retirement is not absent");
          return { ...result, status: "removed" };
        }
        return { ...result, status: "partial" };
      });
    });
  }
  async prune(input) {
    try { return await this.#effect(input); }
    catch (error) { return { status: "unknown", reason: "native-capture-original-unresolved:" + error.message }; }
  }
  async reconcile(input) {
    try {
      const result = await this.#effect(input);
      return result.status === "retained" ? { status: "unknown", reason: result.reason } : result;
    } catch (error) { return { status: "unknown", reason: "native-capture-original-unresolved:" + error.message }; }
  }
}
