import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export class TaskIdentityResolver {
  constructor({
    selectionStore,
    projects,
    findContainingProject,
    catalogEntries,
    catalogEntryIsSelected,
    taskRuns,
    taskMetadata,
    preferences,
    currentChatId,
    contextualCallback,
    samePath,
    contextNonce = randomUUID(),
  }) {
    this.selectionStore = selectionStore;
    this.projects = projects;
    this.findContainingProject = findContainingProject;
    this.catalogEntries = catalogEntries;
    this.catalogEntryIsSelected = catalogEntryIsSelected;
    this.taskRuns = taskRuns;
    this.taskMetadata = taskMetadata;
    this.preferences = preferences;
    this.currentChatId = currentChatId;
    this.contextualCallback = contextualCallback;
    this.samePath = samePath;
    this.contextNonce = contextNonce;
  }

  findProject(projectRoot) {
    return this.findContainingProject(this.projects, projectRoot);
  }

  activeProject() {
    return this.findProject(this.selectionStore.activeProjectRoot) ?? this.projects[0];
  }

  selectedTask() {
    return {
      streamId: this.selectionStore.streamId,
      provider: this.selectionStore.activeProvider,
      projectRoot: this.selectionStore.activeProjectRoot,
      threadId: this.selectionStore.threadId,
    };
  }

  selectedTurnTarget(targetChatId = this.currentChatId()) {
    const selected = this.selectedTask();
    const catalogEntry = this.catalogEntries.find((entry) => (
      this.catalogEntryIsSelected(entry, selected)
    ));
    const preferences = this.preferences.current(selected.provider);
    return {
      ...selected,
      sessionCwd: catalogEntry?.sessionCwd ?? null,
      taskTitle: this.selectionStore.activeThreadTitle,
      chatId: targetChatId,
      modelId: preferences.model,
      reasoningId: preferences.reasoningEffort,
      collaborationMode: preferences.collaborationMode,
    };
  }

  currentUiContextToken() {
    return createHash("sha256")
      .update(`${this.contextNonce}\0${this.selectionStore.streamId ?? ""}\0${this.selectionStore.activeProvider}\0${path.resolve(this.selectionStore.activeProjectRoot)}\0${this.selectionStore.threadId ?? ""}`)
      .digest("hex")
      .slice(0, 12);
  }

  uiCallback(action) {
    return this.contextualCallback(action, this.currentUiContextToken());
  }

  selectedRun() {
    return this.taskRuns.forTask(this.selectedTask());
  }

  isSelectedRun(run) {
    const selected = this.selectedTask();
    return Boolean(run)
      && (!selected.streamId || !run.streamId || run.streamId === selected.streamId)
      && run.provider === selected.provider
      && this.samePath(run.projectRoot, selected.projectRoot)
      && String(run.threadId ?? "") === String(selected.threadId ?? "");
  }

  runProject(run) {
    return this.findProject(run?.projectRoot) ?? {
      name: path.basename(run?.projectRoot ?? "") || "Проект",
    };
  }

  runTaskTitle(run) {
    return String(run?.taskTitle ?? "").trim()
      || `${run?.provider === "claude" ? "Claude" : "Codex"} · ${String(run?.threadId ?? run?.id ?? "").slice(0, 8)}`;
  }

  pinnedTaskTitle(provider, threadId) {
    return this.taskMetadata.pinnedTitle({ provider, threadId });
  }

  pinTaskTitle(provider, threadId, title) {
    return this.taskMetadata.pinTitle({ provider, threadId }, title);
  }

  pendingTaskTitle(provider, threadId) {
    return this.taskMetadata.pendingTitle({ provider, threadId });
  }

  expectTaskTitleConfirmation(provider, threadId, title) {
    return this.taskMetadata.expectTitle({ provider, threadId }, title);
  }
}
