export class TaskNavigationService {
  constructor({
    projects,
    samePath,
    findProject,
    selectionStore,
    activeProjectRoot,
    activeProvider,
    threadId,
    activeTaskTitle,
    isCodex,
    rememberCodexSettings,
    captureCodexPreferences,
    restoreCodexPreferences,
    restoreCodexThreadSettings,
    storedCodexThreadTitle,
    selectedTask,
    taskRunKey,
    storedTaskDiff,
    latestDiff,
    setLatestDiff,
    createThread,
    codexTransportRunning,
    startCodex,
    initializeCodex,
    attachCodexThread,
    saveState,
    applyStreamAgentSettings,
    rememberStreamAgentSettings,
  }) {
    Object.assign(this, {
      projects,
      samePath,
      findProject,
      selectionStore,
      activeProjectRoot,
      activeProvider,
      threadId,
      activeTaskTitle,
      isCodex,
      rememberCodexSettings,
      captureCodexPreferences,
      restoreCodexPreferences,
      restoreCodexThreadSettings,
      storedCodexThreadTitle,
      selectedTask,
      taskRunKey,
      storedTaskDiff,
      latestDiff,
      setLatestDiff,
      createThread,
      codexTransportRunning,
      startCodex,
      initializeCodex,
      attachCodexThread,
      saveState,
      applyStreamAgentSettings,
      rememberStreamAgentSettings,
    });
  }

  async switchProject(index) {
    const project = this.projects[index];
    if (!project) throw new Error("unknown project");
    if (this.samePath(project.path, this.activeProjectRoot())) return { project, changed: false };

    this.rememberCodexSettings();
    const previousSelection = this.selectionStore.snapshot();
    const previousLatestDiff = this.latestDiff();
    this.selectionStore.switchProject(project.path);
    this.setLatestDiff("");
    try {
      await this.createThread();
    } catch (error) {
      this.selectionStore.restore(previousSelection);
      this.setLatestDiff(previousLatestDiff);
      await this.saveState();
      throw error;
    }
    return { project, changed: true };
  }

  async switchProvider(target) {
    if (target !== "codex" && target !== "claude") throw new Error("unknown provider");
    if (target === this.activeProvider()) return { changed: false };

    this.rememberCodexSettings();
    const previousSelection = this.selectionStore.snapshot();
    const previousPreferences = this.captureCodexPreferences();
    this.selectionStore.switchProvider(target);
    if (target === "codex" && this.threadId()) {
      this.restoreCodexThreadSettings(this.threadId());
    }
    this.setLatestDiff("");
    try {
      if (this.isCodex()) {
        if (!this.codexTransportRunning()) {
          await this.startCodex();
          await this.initializeCodex();
        } else {
          await this.attachCodexThread();
        }
      } else if (!this.threadId()) {
        await this.createThread();
      }
    } catch (error) {
      this.selectionStore.restore(previousSelection);
      this.restoreCodexPreferences(previousPreferences);
      await this.saveState();
      throw error;
    }
    this.setLatestDiff(this.storedTaskDiff(this.taskRunKey(this.selectedTask())) ?? "");
    await this.saveState();
    return { changed: true };
  }

  async activate(binding) {
    const project = this.findProject(binding.projectRoot);
    if (!project) throw new Error("проект привязанного сообщения больше не разрешён");
    if (binding.provider !== "codex" && binding.provider !== "claude") {
      throw new Error("неизвестный агент привязанного сообщения");
    }
    const alreadyActive = this.samePath(project.path, this.activeProjectRoot())
      && binding.provider === this.activeProvider()
      && binding.threadId === this.threadId();
    if (alreadyActive) return { changed: false };

    this.rememberCodexSettings();
    const previousSelection = this.selectionStore.snapshot();
    const previous = {
      latestDiff: this.latestDiff(),
      preferences: this.captureCodexPreferences(),
    };
    this.selectionStore.selectTask({
      streamId: binding.streamId ?? null,
      activeProjectRoot: project.path,
      activeProvider: binding.provider,
      threadId: binding.threadId,
      activeThreadTitle: binding.taskTitle?.trim()
        || `${binding.provider === "codex" ? "Codex" : "Claude"} · ${binding.threadId.slice(0, 8)}`,
    });
    const streamSettings = this.applyStreamAgentSettings?.(binding.streamId ?? null);
    if (this.isCodex()) {
      this.restoreCodexThreadSettings(this.threadId(), { inheritCurrent: Boolean(streamSettings) });
      if (!binding.taskTitle?.trim()) {
        this.selectionStore.setTitle(await this.storedCodexThreadTitle(
          this.threadId(),
          this.activeTaskTitle(),
        ));
      }
    }
    if (streamSettings && !streamSettings.explicit) {
      this.rememberStreamAgentSettings?.(binding.streamId ?? null);
    }
    this.setLatestDiff(this.storedTaskDiff(this.taskRunKey(this.selectedTask())) ?? "");
    try {
      // A UI selection is local state. Provider startup belongs to the first
      // command that actually needs the provider, never to a harmless click.
      await this.saveState();
      return { changed: true, activeTitle: this.activeTaskTitle() };
    } catch (error) {
      this.selectionStore.restore(previousSelection);
      this.setLatestDiff(previous.latestDiff);
      this.restoreCodexPreferences(previous.preferences);
      await this.saveState();
      throw error;
    }
  }
}
