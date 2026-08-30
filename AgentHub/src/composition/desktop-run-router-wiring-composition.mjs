import path from "node:path";
import { unlink } from "node:fs/promises";
import {
  deferredResponseAnnotations,
  pendingInputKeyboard,
  replaceDeferredInputText,
} from "../domain/deferred-input.mjs";
import { runInputPreview } from "../application/managed-run-lifecycle-service.mjs";
import { commandClientContext } from "../application/application-command-service.mjs";
import { createDesktopRunInputComposition } from "./desktop-run-input-composition.mjs";
import { createDesktopRouterComposition } from "./desktop-router-composition.mjs";
import { DesktopTaskBoardController } from "../interfaces/desktop/desktop-task-board-controller.mjs";
import { TaskBoardLaunchService } from "../application/task-board-launch-service.mjs";
import { taskReferenceDescriptor } from "../domain/task-board-task.mjs";
import { publicUsageSyncStatus } from "../interfaces/web/mini-app-journal-data.mjs";

export function createDesktopRunRouterWiring({
  config,
  constants,
  state,
  services,
  desktop,
}) {
  const compactContext = async (params) => (
    services.startManualCompaction(await desktop.messageTarget(params))
  );
  function usageSyncService() {
    if (!services.usageSyncAuto) throw new Error("Синхронизация расхода недоступна");
    return services.usageSyncAuto;
  }

  async function usageSyncStatus() {
    const remoteConfig = await services.usageSyncRemoteConfigStore?.load?.().catch(() => null);
    const labelStatus = await services.usageSyncAuto?.deviceLabelStatus?.().catch(() => null);
    return publicUsageSyncStatus({ ...(remoteConfig ?? {}), ...(labelStatus ?? {}) });
  }

  async function usageSyncResponse(result) {
    return {
      ok: true,
      result,
      usageSync: await usageSyncStatus(),
      journal: null,
    };
  }

  async function usageSyncNow() {
    return usageSyncResponse(await usageSyncService().sync());
  }

  async function usageSyncInvite() {
    return usageSyncResponse(await usageSyncService().createEnrollmentCode({ ttlSeconds: 10_800 }));
  }

  async function usageSyncEnroll(params = {}) {
    return usageSyncResponse(await usageSyncService().enroll({
      serverUrl: params.serverUrl,
      code: params.code,
    }));
  }

  async function usageSyncDeviceLabel(params = {}) {
    return usageSyncResponse(await usageSyncService().setDeviceLabel(params.deviceLabel));
  }

  const runInputs = createDesktopRunInputComposition({
    deferredInput: {
      store: services.deferredInputs,
      maxItems: constants.maxDeferredInputs,
      persist: services.saveState,
      persistIntake: services.persistDeferredIntake,
      commandTrace: services.commandTrace,
      removeFiles: (files) => Promise.all(files.map((file) => unlink(file).catch(() => {}))),
      notify: async (item, { executionOwner, conflictTask }) => {
        const preview = runInputPreview(item.input);
        const runtime = item.provider === "codex"
          ? services.executionRuntimeLabel(executionOwner)
          : executionOwner === constants.taskExecutionOwners.HUB
            ? services.executionRuntimeLabel(constants.taskExecutionOwners.HUB)
            : "Внешний Claude CLI";
        const conflictText = item.conflictKind === "repository"
          ? `Поток «${conflictTask?.taskTitle ?? "Без названия"}» уже работает с тем же Git-репозиторием через ${runtime}. Параллельная запись может смешать изменения.`
          : item.conflictKind === "activity-unknown"
            ? "Claude оставил незавершённый транскрипт, но давно не записывал новые события. Нельзя надёжно определить, продолжает ли работать внешний процесс."
            : `Выбранный поток уже выполняется через ${runtime}.`;
        return services.sendMessageTo(
          item.chatId,
          `${conflictText} Новое сообщение сохранено и не потеряно.`
            + `${preview ? `\n\n${preview.slice(0, 700)}` : ""}\n\nЧто сделать?`,
          { reply_markup: pendingInputKeyboard(item.id, { allowForce: item.allowForce }) },
        );
      },
    },
    conflictPolicy: {
      enabled: () => config.guardConcurrentRepositoryWrites,
      resolveRepoRoots: services.resolveRepoRoots,
      taskCatalog: services.refreshCatalog,
      activeRuns: services.activeRuns,
      findConflict: services.findConflict,
    },
    coordinator: {
      taskRuns: services.taskRuns,
      providers: services.providers,
      externalActivity: services.externalActivity,
      beginRun: services.beginRun,
      rollbackAdmission: services.rollbackAdmission,
      launchTurn: services.launchTurn,
      describeAttachments: services.describeAttachments,
      hasDeferredBacklog: services.hasDeferredBacklog,
      isMaintenanceActive: services.isMaintenanceActive,
      scheduleDeferred: services.scheduleDeferred,
      setProgressStage: services.setProgressStage,
      noteRunActivity: services.noteRunActivity,
      scheduleProgressUpdate: services.scheduleProgressUpdate,
      bindDashboardTask: ({ run, taskId }) => {
        const stream = services.workspaceCatalog.stream(run.streamId);
        if (!stream) throw new Error("Task-started run has no Workspace Stream");
        return services.taskBoard.claim({
          id: taskId,
          workspaceId: stream.workspaceId,
          streamId: stream.id,
          provider: run.provider,
          threadId: run.threadId,
          turnId: run.turnId,
          gitBaseline: run.gitBaseline ?? null,
        });
      },
      notifyInputStart: (target) => {
        if (target?.telegramDeliveryRequested === false) return;
        void services.telegram("sendChatAction", {
          chat_id: target.chatId ?? state.chatId(),
          action: "typing",
        }).catch(() => {});
      },
    },
    messageController: {
      attachmentPaths: services.attachmentPaths,
      describeAttachments: services.describeAttachments,
      resolveTaskReferences: async (values, target) => {
        if (values == null) return [];
        if (!Array.isArray(values) || values.length > 8) {
          throw new Error("Можно приложить не более восьми Dashboard Task");
        }
        if (!services.workspaceCatalog.stream(target.streamId)) {
          throw new Error("Stream для Task-вложения не найден");
        }
        const result = [];
        const seen = new Set();
        for (const value of values) {
          const taskId = String(value?.taskId ?? "").trim();
          if (!taskId || seen.has(taskId)) continue;
          const task = services.taskBoard.task(taskId);
          seen.add(taskId);
          result.push(taskReferenceDescriptor(task, { intent: value?.intent }));
        }
        return result;
      },
      resolveTarget: desktop.messageTarget,
      receipts: services.receipts,
      persistReceipts: services.saveState,
      durableIntake: true,
      commandTrace: services.commandTrace,
    },
    desktopDeferredInput: {
      pendingInputs: services.pendingInputs,
      queuedInputs: services.queuedInputs,
      findReceiptByResultId: services.findReceiptByResultId,
      isProcessing: services.isDeferredInputProcessing,
      cancelSchedule: services.cancelDeferredInputSchedule,
      responseAnnotations: deferredResponseAnnotations,
      replaceInputText: replaceDeferredInputText,
      saveState: services.saveState,
      updateReceipt: services.updateDeferredReceipt,
      cleanupFiles: services.cleanupDeferredFiles,
      updateMessage: services.updateDeferredMessage,
      scheduleNext: services.scheduleNextDeferredInput,
      scheduleQueued: services.scheduleQueuedInput,
      selectTask: desktop.selectTaskFromBinding,
      clientContext: commandClientContext,
      startTurn: services.startTurn,
      startDeferred: (item) => services.runCoordinator.startDeferred(item),
      runForTask: services.runForTask,
      describeAttachments: services.describeAttachments,
      selectedTask: state.selectedTask,
      dispatchCommand: desktop.dispatchApplicationCommand,
      activeTitle: state.activeTaskTitle,
      snapshot: desktop.snapshot,
    },
  });

  function telegramMessageCommandContext(message) {
    return {
      source: "telegram",
      userId: message?.from?.id,
      clientId: `telegram:${message?.chat?.id ?? "unknown"}`,
      commandId: Number.isSafeInteger(message?.message_id)
        ? `message:${message.chat.id}:${message.message_id}`
        : null,
    };
  }

  function telegramCallbackCommandContext(callback) {
    return {
      source: "telegram",
      userId: callback?.from?.id,
      clientId: `telegram:${callback?.message?.chat?.id ?? "unknown"}`,
      commandId: callback?.id ? `callback:${callback.id}` : null,
    };
  }

  function dispatchTelegramSetting(callback, name, value) {
    const params = { ...state.selectedTask(), name, value };
    return desktop.dispatchApplicationCommand(
      "settings.update",
      params,
      telegramCallbackCommandContext(callback),
      { target: desktop.settingCommandTarget(params) },
    );
  }

  const taskBoardLauncher = new TaskBoardLaunchService({
    taskBoard: services.taskBoard,
    workspaceCatalog: services.workspaceCatalog,
    taskGitWorkspaces: services.taskGitWorkspaces,
    dispatchCommand: desktop.dispatchApplicationCommand,
    sendMessage: runInputs.desktopMessageController.sendMessage,
    recordEvent: typeof services.workspaceCatalog.recordWorkspaceEvent === "function"
      ? (event) => services.workspaceCatalog.recordWorkspaceEvent(event)
      : null,
  });
  const taskBoardController = new DesktopTaskBoardController({
    taskBoard: services.taskBoard,
    voiceTranscriber: services.taskVoiceTranscriber,
    workspaceCatalog: services.workspaceCatalog,
    taskLauncher: taskBoardLauncher,
    snapshot: desktop.snapshot,
  });

  const router = createDesktopRouterComposition({
    handlers: {
      snapshot: desktop.snapshot,
      runtimeHealth: desktop.runtimeHealth,
      taskHistory: desktop.taskHistory,
      rateLimitHistory: desktop.rateLimitHistory,
      usageHistory: desktop.usageHistory,
      search: desktop.search,
      workspaceMessageSearch: desktop.workspaceMessageSearch,
      markTaskRead: desktop.markTaskRead,
      openTask: desktop.openTask,
      openTurn: desktop.openTurn,
      workspaceMessageOpen: desktop.openTurn,
      sendMessage: runInputs.desktopMessageController.sendMessage,
      taskDiff: desktop.taskDiff,
      deferredInput: runInputs.desktopDeferredInput,
      statusDetails: desktop.statusDetails,
      speakLastAnswer: desktop.speakLastAnswer,
      restartServer: desktop.restartServer,
      setAutostart: services.setAutostart,
      updateServerConfiguration: services.updateServerConfiguration,
      readPreTurnInstructions: services.readPreTurnInstructions,
      updateGlobalPreTurnInstructions: services.updateGlobalPreTurnInstructions,
      readRootAgents: services.readRootAgents,
      updateRootAgents: services.updateRootAgents,
      compactContext,
      openAttachment: desktop.openAttachment,
      submitBugReport: desktop.submitBugReport,
      reportDiagnostic: desktop.reportDiagnostic,
      trustedDevices: desktop.trustedDevices,
      createDevicePairing: desktop.createDevicePairing,
      revokeDevice: desktop.revokeDevice,
      boardTaskCreate: (params) => taskBoardController.create(params),
      boardTaskIngest: (params) => taskBoardController.ingest(params),
      boardTaskUpdate: (params) => taskBoardController.update(params),
      boardTaskStatus: (params) => taskBoardController.status(params),
      boardTaskMove: (params) => taskBoardController.move(params),
      boardTaskComplete: (params) => taskBoardController.complete(params),
      boardTaskRemove: (params) => taskBoardController.remove(params),
      boardTaskRetryTriage: (params) => taskBoardController.retryTriage(params),
      boardTaskStart: (params, context) => taskBoardController.start(params, context),
      boardColumnMove: (params) => taskBoardController.moveColumn(params),
      boardColumnComment: (params) => taskBoardController.updateColumnComment(params),
      boardWorkspaceMove: (params) => taskBoardController.moveWorkspace(params),
      usageSync: usageSyncNow,
      usageSyncInvite,
      usageSyncEnroll,
      usageSyncDeviceLabel,
      commandTraceTimeline: (params) => services.commandTrace.readCommandTimeline(
        params?.commandId,
        { limit: params?.limit },
      ),
      commandTracePercentiles: (params) => services.commandTrace.readStagePercentiles(params),
      commandTraceStats: () => services.commandTrace.backpressureStats(),
    },
    commands: desktop.applicationCommands,
    receiptFile: path.join(config.dataDir, "desktop-control-receipts.sqlite"),
    receiptOptions: {
      legacyFile: path.join(config.dataDir, "desktop-control-receipts.json"),
    },
    commandTrace: services.commandTrace,
  });

  return {
    ...runInputs,
    ...router,
    telegramMessageCommandContext,
    telegramCallbackCommandContext,
    dispatchTelegramSetting,
    taskBoardLauncher,
  };
}
