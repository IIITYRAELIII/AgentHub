import { configuredProjectForTaskWorkingDirectory } from "../domain/task-project-root.mjs";

export function createDesktopTaskCreationPreparation({
  selectedProjectRoot,
  findProject,
  taskGitWorkspaces,
  selectionStore,
  agentPreferences,
  hostState,
  saveState,
}) {
  return async function prepareTaskCreation({
    provider: targetProvider,
    project,
    workingDirectory,
    model,
    reasoning,
    mode,
    autoApprove: targetAutoApprove,
    streamId = null,
    title = "",
    taskId = null,
    taskNumber = null,
  } = {}) {
    const normalizedProvider = targetProvider === "claude" ? "claude" : "codex";
    const requestedDirectory = [workingDirectory, project, selectedProjectRoot()]
      .map((value) => String(value ?? "").trim())
      .find(Boolean) ?? "";
    const selectedProject = await configuredProjectForTaskWorkingDirectory({
      workingDirectory: requestedDirectory,
      findProject,
      taskGitWorkspaces,
      taskId,
      taskNumber,
    });
    if (!selectedProject) {
      throw new Error("Рабочая директория должна находиться внутри настроенного репозитория");
    }
    selectionStore.selectTask({
      activeProjectRoot: requestedDirectory || selectedProject.path,
      activeProvider: normalizedProvider,
      threadId: null,
      streamId,
      activeThreadTitle: String(title ?? "").trim(),
    });
    if (model) {
      if (normalizedProvider === "codex") agentPreferences.setCodexModel(model);
      else agentPreferences.setClaudeModel(model);
    }
    if (reasoning) {
      if (normalizedProvider === "codex") agentPreferences.setCodexReasoning(reasoning);
      else agentPreferences.setClaudeReasoning(reasoning);
    }
    if (mode) {
      if (normalizedProvider === "codex") agentPreferences.setCodexMode(mode);
      else agentPreferences.setClaudeMode(mode);
    }
    if (typeof targetAutoApprove === "boolean") hostState.setAutoApprove(targetAutoApprove);
    await saveState();
  };
}
