import { createRuntimeFileRemoval } from "../runtime/test-contour-runtime-effects.mjs";
import {
  forwardBundleAttachmentPaths,
  restoreForwardBundle,
} from "../interfaces/telegram/telegram-forward-bundle.mjs";
import { restoreDeferredInput } from "../domain/deferred-input.mjs";
import { serializableTaskRun, persistedLocalExecutionIdentity } from "../domain/task-runs.mjs";
import { ProviderRunTerminalStore } from "../infrastructure/persistence/provider-run-terminal-store.mjs";
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

export function restorePersistedTaskRun(savedRun, restoredChatId, lifecycleStore = null) {
  if (!savedRun || typeof savedRun !== "object"
    || !["running", "finishing"].includes(savedRun.status)) return null;
  const observer = savedRun.observer === true;
  const executionOwner = normalizeTaskExecutionOwner(savedRun.executionOwner)
    ?? (savedRun.provider === "codex"
      ? observer
        ? TASK_EXECUTION_OWNERS.EXTERNAL
        : TASK_EXECUTION_OWNERS.HUB
      : null);
  const run = {
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
    progressStage: String(savedRun.progressStage ?? "Проверка завершения сохранённого хода…"),
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
    localAdmissionReleased: false,
    completionPreparing: null,
    admissionReleasing: null,
  };
  const identity = persistedLocalExecutionIdentity(savedRun);
  const retirement = identity && lifecycleStore?.getLocalExecutionRetirement(identity);
  if (retirement) {
    run.localExecutionRetirement = retirement;
    run.localAdmissionReleased = true;
  }
  return run;
}

export async function createRuntimeStateRestorationComposition({
  config,
  projects,
  maximumDeferredInputs,
  runtimeStateStore,
  commandTrace = null,
  canonicalizeProjectRoots,
  restoreContext,
  snapshotContext,
}) {
  const removeRuntimeFile = createRuntimeFileRemoval(config);
  const deferredInputTtlMs = config.deferredInputTtlHours * 60 * 60 * 1000;
  const lifecycleStore = new ProviderRunTerminalStore({ dataDir: config.dataDir });
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
      restoreTaskRun: async (saved, chatId) => {
        try {
          const identity = persistedLocalExecutionIdentity(saved);
          if (!identity) return null;
          // The single-instance owner has acquired this data root before this
          // canonical snapshot read. Retire only its former local admission;
          // do not inspect or decide the provider's current execution/outcome.
          const revisedStart = saved.localExecutionRetirement?.proof?.kind === "previous-hub-local-execution"
            && (saved.startedAt ?? null) !== identity.startedAt;
          const record = () => {
            if (revisedStart) {
              const existing = lifecycleStore.getLocalExecutionRetirement(identity);
              if (!existing) throw new Error("Prior local execution retirement record is missing");
              return existing;
            }
            return lifecycleStore.recordLocalExecutionRetirement({ identity, proof: {
              kind: "previous-hub-local-execution", source: "canonical-runtime-snapshot",
              restoredAt: new Date().toISOString(),
            } });
          };
          if (commandTrace?.measureBestEffort) await commandTrace.measureBestEffort({
            commandId: identity.commandId ?? identity.runId,
            stage: "startup-local-execution-retirement", transport: "lifecycle",
            metadata: { runId: identity.runId, threadId: identity.threadId, turnId: identity.turnId },
          }, record);
          else await record();
          return restorePersistedTaskRun(saved, chatId, lifecycleStore);
        } catch (error) {
          throw Object.assign(new Error("Cannot persist previous Hub local execution disposition", { cause: error }),
            { code: "ERR_LOCAL_EXECUTION_RETIREMENT" });
        }
      },
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
