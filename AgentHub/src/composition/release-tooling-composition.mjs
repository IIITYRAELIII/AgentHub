import path from "node:path";
import { readReleaseToolPackage } from "../infrastructure/process/release-tool-package.mjs";
import { artifactVersionIdentity, calendarVersion } from "../domain/agent-hub-version.mjs";
import { normalizeReleaseTaskIds, normalizeReleaseVersion } from "../domain/release-operation.mjs";
import { normalizeTestSelection, resolveTestSelection, verifyTestPlan } from "../domain/test-selection.mjs";
import { discoverReleaseTestInventory, RELEASE_CHECK_IDS } from "../infrastructure/filesystem/release-test-inventory.mjs";
import { freezePreparedPublication } from "./publication-freeze.mjs";
import { callDesktopControl, readDesktopControlEndpoint } from "../infrastructure/process/desktop-control.mjs";
import { ensureWrangler } from "../../wrangler-runner.mjs";
import { defaultRuntimeRoot } from "../infrastructure/filesystem/runtime-layout.mjs";
import { publicationRuntimeStatus, startInstalledPublicationRuntime } from "../runtime/runtime-publication-start.mjs";
import { waitForRuntimeReplacement } from "../runtime/publication-readiness.mjs";
import { prepareCommittedAgentHubReleaseVersion } from "../infrastructure/filesystem/release-version.mjs";
import { assertReleaseCloneForPublication } from "../infrastructure/filesystem/release-git-workspace.mjs";
import { publicationCheckpointStore, runPublicationSteps } from "../infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "../infrastructure/persistence/publication-run-store.mjs";
import { completePublication } from "../infrastructure/persistence/publication-completion.mjs";
import { withPublicationLock } from "../infrastructure/process/publication-lock.mjs";
import { stopProcessTree } from "../infrastructure/process/process-tree.mjs";
import { assertCleanPublicationTree, assertCurrentPublicationRevision, currentRevision,
  changedFiles, readPublicationState, writePublicationState } from "../infrastructure/persistence/publication-state.mjs";

// Hub owns these stateful ports. The independently pinned tool owns execution
// order and CLI/build policy; it never imports a Hub checkout or opens its DB.
export async function createExternalPublicationTools({
  toolPackage = null, sourceRoot = path.resolve(import.meta.dirname, "../.."),
} = {}) {
  const tool = toolPackage ?? await readReleaseToolPackage();
  const ports = { sourceRoot, artifactVersionIdentity, calendarVersion, normalizeReleaseTaskIds,
    normalizeReleaseVersion, normalizeTestSelection, resolveTestSelection, verifyTestPlan,
    discoverReleaseTestInventory, RELEASE_CHECK_IDS, freezePreparedPublication, callDesktopControl,
    readDesktopControlEndpoint, ensureWrangler, defaultRuntimeRoot, publicationRuntimeStatus,
    startInstalledPublicationRuntime, waitForRuntimeReplacement, prepareCommittedAgentHubReleaseVersion,
    assertReleaseCloneForPublication, publicationCheckpointStore, runPublicationSteps, publicationRunStore,
    completePublication, withPublicationLock, stopProcessTree, assertCleanPublicationTree,
    assertCurrentPublicationRevision, currentRevision, changedFiles, readPublicationState, writePublicationState };
  const all = (await tool.module("src/publish-all.mjs")).createAllPublicationTools(ports);
  const changed = (await tool.module("src/publish-changed.mjs")).createChangedPublicationTools({ ...ports, ...all });
  return { ...all, ...changed, tool };
}
