import path from "node:path";
import { publicationRunStore } from "../infrastructure/persistence/publication-run-store.mjs";
import { publicationCheckpointStore } from "../infrastructure/persistence/publication-checkpoint.mjs";
import { writePublicationState } from "../infrastructure/persistence/publication-state.mjs";
import { resumePendingPublicationCompletion } from "../infrastructure/persistence/publication-completion.mjs";
import { clearInheritedPublicationOwnership, withPublicationLock } from "../infrastructure/process/publication-lock.mjs";
import { createFrozenReleasePublication } from "../infrastructure/process/frozen-release-publication.mjs";
import { publicationRuntimeStatus } from "./runtime-publication-start.mjs";
import { waitForRuntimeReplacement } from "./publication-readiness.mjs";

function isPending(saved, runtimeRoot) {
  return ["awaiting_restart", "awaiting_finalization", "failed", "running"].includes(saved?.status)
    && saved.identity?.runtimeRoot === runtimeRoot
    && Boolean(saved.progress?.publicationState && saved.progress?.expectedReleaseId);
}

export async function resumeRuntimePublicationCompletion({
  runtimeRoot,
  environment = process.env,
  journal = publicationRunStore({ runtimeRoot, environment }),
  checkpoint = publicationCheckpointStore(path.join(runtimeRoot, "publication-checkpoint.json")),
  lock = withPublicationLock,
  readRuntimeStatus = publicationRuntimeStatus,
  verifyRestart = waitForRuntimeReplacement,
  writeState = (value) => writePublicationState(value, path.join(runtimeRoot, "publication-state.json")),
  createAdapter = createFrozenReleasePublication,
} = {}) {
  if (!runtimeRoot) throw new Error("Publication recovery requires the exact runtime root");
  if (!isPending(await journal.read(), runtimeRoot)) return { status: "not_pending" };
  // A replacement may inherit the publisher's session. It is a different lock
  // owner and must wait for that live publisher, never bypass its lease.
  const lockEnvironment = { ...environment };
  clearInheritedPublicationOwnership(lockEnvironment);
  return lock(async () => {
    const saved = await journal.read();
    if (!isPending(saved, runtimeRoot)) return { status: "not_pending" };
    const finalizePublication = saved.identity.release ? (identity) => createAdapter({
      repositoryRoot: identity.worktreeRoot, runtimeRoot,
    }).finalizePublication(identity) : undefined;
    return resumePendingPublicationCompletion({
      runtimeRoot, journal, checkpoint, readRuntimeStatus, verifyRestart, writeState,
      finalizePublication,
      // The existing publication lock above already owns this entire operation.
      exclusive: (operation) => operation(),
    });
  }, { environment: lockEnvironment, lockTarget: path.join(runtimeRoot, "publication") });
}

export function publicationAwareReadiness({
  markReady,
  runtimeRoot,
  resume = () => resumeRuntimePublicationCompletion({ runtimeRoot }),
  schedule = setImmediate,
  onError = (error) => console.warn(`Publication completion recovery failed: ${error.message ?? error}`),
}) {
  let scheduled = false;
  return async () => {
    await markReady();
    if (scheduled) return;
    scheduled = true;
    // Startup and admission continue without awaiting Git/Task finalization.
    schedule(() => Promise.resolve().then(resume).catch(onError));
  };
}
