export function createCodexTaskSettingsComposition({
  pinnedTaskTitle,
  readCodexThreadTitleHistory,
  sendRpc,
  isCodex,
  getThreadId,
  contextCompactions,
  agentPreferences,
  saveState,
  codexModelLabel,
  reasoningLabels,
}) {
  function codexThreadResponseTitle(thread) {
    return String(thread?.name ?? thread?.preview ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  async function storedCodexThreadTitle(id, fallback = "") {
    const pinnedTitle = pinnedTaskTitle("codex", id);
    if (pinnedTitle) return pinnedTitle;
    const titleHistory = await readCodexThreadTitleHistory(id);
    return titleHistory.recoverableTitle
      || titleHistory.currentTitle
      || fallback
      || `Codex · ${id.slice(0, 8)}`;
  }

  async function resolveResumedCodexThreadTitle(id, thread) {
    const resumedTitle = codexThreadResponseTitle(thread);
    const pinnedTitle = pinnedTaskTitle("codex", id);
    if (pinnedTitle) {
      if (resumedTitle !== pinnedTitle) {
        await sendRpc("thread/name/set", { threadId: id, name: pinnedTitle });
      }
      return pinnedTitle;
    }
    const titleHistory = await readCodexThreadTitleHistory(id);
    const recoveredTitle = titleHistory.recoverableTitle
      && (!resumedTitle || resumedTitle === titleHistory.currentTitle)
      ? titleHistory.recoverableTitle
      : "";
    if (recoveredTitle) {
      await sendRpc("thread/name/set", { threadId: id, name: recoveredTitle });
    }
    return resumedTitle && !recoveredTitle
      ? resumedTitle
      : recoveredTitle
        || titleHistory.currentTitle
        || `Codex · ${id.slice(0, 8)}`;
  }

  async function updateActiveCodexThreadSettings() {
    const threadId = getThreadId();
    if (!isCodex() || !threadId) return;
    if (contextCompactions.isRunning(threadId)) {
      throw new Error("Дождитесь завершения свёртки контекста перед сменой модели или Reasoning");
    }
    await sendRpc("thread/settings/update", {
      threadId,
      model: agentPreferences.codexModel,
      effort: agentPreferences.codexReasoningEffort,
    });
    agentPreferences.rememberCodexTaskSettings();
    await saveState();
  }

  function taskSwitchSettings() {
    if (!isCodex()) return {};
    return {
      model: codexModelLabel(agentPreferences.codexModel),
      reasoning: reasoningLabels[agentPreferences.codexReasoningEffort],
    };
  }

  return {
    codexThreadResponseTitle,
    storedCodexThreadTitle,
    resolveResumedCodexThreadTitle,
    updateActiveCodexThreadSettings,
    taskSwitchSettings,
  };
}
