const AGENT_SETTING_KEYS = ["provider", "model", "reasoning", "mode"];

export function createStreamAgentSettingsService({
  workspaceCatalog,
  selectionStore,
  agentPreferences,
}) {
  const streamId = (value) => String(value ?? "").trim();

  const currentAgentSettings = (provider) => {
    const preferences = agentPreferences.current(provider);
    return {
      provider,
      model: preferences.model,
      reasoning: preferences.reasoningEffort,
      mode: preferences.collaborationMode,
    };
  };

  const remember = (requestedStreamId = selectionStore.streamId) => {
    const id = streamId(requestedStreamId);
    if (!id) return null;
    const stream = workspaceCatalog.stream(id);
    if (!stream) return null;
    const next = { ...(stream.settings ?? {}), ...currentAgentSettings(selectionStore.activeProvider) };
    if (AGENT_SETTING_KEYS.every((key) => stream.settings?.[key] === next[key])) return stream;
    return workspaceCatalog.updateStreamSettings(id, next);
  };

  const apply = (requestedStreamId) => {
    const id = streamId(requestedStreamId);
    if (!id) return null;
    const stream = workspaceCatalog.stream(id);
    if (!stream) return null;
    const settings = stream.settings ?? {};
    const codex = selectionStore.activeProvider === "codex";
    const restore = (stored, fallback, set) => {
      for (const candidate of [stored, fallback]) {
        if (!String(candidate ?? "").trim()) continue;
        try {
          set(candidate);
          return candidate;
        } catch {
          // Try the provider default.
        }
      }
      return null;
    };
    const resolved = {
      model: restore(
        settings.model,
        codex ? agentPreferences.defaultCodexModel : agentPreferences.defaultClaudeModel,
        (value) => (codex
          ? agentPreferences.setCodexModel(value)
          : agentPreferences.setClaudeModel(value)),
      ),
      reasoning: restore(
        settings.reasoning,
        codex
          ? agentPreferences.defaultCodexReasoningEffort
          : agentPreferences.defaultClaudeReasoningEffort,
        (value) => (codex
          ? agentPreferences.setCodexReasoning(value)
          : agentPreferences.setClaudeReasoning(value)),
      ),
      mode: restore(
        settings.mode,
        codex
          ? agentPreferences.defaultCodexCollaborationMode
          : agentPreferences.defaultClaudeCollaborationMode,
        (value) => (codex
          ? agentPreferences.setCodexMode(value)
          : agentPreferences.setClaudeMode(value)),
      ),
    };
    return { ...resolved, explicit: Boolean(String(settings.model ?? "").trim()) };
  };

  return Object.freeze({ remember, apply });
}
