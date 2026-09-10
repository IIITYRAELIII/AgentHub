import { randomUUID } from "node:crypto";

export const RUNTIME_READINESS_STAGE = "Подтверждение готовности runtime";
export const RELEASE_FINALIZATION_STAGE = "Завершение Workspace-релиза";
export const RECORD_PUBLICATION_STAGE = "Фиксация опубликованной ревизии";

// The run journal owns progress; the existing step checkpoint retains completed
// build/deploy stages until runtime readiness and release completion are proven.
export async function completePublication({
  identity, publicationState, journal, checkpoint, needsRestart, skipRestart,
  readRuntimeStatus, verifyRestart, requestRestart, writeState, finalizePublication,
}) {
  let activeStage = null;
  try {
    const recorded = journal?.progress?.publicationState ?? {
      ...publicationState, generation: randomUUID(), publishedAt: new Date().toISOString(),
    };
    await journal?.updateProgress?.({ publicationState: recorded });
    if (needsRestart) {
      activeStage = RUNTIME_READINESS_STAGE;
      await journal?.stepStarted(RUNTIME_READINESS_STAGE);
      const status = await readRuntimeStatus({ runtimeRoot: identity.runtimeRoot });
      const expectedReleaseId = journal?.progress?.expectedReleaseId || status.current;
      if (!expectedReleaseId) throw new Error("No published runtime is available for readiness verification");
      if (status.current !== expectedReleaseId) throw new Error("Installed runtime changed during publication recovery");
      await journal?.updateProgress?.({ expectedReleaseId });
      const readExpectedStatus = async (options) => {
        const current = await readRuntimeStatus(options);
        if (current.current !== expectedReleaseId) throw new Error("Installed runtime changed during publication recovery");
        return current;
      };
      const alreadyReady = status.running === true && status.ready === true && status.runningRelease === expectedReleaseId;
      let deferred = false;
      if (alreadyReady) {
        await verifyRestart({ runtimeRoot: identity.runtimeRoot, expectedReleaseId, readStatus: readExpectedStatus });
      } else if (skipRestart) {
        deferred = true;
      } else {
        deferred = (await requestRestart({ readStatus: readExpectedStatus }))?.deferred === true;
      }
      if (deferred) {
        await journal?.stepFinished(RUNTIME_READINESS_STAGE, { status: "waiting" });
        await journal?.finish("awaiting_restart");
        return { status: "awaiting_restart", expectedReleaseId, publicationOnly: !finalizePublication };
      }
      await journal?.stepFinished(RUNTIME_READINESS_STAGE, { status: "completed" });
    }
    activeStage = RECORD_PUBLICATION_STAGE;
    await journal?.stepStarted(RECORD_PUBLICATION_STAGE);
    await writeState(recorded);
    await journal?.stepFinished(RECORD_PUBLICATION_STAGE, { status: "completed" });
    if (finalizePublication) {
      activeStage = RELEASE_FINALIZATION_STAGE;
      await journal?.stepStarted(RELEASE_FINALIZATION_STAGE);
      const finalizationCommandId = journal?.progress?.finalizationCommandId || randomUUID();
      await journal?.updateProgress?.({ finalizationCommandId });
      const result = await finalizePublication({ ...identity, publication: recorded, finalizationCommandId });
      if (result?.status !== "completed") {
        if (result?.status === "retry_required") {
          await journal?.updateProgress?.({ finalizationCommandId: randomUUID() });
        }
        await journal?.stepFinished(RELEASE_FINALIZATION_STAGE, { status: "waiting" });
        await journal?.finish("awaiting_finalization");
        return { status: "awaiting_finalization", finalization: result, publicationOnly: false };
      }
      await journal?.stepFinished(RELEASE_FINALIZATION_STAGE, { status: "completed" });
    }
    if (checkpoint) await checkpoint.clear();
    const status = finalizePublication ? "succeeded" : "published";
    await journal?.finish(status);
    return { status, publicationOnly: !finalizePublication };
  } catch (error) {
    if (activeStage) await journal?.stepFinished(activeStage, { status: "failed", error });
    throw error;
  }
}

export async function resumePendingPublicationCompletion({
  runtimeRoot, journal, checkpoint, readRuntimeStatus, verifyRestart,
  writeState, finalizePublication, exclusive,
}) {
  return exclusive(async () => {
    const saved = await journal.read();
    if (!saved || !["awaiting_restart", "awaiting_finalization", "failed", "running"].includes(saved.status)
      || saved.identity?.runtimeRoot !== runtimeRoot
      || !saved.progress?.publicationState || !saved.progress?.expectedReleaseId) return { status: "not_pending" };
    if (saved.identity.release && !finalizePublication) throw new Error("Pending Workspace release requires its finalization adapter");
    await journal.start(saved.identity, []);
    try {
      return await completePublication({
        identity: saved.identity, publicationState: saved.progress.publicationState,
        journal, checkpoint, needsRestart: true, skipRestart: true,
        readRuntimeStatus, verifyRestart, writeState, finalizePublication,
        requestRestart: () => { throw new Error("Completion recovery cannot request a runtime restart"); },
      });
    } catch (error) {
      await journal.finish("failed", error);
      throw error;
    }
  });
}
