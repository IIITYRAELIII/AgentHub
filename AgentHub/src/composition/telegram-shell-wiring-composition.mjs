import { TelegramTaskPickerService } from "../interfaces/telegram/task-picker.mjs";

export function createTelegramShellWiring({
  taskPicker,
  settingsMenu,
  taskActions,
  statusController,
  activeProjectRoot,
  activeProvider,
  agentPreferences,
  codexModelLabel,
  currentChatId,
}) {
  const picker = new TelegramTaskPickerService(taskPicker);

  return {
    sendThreadPicker: (...args) => picker.send(...args),
    sendProjectPicker: () => settingsMenu.projectsPicker({
      activeProjectRoot: activeProjectRoot(),
    }),
    sendAgentPicker: () => settingsMenu.agentPicker({
      provider: activeProvider(),
    }),
    sendModelPicker: () => settingsMenu.modelPicker({
      provider: activeProvider(),
      codexModel: agentPreferences.codexModel,
      claudeModel: agentPreferences.claudeModel,
      codexModelLabel: codexModelLabel(agentPreferences.codexModel),
    }),
    sendReasoningPicker: () => settingsMenu.reasoningPicker({
      provider: activeProvider(),
      value: agentPreferences.current(activeProvider()).reasoningEffort,
    }),
    sendCollaborationModePicker: () => settingsMenu.collaborationModePicker({
      provider: activeProvider(),
      value: agentPreferences.current(activeProvider()).collaborationMode,
    }),
    switchCodexModel: (value) => agentPreferences.setCodexModel(value),
    switchModel: (value) => agentPreferences.setClaudeModel(value),
    resumeThread: (...args) => taskActions.resume(...args),
    renameCurrentTask: (...args) => taskActions.rename(...args),
    archiveCurrentThread: (...args) => taskActions.archive(...args),
    archiveBlockedReason: (...args) => taskActions.archiveBlockedReason(...args),
    sendArchiveMessage: (result, targetChatId = currentChatId()) => (
      taskActions.sendArchive(result, targetChatId)
    ),
    currentStatusSnapshot: (targetChatId = currentChatId()) => (
      taskActions.statusSnapshot(targetChatId)
    ),
    sendStatus: (snapshot) => statusController.send(snapshot),
  };
}
