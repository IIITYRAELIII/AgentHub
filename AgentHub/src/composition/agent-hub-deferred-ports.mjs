import { createDeferredCompositionPort } from "./deferred-composition-port.mjs";

export function createAgentHubDeferredPorts() {
  const runAdmission = createDeferredCompositionPort("run admission wiring", [
    "resolvedExplicitSkillNames", "discardContextCompactionRun", "taskExternalActivity",
    "launchTurn", "startTurn", "cleanupDeferredFiles", "scheduleQueuedInput",
  ]);
  const runtimeCommand = createDeferredCompositionPort("runtime command routing", [
    "taskTitle", "authorize", "reconcile", "handle",
  ]);
  const codexTaskSettings = createDeferredCompositionPort("Codex task settings wiring", [
    "codexThreadResponseTitle", "storedCodexThreadTitle", "resolveResumedCodexThreadTitle",
    "updateActiveCodexThreadSettings", "taskSwitchSettings",
  ]);
  const providerRuntime = createDeferredCompositionPort("provider runtime wiring", [
    "persistManagedRunHistory", "persistClaudeRunHistory", "startClaudeTurn", "steerClaudeTurn",
    "stopClaudeRunProcess", "attachClaudeRunAfterRestart", "handleCodexMessage",
    "completedCodexAnswer", "applyCodexObservedSnapshot", "applyCodexActiveSnapshot",
    "readCodexTaskSnapshot", "scheduleCodexTerminalAudit",
  ]);
  const taskInteraction = createDeferredCompositionPort("task interaction wiring", [
    "readCachedHistory", "refreshHistory", "showTaskMessage", "showLastTaskMessage",
    "resolveTaskViewBinding", "requestApproval", "requestMcpElicitation", "requestUserInput",
    "formatCommandApproval", "formatFileApproval", "formatApprovalMode", "approvalModeKeyboard",
  ]);
  const runtimeRestart = createDeferredCompositionPort("runtime restart wiring", [
    "restartBlockingRuns", "restartBlockingWorkCount", "restartHasBlockingWork", "scheduleDeferredRestartIfReady",
    "restartMessageIsEditable", "announceDesktopRestart", "updateRestartMessage",
    "finalizeRestartMessage", "performRestart", "restartBot",
  ]);
  const taskState = createDeferredCompositionPort("task state wiring", [
    "invalidateTaskCatalog", "syncTaskRun", "persistTaskDiff", "findProject", "activeProject",
    "selectedTask", "selectedTurnTarget", "currentUiContextToken", "uiCallback", "selectedRun",
    "isSelectedRun", "runProject", "runTaskTitle", "pinnedTaskTitle", "pinTaskTitle",
    "pendingTaskTitle", "expectTaskTitleConfirmation",
  ]);
  const telegramShell = createDeferredCompositionPort("Telegram shell wiring", [
    "sendThreadPicker", "sendProjectPicker", "sendAgentPicker", "sendModelPicker",
    "switchCodexModel", "switchModel", "resumeThread", "renameCurrentTask",
    "archiveCurrentThread", "archiveBlockedReason", "sendArchiveMessage",
    "currentStatusSnapshot", "sendStatus", "sendReasoningPicker", "sendCollaborationModePicker",
  ]);
  const telegramDelivery = createDeferredCompositionPort("Telegram delivery wiring", [
    "runMessageBinding", "bindRunMessage", "sendRunMessage", "bindIncomingTaskMessage",
    "deleteTaskMessages", "sendTaskViewText", "sendReliableRunMessage", "sendRunLongMessage",
    "clearDeliveredProgressMessages", "safelyDeliverRunMessage", "finalizeRunDelivery",
    "sendTaskSelectionNotification",
  ]);
  const codexLifecycle = createDeferredCompositionPort("Codex lifecycle wiring", [
    "start", "stop", "restartAfterCrash", "sendRpc", "invalidateThreadRead", "readThread",
    "sendNotification", "respondRpc", "initialize",
  ]);
  const providerStartup = createDeferredCompositionPort("provider startup wiring", [
    "initializeProvider", "attachCodexThread", "createThread", "listThreads",
    "isWorkspaceThread", "threadTitle",
  ]);
  const desktopCommands = createDeferredCompositionPort("Desktop command wiring", [
    "messageTarget", "snapshot", "trustedDeviceUserId", "handleDesktopControl", "reconcileRemoteDesktopControl",
    "forgetDesktopControl",
  ]);
  const deferredInput = createDeferredCompositionPort("deferred input controller", [
    "isProcessing", "cancelSchedule", "scheduleNextForTask", "wakeAll",
  ]);
  const bootstrap = createDeferredCompositionPort("Agent Hub bootstrap", [
    "desktopControlServer",
  ]);
  const runtimeFacades = createDeferredCompositionPort("runtime facades", [
    "setBoundedMapValue", "sendTaskSelectionNotification", "sendTaskSwitchNotification",
    "sendTaskAlreadySelectedNotification", "rememberLastTaskMessage", "savedLastTaskMessage",
    "savedLastTaskMessageRecord", "lastTaskMessageRevision", "deferredTaskMessageAtMs", "latestThreadContextUsage",
    "trackTurnTokenUsage", "consumeTurnTokenTracker", "finalizeCodexRunDelivery",
    "deliverTurnEndNotification", "retryPendingTurnEndNotifications", "waitForTurnEndCompletion",
    "rememberCodexTaskSettings", "restoreCodexTaskSettings", "applyCodexThreadSettings",
    "backfillWorkLogPricingMetadata", "auditClaudeTranscriptSnapshots", "finalizeTaskCatalog",
    "refreshTaskCatalog",
  ]);
  const statePersistence = createDeferredCompositionPort("state persistence", [
    "saveState", "savePinnedTaskTitles",
  ]);
  const runShell = createDeferredCompositionPort("run shell", [
    "refreshTaskDiff",
  ]);
  const deferredInputPresentation = createDeferredCompositionPort("deferred input presentation", [
    "updateDeferredMessage", "updateDeferredDesktopReceipt",
  ]);

  return {
    ports: {
      runAdmission,
      runtimeCommand,
      codexTaskSettings,
      providerRuntime,
      taskInteraction,
      runtimeRestart,
      taskState,
      telegramShell,
      telegramDelivery,
      codexLifecycle,
      providerStartup,
      desktopCommands,
      deferredInput,
      bootstrap,
      runtimeFacades,
      statePersistence,
      runShell,
      deferredInputPresentation,
    },
    api: {
      ...runAdmission.api,
      runtimeCommandTaskTitle: runtimeCommand.api.taskTitle,
      authorizeRuntimeCommand: runtimeCommand.api.authorize,
      reconcileRuntimeCommand: runtimeCommand.api.reconcile,
      handleRuntimeCommand: runtimeCommand.api.handle,
      ...codexTaskSettings.api,
      ...providerRuntime.api,
      ...taskInteraction.api,
      ...runtimeRestart.api,
      ...taskState.api,
      ...telegramShell.api,
      ...telegramDelivery.api,
      startCodexAppServer: codexLifecycle.api.start,
      stopCodexAppServerTree: codexLifecycle.api.stop,
      restartCodexAfterCrash: codexLifecycle.api.restartAfterCrash,
      sendRpc: codexLifecycle.api.sendRpc,
      invalidateCodexThreadRead: codexLifecycle.api.invalidateThreadRead,
      readCodexThread: codexLifecycle.api.readThread,
      sendNotification: codexLifecycle.api.sendNotification,
      respondRpc: codexLifecycle.api.respondRpc,
      initializeCodex: codexLifecycle.api.initialize,
      ...providerStartup.api,
      desktopMessageTarget: desktopCommands.api.messageTarget,
      desktopSnapshot: desktopCommands.api.snapshot,
      desktopTrustedDeviceUserId: desktopCommands.api.trustedDeviceUserId,
      handleDesktopControl: desktopCommands.api.handleDesktopControl,
      reconcileRemoteDesktopControl: desktopCommands.api.reconcileRemoteDesktopControl,
      forgetDesktopControl: desktopCommands.api.forgetDesktopControl,
      isDeferredInputProcessing: deferredInput.api.isProcessing,
      cancelDeferredInputSchedule: deferredInput.api.cancelSchedule,
      scheduleNextDeferredInput: deferredInput.api.scheduleNextForTask,
      wakeDeferredInputs: deferredInput.api.wakeAll,
      desktopControlServer: bootstrap.api.desktopControlServer,
      ...runtimeFacades.api,
      ...statePersistence.api,
      ...runShell.api,
      ...deferredInputPresentation.api,
    },
  };
}
