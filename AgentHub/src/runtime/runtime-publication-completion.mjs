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

function schedulePublicationCompletion(operation, delayMs = 0) {
  const handle = delayMs > 0 ? setTimeout(operation, delayMs) : setImmediate(operation);
  handle.unref?.();
  return handle;
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
  schedule = schedulePublicationCompletion,
  retryDelayMs = 1_000,
  maxFinalizationAttempts = 3,
  onError = (error) => console.warn(`Publication completion recovery failed: ${error.message ?? error}`),
}) {
  if (!Number.isInteger(maxFinalizationAttempts) || maxFinalizationAttempts < 1) {
    throw new TypeError("Publication completion recovery requires a positive attempt limit");
  }
  let activated = false;
  let scheduled = false;
  let running = false;
  let attempts = 0;
  const enqueue = (delayMs = 0) => {
    if (scheduled || running) return;
    scheduled = true;
    schedule(async () => {
      scheduled = false;
      running = true;
      let retry = false;
      try {
        attempts += 1;
        const result = await resume();
        if (result?.status === "awaiting_finalization") {
          retry = attempts < maxFinalizationAttempts;
          if (!retry) {
            onError(new Error(
              `Publication completion remains awaiting_finalization after ${attempts} automatic attempts`,
            ));
          }
        }
      } catch (error) {
        onError(error);
      } finally {
        running = false;
        if (retry) enqueue(retryDelayMs);
      }
    }, delayMs);
  };
  return async () => {
    await markReady();
    if (activated) return;
    activated = true;
    // Startup and admission continue without awaiting Git/Task finalization.
    enqueue();
  };
}
