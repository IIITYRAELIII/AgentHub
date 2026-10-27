import { createHash } from "node:crypto";
import { lstat, readdir, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { runtimeLayout, runtimeReleaseDirectory } from "./runtime-layout.mjs";
import { captureRuntimeReleaseBinding, readRuntimeManifest, readRuntimePointer, sameRuntimeBinding,
  withRuntimeInstallationLease, writeRuntimePointer } from "./runtime-installation-custody.mjs";
import { runtimeRetirementCandidates } from "./runtime-release-retention-policy.mjs";
import { retireSealedRuntimeRelease } from "./sealed-runtime-release.mjs";

const key = binding => createHash("sha256").update(JSON.stringify({ releaseId: binding.releaseId,
  manifestSha256: binding.manifestSha256, root: binding.root })).digest("hex");
const absent = error => error?.code === "ENOENT";
const inside = (root, child) => {
  const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

// The installation pointer owns retirement custody; the maintenance store owns
// each original effect. Neither discovery nor directory age adopts old bodies.
export class RuntimeReleaseRetention {
  id = "runtime-release";

  constructor({ runtimeRoot, isStopping = () => false, retire = retireSealedRuntimeRelease } = {}) {
    if (!runtimeRoot) throw new TypeError("Runtime root required");
    Object.assign(this, { runtimeRoot, isStopping, retire });
  }

  async list({ after, limit, context }) {
    const pointer = await readRuntimePointer(this.runtimeRoot);
    const selected = runtimeRetirementCandidates({ pointer, runningReleaseId: context.releaseId });
    const items = selected.candidates.map(binding => ({ id: key(binding), cursor: key(binding), releaseId: binding.releaseId }))
      .sort((a, b) => a.cursor.localeCompare(b.cursor)).filter(item => !after || item.cursor > after);
    return { items: items.slice(0, limit), done: items.length <= limit };
  }

  async #pins(root, pointer, runningReleaseId) {
    const entries = await readdir(runtimeLayout(this.runtimeRoot).releasesDir, { withFileTypes: true });
    if (entries.length > 256) return "runtime-pin-inventory-budget";
    const retired = new Set(pointer.runtimeRetention?.retired?.map(r => r.releaseId) ?? []);
    const keep = new Set([pointer.current, pointer.previous, runningReleaseId].filter(Boolean));
    for (const entry of entries) {
      // Every unretired/prepared manifest remains a conservative source pin.
      if (retired.has(entry.name) && !keep.has(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.includes(".staging-")) return "runtime-preparation-unresolved";
      let manifest;
      try { ({ manifest } = await readRuntimeManifest(path.join(runtimeLayout(this.runtimeRoot).releasesDir, entry.name))); }
      catch { return "runtime-pin-manifest-unavailable"; }
      if (manifest.releaseId !== entry.name) return "runtime-pin-manifest-unknown";
      if (!Object.hasOwn(manifest, "sourceRoot")) {
        // The public installer verifies the source-free payload before recording
        // this exact manifest/root binding. Only its current/rollback custody
        // proves that omission is intentional; a prepared or legacy body does
        // not acquire that proof merely by omitting the private source path.
        const installed = [pointer.runtimeRetention?.current, pointer.runtimeRetention?.previous]
          .find(binding => binding?.releaseId === entry.name);
        let actual;
        try { actual = await captureRuntimeReleaseBinding(path.join(runtimeLayout(this.runtimeRoot).releasesDir, entry.name), entry.name); }
        catch { return "runtime-pin-manifest-unknown"; }
        if (!sameRuntimeBinding(actual, installed)) return "runtime-pin-manifest-unknown";
        continue;
      }
      if (!path.isAbsolute(manifest.sourceRoot ?? "")) return "runtime-pin-manifest-unknown";
      let source;
      try { source = await realpath(manifest.sourceRoot); }
      catch (error) { if (absent(error)) continue; return "runtime-source-pin-unavailable"; }
      if (inside(root, source)) return "runtime-source-pinned";
    }
    return null;
  }

  async #select(candidate, context, binding = null, operationId = null) {
    if (this.isStopping()) return { reason: "runtime-owner-stopping" };
    const pointer = await readRuntimePointer(this.runtimeRoot);
    const selected = runtimeRetirementCandidates({ pointer, runningReleaseId: context.releaseId });
    const record = pointer.runtimeRetention?.retired?.find(item => key(item) === candidate.id && item.releaseId === candidate.releaseId);
    if (!record || !selected.candidates.some(item => key(item) === candidate.id)) return { reason: "runtime-retirement-pinned-or-unproven" };
    if (binding && !sameRuntimeBinding(record, binding)) return { reason: "runtime-original-binding-changed" };
    if (record.operationId && record.operationId !== operationId) return { reason: "runtime-original-operation-required" };
    const root = await realpath(runtimeReleaseDirectory(this.runtimeRoot, record.releaseId)).catch(error => {
      if (absent(error)) return null;
      throw error;
    });
    if (!root) return { pointer, record, root: null };
    const info = await lstat(root, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== record.root.dev || String(info.ino) !== record.root.ino
        || String(info.birthtimeNs / 100n + 116444736000000000n) !== record.root.birthFileTime) {
      return { reason: "runtime-original-root-changed" };
    }
    // A release leaf cannot itself become a junction even if its final target
    // happens to carry the expected object. The native owner checks ancestors.
    if ((await lstat(runtimeReleaseDirectory(this.runtimeRoot, record.releaseId))).isSymbolicLink()) return { reason: "runtime-release-root-refused" };
    const pinned = await this.#pins(root, pointer, context.releaseId);
    if (pinned) return { reason: pinned };
    if (!record.operationId) {
      const current = await captureRuntimeReleaseBinding(root, record.releaseId);
      if (!sameRuntimeBinding(current, record)) return { reason: "runtime-original-binding-changed" };
    }
    return { pointer, record, root };
  }

  preview({ candidate, context }) {
    if (process.platform !== "win32") return Promise.resolve({ status: "retained", reason: "runtime-platform-unavailable" });
    return withRuntimeInstallationLease(this.runtimeRoot, async lease => {
      const selected = await this.#select(candidate, context);
      await lease.assertOwned();
      if (selected.reason || !selected.root) return { status: "retained", reason: selected.reason ?? "runtime-root-absent" };
      return { status: "eligible", binding: { releaseId: selected.record.releaseId,
        manifestSha256: selected.record.manifestSha256, root: selected.record.root } };
    });
  }

  async #effect({ candidate, binding, context, operationId }, reconcile) {
    return withRuntimeInstallationLease(this.runtimeRoot, async lease => {
      const selected = await this.#select(candidate, context, binding, operationId);
      if (selected.reason) return { status: reconcile ? "unknown" : "retained", reason: selected.reason };
      const { pointer, record, root } = selected;
      if (!root) {
        if (!reconcile || record.operationId !== operationId || record.phase !== "pruning") {
          return { status: "unknown", reason: "runtime-absence-without-original-effect" };
        }
      } else {
        if (!record.operationId) {
          record.operationId = operationId;
          record.phase = "pruning";
          await lease.assertOwned();
          await writeRuntimePointer(this.runtimeRoot, pointer); // Original intent BEFORE first native effect.
        }
        if (record.phase !== "pruning") return { status: "unknown", reason: "runtime-original-phase-unknown" };
        await lease.assertOwned();
        const free = async () => { const info = await statfs(root, { bigint: true }); return info.bavail * info.bsize; };
        const before = await free();
        const result = await this.retire(root, binding, { allowPartial: reconcile });
        const info = await statfs(this.runtimeRoot, { bigint: true });
        const after = info.bavail * info.bsize;
        if (!["complete", "partial"].includes(result?.status) || !Number.isSafeInteger(result.files) || result.files < 0
            || !Number.isSafeInteger(result.logicalBytes) || result.logicalBytes < 0) throw new Error("runtime-outcome-unknown");
        if (result.status === "partial") return { status: "partial", logicalBytes: result.logicalBytes,
          files: result.files, observedFreeBefore: String(before), observedFreeAfter: String(after), observedFreeDelta: String(after - before) };
        if (await lstat(runtimeReleaseDirectory(this.runtimeRoot, record.releaseId)).then(() => true, error => {
          if (absent(error)) return false;
          throw error;
        })) throw new Error("runtime-completion-not-absent");
        selected.observation = { logicalBytes: result.logicalBytes, files: result.files,
          observedFreeBefore: String(before), observedFreeAfter: String(after), observedFreeDelta: String(after - before) };
      }
      await lease.assertOwned();
      pointer.runtimeRetention.retired = pointer.runtimeRetention.retired.filter(item => key(item) !== candidate.id);
      await writeRuntimePointer(this.runtimeRoot, pointer);
      return { status: root ? "removed" : "already-removed", ...selected.observation };
    });
  }

  prune(input) { return this.#effect(input, false); }

  async reconcile(input) {
    // A crash AFTER pointer completion may leave only the original maintenance
    // binding. Exact absence is a reconciliation observation, never a new effect.
    const pointer = await readRuntimePointer(this.runtimeRoot);
    const record = pointer.runtimeRetention?.retired?.find(item => key(item) === input.candidate.id);
    if (!record) {
      const root = runtimeReleaseDirectory(this.runtimeRoot, input.binding.releaseId);
      try { await lstat(root); } catch (error) {
        if (absent(error) && pointer.current !== input.binding.releaseId && pointer.previous !== input.binding.releaseId
            && input.context.releaseId !== input.binding.releaseId) return { status: "already-removed", logicalBytes: 0 };
        throw error;
      }
      return { status: "unknown", reason: "runtime-original-custody-unavailable" };
    }
    return this.#effect(input, true);
  }
}
