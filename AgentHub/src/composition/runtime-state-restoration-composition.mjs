import { createRuntimeFileRemoval } from "../runtime/test-contour-runtime-effects.mjs";
import {
  forwardBundleAttachmentPaths,
  restoreForwardBundle,
} from "../interfaces/telegram/telegram-forward-bundle.mjs";
import { restoreDeferredInput } from "../domain/deferred-input.mjs";
import { serializableTaskRun } from "../domain/task-runs.mjs";
import {
  normalizeTaskExecutionOwner,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
} from "../domain/task-execution-owner.mjs";
import { isRetryableDeferredLaunchError } from "../application/deferred-input-controller.mjs";
import {
  createHubRuntimeSnapshot,
  HubRuntimeStateCoordinator,
  restoreHubRuntimeSnapshot,
} from "../application/hub-runtime-state-coordinator.mjs";

function restorePersistedTaskRun(savedRun, restoredChatId) {
  if (!savedRun || typeof savedRun !== "object"
    || !["running", "finishing"].includes(savedRun.status)) return null;
  const observer = savedRun.observer === true;
  const executionOwner = normalizeTaskExecutionOwner(savedRun.executionOwner)
    ?? (savedRun.provider === "codex"
      ? observer
        ? TASK_EXECUTION_OWNERS.EXTERNAL
        : TASK_EXECUTION_OWNERS.HUB
      : null);
  return {
    ...savedRun,
    observer,
    executionOwner,
    appServer: savedRun.provider === "codex"
      ? taskExecutionRuntimeLabel(executionOwner)
      : savedRun.appServer,
    status: "running",
    chatId: Number.isSafeInteger(savedRun.chatId) ? savedRun.chatId : restoredChatId,
    responseText: String(savedRun.responseText ?? ""),
    observedInitialResponseText: typeof savedRun.observedInitialResponseText === "string"
      ? savedRun.observedInitialResponseText
      : String(savedRun.responseText ?? ""),
    observedResponseChanged: savedRun.observedResponseChanged === true,
    progressStage: String(savedRun.progressStage ?? "Восстановление потока…"),
    progressReasoning: String(savedRun.progressReasoning ?? ""),
    lastMeaningfulProgressAt: String(
      savedRun.lastMeaningfulProgressAt
        ?? savedRun.progressHeartbeatAt
        ?? savedRun.startedAt
        ?? new Date().toISOString(),
    ),
    lastProgressText: String(savedRun.lastProgressText ?? ""),
    progressMessageIds: Array.isArray(savedRun.progressMessageIds)
      ? savedRun.progressMessageIds.filter(Number.isSafeInteger)
      : Number.isSafeInteger(savedRun.progressMessageId)
        ? [savedRun.progressMessageId]
        : [],
    progressStartTimer: null,
    progressTimer: null,
    progressUpdateInFlight: false,
    progressUpdatePending: false,
    process: null,
  };
}

export async function createRuntimeStateRestorationComposition({
  config,
  projects,
  maximumDeferredInputs,
  runtimeStateStore,
  canonicalizeProjectRoots,
  restoreContext,
  snapshotContext,
}) {
  const removeRuntimeFile = createRuntimeFileRemoval(config);
  const deferredInputTtlMs = config.deferredInputTtlHours * 60 * 60 * 1000;
  const runtimeStateCoordinator = new HubRuntimeStateCoordinator({
    store: runtimeStateStore,
    canonicalize: (value) => canonicalizeProjectRoots(value, projects),
    restoreSnapshot: (saved) => restoreHubRuntimeSnapshot(saved, {
      ...restoreContext,
      restoreDeferredInput,
      deferredInputOptions: {
        guardConcurrentRepositoryWrites: config.guardConcurrentRepositoryWrites,
        persistentFile: restoreContext.isLegacyDesktopAttachmentFile,
      },
      isRetryableDeferredLaunchError,
      restoreForwardBundle,
      forwardBundleAttachmentPaths,
      removeFiles: (files) => Promise.all(files.map((file) => removeRuntimeFile(file))),
      deferredInputTtlMs,
      maximumDeferredInputs,
      restoreTaskRun: restorePersistedTaskRun,
    }),
    createSnapshot: () => createHubRuntimeSnapshot({
      ...snapshotContext,
      chatId: snapshotContext.getChatId(),
      updateOffset: snapshotContext.getUpdateOffset(),
      restartRequest: snapshotContext.getRestartRequest(),
      codexHookReceipts: snapshotContext.getCodexHookReceipts(),
      serializableTaskRun,
    }),
  });
  const restoredRuntimeState = await runtimeStateCoordinator.restore();
  return {
    runtimeStateCoordinator,
    stateLoadFailed: restoredRuntimeState.failed,
    restoredState: restoredRuntimeState.value,
  };
}
