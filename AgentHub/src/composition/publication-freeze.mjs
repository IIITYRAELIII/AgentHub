import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { artifactVersionIdentity } from "../domain/agent-hub-version.mjs";
import { assertReleaseCloneForPublication, ReleaseGitWorkspaceService } from "../infrastructure/filesystem/release-git-workspace.mjs";
import { readCandidatePublicationReleasePlan } from "./publication-release-plan-composition.mjs";
import { assertCleanPublicationTree, assertCurrentPublicationRevision } from "../infrastructure/persistence/publication-state.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function freezePreparedPublication({
  includeArtifactVersion = false,
  workspaceId = "",
  repositoryRoot = REPOSITORY_ROOT,
  readPlan = readCandidatePublicationReleasePlan,
  read = readFile,
  assertClone = assertReleaseCloneForPublication,
  assertCleanTree = assertCleanPublicationTree,
  assertCurrentRevision = assertCurrentPublicationRevision,
  createReleaseWorkspace = (options) => new ReleaseGitWorkspaceService(options),
} = {}) {
  const marker = await assertClone({ repositoryRoot });
  const checkpoint = JSON.parse(await read(path.join(repositoryRoot, "..", "checkpoint.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/u.test(checkpoint.manifestHash ?? "")) throw new Error("invalid prepared manifest hash");
  const manifest = JSON.parse(await read(
    path.join(repositoryRoot, "..", "evidence", `${checkpoint.manifestHash}.json`),
    "utf8",
  ));
  const selectedWorkspace = String(workspaceId || manifest.workspaceId || "").trim();
  if (!selectedWorkspace) throw new Error("publication freeze requires its Workspace");
  const reusePersistedChangelog = ["freezing", "frozen"].includes(checkpoint.phase);
  const changelogContent = reusePersistedChangelog
    ? undefined
    : await read(path.join(repositoryRoot, "CHANGELOG.md")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const releaseWorkspace = createReleaseWorkspace({ dataDir: path.dirname(marker.managedRoot) });
  const frozen = await releaseWorkspace.freezePublicationCandidate({
    projectRoot: marker.primaryRoot, workspaceId: selectedWorkspace,
    expectedPlanRevision: checkpoint.planRevision, expectedPreparedHead: checkpoint.preReleaseHead,
    changelogContent, reusePersistedChangelog,
    validateBeforeCommit: async () => {
      const plan = await readPlan(selectedWorkspace);
      if (plan.revision !== checkpoint.planRevision) {
        throw new Error("release plan changed before publication freeze");
      }
    },
  });
  const frozenManifest = JSON.parse(await read(frozen.manifestFile, "utf8"));
  const releaseVersion = String(frozenManifest.publication?.releaseVersion ?? "");
  if (!releaseVersion) throw new Error("frozen release version is missing from the immutable manifest");
  await assertCleanTree({ cwd: repositoryRoot });
  await assertCurrentRevision({ cwd: repositoryRoot });
  if (includeArtifactVersion) {
    const runtimeReleaseVersion = frozenManifest.publication?.runtimeReleaseVersion;
    const identity = artifactVersionIdentity(runtimeReleaseVersion);
    const head = frozenManifest.publication?.head;
    if (identity.publicVersion !== releaseVersion || head !== frozen.preReleaseHead
        || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head ?? "")) {
      throw new Error("Frozen public/source/artifact version binding changed");
    }
    return { releaseVersion, runtimeReleaseVersion, head };
  }
  return releaseVersion;
}
