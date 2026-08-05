import { AgentPreferencesStore } from "../application/agent-preferences-store.mjs";
import { TaskMetadataStore } from "../application/task-metadata-store.mjs";
import { TaskSelectionStore } from "../application/task-selection-store.mjs";
import {
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
  resolveCodexThreadSettings,
} from "../providers/codex/codex-settings.mjs";

export function createStateComposition({
  config,
  initialProvider,
  initialProjectRoot,
  codexModels,
  claudeModels,
  defaultCodexModel,
  defaultCodexReasoningEffort,
  normalizeCodexModel,
}) {
  const taskMetadata = new TaskMetadataStore({
    validReasoningEfforts: CODEX_REASONING_EFFORTS,
  });
  const selectionStore = new TaskSelectionStore({
    activeProvider: initialProvider,
    activeProjectRoot: initialProjectRoot,
    threadId: null,
    activeThreadTitle: "",
  });
  const agentPreferences = new AgentPreferencesStore({
    selectionStore,
    taskMetadata,
    codexModels: codexModels.map((model) => model.value),
    claudeModels,
    reasoningEfforts: CODEX_REASONING_EFFORTS,
    collaborationModes: CODEX_COLLABORATION_MODES,
    defaultCodexModel,
    defaultCodexReasoningEffort,
    defaultCodexCollaborationMode: config.codexCollaborationMode,
    defaultClaudeModel: config.claudeModel,
    defaultClaudeReasoningEffort: config.claudeReasoningEffort,
    defaultClaudeCollaborationMode: config.claudeCollaborationMode,
    normalizeCodexModel,
    resolveCodexThreadSettings,
  });
  return { taskMetadata, selectionStore, agentPreferences };
}
