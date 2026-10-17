import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { callDesktopControl } from "./desktop-control.mjs";
import { assertReleaseCloneForPublication } from "../filesystem/release-git-workspace.mjs";
import { normalizedReleaseBaseProvenance, releasePublicationBaseCommit } from "../../domain/release-base-provenance.mjs";

const execute = promisify(execFile);
const sha = /^[a-f0-9]{40,64}$/u;
function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

const samePath = (a, b) => process.platform === "win32"
  ? canonicalPath(a).toLowerCase() === canonicalPath(b).toLowerCase()
  : canonicalPath(a) === canonicalPath(b);

async function git(args, { cwd }) {
  const { stdout } = await execute("git", args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

// Planning prepares and verifies managed Git state. The interactive Desktop
// default (10 seconds) is shorter than this repository operation.
export function readPublicationReleasePlan(control, workspaceId, runtimeRoot) {
  return control("read-workspace-release-plan", { workspaceId }, { runtimeRoot, timeoutMs: 120_000 });
}

// This adapter executes the already frozen release; it never selects Tasks,
// manufactures approval, or writes the registered primary checkout.
export function createFrozenReleasePublication({
  repositoryRoot, runtimeRoot, workspaceId = null,
  control = callDesktopControl, runGit = git,
  verifyClone = assertReleaseCloneForPublication, read = readFile, readPlan = null,
} = {}) {
  const invoke = (args) => runGit(args, { cwd: repositoryRoot });
  const loadPlan = readPlan ?? ((selectedWorkspace) => (
    readPublicationReleasePlan(control, selectedWorkspace, runtimeRoot)
  ));
  async function frozen(identity, { completing = false } = {}) {
    const marker = await verifyClone({ repositoryRoot });
    if (!samePath(marker.releaseRoot, identity.worktreeRoot)) throw new Error("publication checkout identity changed");
    const saved = identity.release;
    // Completion may follow an Await rebuild which replaced the mutable candidate
    // checkpoint. The immutable manifest referenced by the original run is kept.
    const checkpoint = completing && saved ? saved : JSON.parse(await read(path.join(repositoryRoot, "..", "checkpoint.json"), "utf8"));
    const manifestFile = path.join(repositoryRoot, "..", "evidence", `${checkpoint.manifestHash}.json`);
    if (!sha.test(checkpoint.manifestHash ?? "")) throw new Error("invalid frozen manifest hash");
    const bytes = await read(manifestFile);
    if (createHash("sha256").update(bytes).digest("hex") !== checkpoint.manifestHash) throw new Error("frozen release manifest digest changed");
    const manifest = JSON.parse(bytes.toString());
    const provenance = normalizedReleaseBaseProvenance(manifest.baseProvenance, manifest.baseCommit);
    if (JSON.stringify(provenance) !== JSON.stringify(
      normalizedReleaseBaseProvenance(checkpoint.baseProvenance, checkpoint.baseCommit),
    )) throw new Error("frozen release provenance changed");
    if (!samePath(manifest.primaryRoot, marker.primaryRoot)
      || !samePath(manifest.releaseRoot, marker.releaseRoot)
      || manifest.planRevision !== checkpoint.planRevision
      || manifest.baseCommit !== checkpoint.baseCommit
      || !sha.test(checkpoint.baseCommit ?? "")
      || !sha.test(checkpoint.preReleaseHead ?? "")
      || identity.revision !== checkpoint.preReleaseHead) throw new Error("frozen release identity mismatch");
    const selectedWorkspace = String(identity.workspaceId || workspaceId || manifest.workspaceId || saved?.workspaceId || "");
    if (!selectedWorkspace || (manifest.workspaceId && selectedWorkspace !== manifest.workspaceId)) {
      throw new Error("frozen release needs its Workspace; refreeze the legacy candidate or pass --workspace <id>");
    }
    if (!completing) {
      const [head, dirty] = await Promise.all([
        invoke(["rev-parse", "HEAD^{commit}"]), invoke(["status", "--porcelain=v1", "--untracked-files=all"]),
      ]);
      if (head !== identity.revision || dirty) throw new Error("release checkout changed before publication");
      const plan = await loadPlan(selectedWorkspace);
      if (plan.revision !== checkpoint.planRevision) throw new Error("release plan changed before publication");
      const roots = new Set((plan.candidates ?? []).flatMap((task) => (task.gitReferences ?? []).map((ref) => path.resolve(ref.projectRoot))));
      if (roots.size !== 1 || ![...roots].some((root) => samePath(root, marker.primaryRoot))) {
        throw new Error("automatic publication requires one exact frozen repository; multi-repository release needs coordinated publication");
      }
    }
    return {
      workspaceId: selectedWorkspace, planRevision: checkpoint.planRevision,
      manifestHash: checkpoint.manifestHash, baseCommit: checkpoint.baseCommit,
      publicationBaseCommit: releasePublicationBaseCommit(manifest),
      ...(provenance ? { baseProvenance: provenance } : {}),
      preReleaseHead: checkpoint.preReleaseHead, primaryRoot: marker.primaryRoot,
    };
  }
  return {
    prepare: (identity, { completionOnly = false } = {}) => frozen(identity, { completing: completionOnly === true }),
    async publishGit(identity) {
      const release = await frozen(identity);
      await invoke(["fetch", "--no-tags", "--no-recurse-submodules", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      const remote = await invoke(["rev-parse", "refs/remotes/origin/main^{commit}"]);
      if (remote === identity.revision) return { status: "already_published", revision: remote };
      if (remote !== release.publicationBaseCommit) throw new Error(`origin/main changed: approved ${release.publicationBaseCommit}, observed ${remote}`);
      await invoke(["merge-base", "--is-ancestor", release.baseCommit, identity.revision]);
      await invoke(["merge-base", "--is-ancestor", release.publicationBaseCommit, identity.revision]);
      // Exact lease also protects the fetch/push race. The ancestry check forbids
      // using that lease to replace unrelated remote history.
      await invoke(["push", `--force-with-lease=refs/heads/main:${release.publicationBaseCommit}`, "origin", `${identity.revision}:refs/heads/main`]);
      const observed = await invoke(["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
      if (observed.split(/\s/u)[0] !== identity.revision) throw new Error("Git publication outcome requires reconciliation");
      return { status: "published", revision: identity.revision };
    },
    async finalizePublication(identity) {
      const release = await frozen(identity, { completing: true });
      const observed = await invoke(["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
      if (observed.split(/\s/u)[0] !== identity.revision) throw new Error("cannot finalize a release missing from origin/main");
      // The verifier reads the primary's remote-tracking ref. Fetch only that
      // object/ref; HEAD, index and working bytes remain owned by the Git service.
      await runGit(["fetch", "--no-tags", "--no-recurse-submodules", "origin", "+refs/heads/main:refs/remotes/origin/main"], { cwd: release.primaryRoot });
      if (!identity.finalizationCommandId) throw new Error("finalization requires its persisted command identity");
      const result = await control("complete-workspace-release", {
        workspaceId: release.workspaceId,
        expectedPlanRevision: release.planRevision,
        expectedRepositories: [{ projectRoot: release.primaryRoot, revision: identity.revision }],
        deploymentVerified: true,
        verificationSummary: `Publication ${identity.revision}; exact runtime readiness verified; validation=${identity.validationMode ?? identity.mode}.`,
      }, { runtimeRoot, timeoutMs: 300_000, commandId: identity.finalizationCommandId });
      if (result.finalization?.status !== "completed") {
        if (result.finalization?.status === "retry_required") return { status: "retry_required", result };
        throw new Error("runtime lacks resumable release finalization");
      }
      return { status: "completed", result };
    },
  };
}
