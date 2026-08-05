import { randomUUID } from "node:crypto";
import { TelegramDeliveryService } from "../interfaces/telegram/telegram-delivery-service.mjs";
import { TaskProgressController } from "../interfaces/telegram/task-progress-controller.mjs";
import { RunProgressPresentation } from "../application/run-progress-presentation.mjs";

export function createRunPresentationComposition({
  telegramLimit,
  claudeModelLabels,
  codexReasoningLabels,
  codexModelLabel,
  taskExecutionRuntimeLabel,
  formatProgressHeading,
  formatProgressHeartbeat,
  showProject,
  runTaskTitle,
  runProject,
  agentPreferences,
  taskExecutionOwners,
  dataDir,
  appendMessageBindings,
  readMessageBindings,
  removeMessageBindings,
  approvalController,
  samePath,
  taskRuns,
  telegram,
  sendMessageTo,
  deliveryOutbox,
  scheduleDeliveryOutboxFlush,
  taskRunKey,
  mediaController,
  taskViewCallbackData,
  managedRunLifecycle,
  runJournal,
  rememberLastSeenTurn,
  refreshTaskDiff,
  selectedTask,
  activeTaskTitle,
  activeProjectName,
  taskSwitchSettings,
  showLastMessageReplyMarkup,
  formatTaskSwitchMessage,
  formatTaskAlreadySelectedMessage,
  saveState,
  retainProgressMessageAfterEditError,
}) {
  const presentation = new RunProgressPresentation({
    telegramLimit,
    claudeModelLabels,
    codexReasoningLabels,
    codexModelLabel,
    taskExecutionRuntimeLabel,
    formatProgressHeading,
    formatProgressHeartbeat,
    showProject,
    taskTitle: runTaskTitle,
    projectName: (run) => runProject(run).name,
    currentCodexModel: () => agentPreferences.codexModel,
    currentClaudeModel: () => agentPreferences.claudeModel,
    currentCodexReasoning: () => agentPreferences.codexReasoningEffort,
    currentClaudeReasoning: () => agentPreferences.claudeReasoningEffort,
    taskExecutionOwners,
  });

  let taskProgress;
  const telegramDeliveryService = new TelegramDeliveryService({
    dataDir,
    messageLimit: telegramLimit,
    appendBindings: appendMessageBindings,
    readBindings: readMessageBindings,
    removeBindings: removeMessageBindings,
    pendingApprovalMessageIds: (targetChatId) => [...approvalController.pending.values()]
      .filter((approval) => approval.chatId === targetChatId)
      .map((approval) => approval.messageId)
      .filter(Number.isSafeInteger),
    runTaskTitle,
    samePath,
    taskRuns,
    telegram,
    sendMessageTo,
    deliveryOutbox,
    scheduleDeliveryFlush: scheduleDeliveryOutboxFlush,
    taskRunKey,
    randomId: randomUUID,
    progressHeading: (run, done) => presentation.heading(run, done),
    rememberSpeechText: (text, force) => mediaController.rememberSpeechText(text, force),
    taskViewCallbackData,
    completeRun: (run) => managedRunLifecycle.complete(run),
    rememberLastMessage: (run, text) => runJournal.rememberLastMessage(run, text),
    rememberLastSeenTurn,
    refreshTaskDiff,
    selectedTask,
    activeTaskTitle,
    activeProjectName,
    showProject,
    taskSwitchSettings,
    showLastMessageReplyMarkup,
    formatTaskSwitchMessage,
    formatTaskAlreadySelectedMessage,
    getProgressController: () => taskProgress,
    saveState,
  });

  taskProgress = new TaskProgressController({
    isCurrentRun: (run) => taskRuns.forTask(run) === run,
    render: (run, done) => presentation.render(run, done),
    sendInitial: (run, text) => telegramDeliveryService.sendReliableRunMessage(
      run,
      text,
      {},
      { kind: "progress" },
      { supersedeKey: telegramDeliveryService.progressOutboxKey(run) },
    ),
    deleteMessage: (run, messageId) => telegram("deleteMessage", {
      chat_id: run.chatId,
      message_id: messageId,
    }),
    removeBindings: (run, messageIds) => telegramDeliveryService
      .removeStoredBindings(run.chatId, messageIds),
    editMessage: (run, messageId, text) => telegram("editMessageText", {
      chat_id: run.chatId,
      message_id: messageId,
      text,
    }),
    persist: saveState,
    retainAfterEditError: retainProgressMessageAfterEditError,
  });

  return { telegramDeliveryService, taskProgress };
}
