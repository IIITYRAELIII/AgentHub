export class TaskCommandService {
  constructor({
    resolveTarget,
    pinTitle,
    renameCodexTask,
    expectTitleConfirmation,
    invalidateCatalog,
    runForTask,
    updateRunTitle,
    catalogEntries,
    catalogEntryIsSelected,
    selection,
    saveTitles,
    saveState,
    snapshot,
    readCodexTask,
    archiveCodexTask,
    deleteCodexSettings,
    listCodexTasks,
    codexTaskTitle,
    restoreCodexSettings,
    diffs,
    providerCancel,
    progress,
    dismissedExternalTasks,
    completeRun,
    createTask,
    activeProvider,
    switchProvider,
    workspaceCatalog,
    selectionStore,
  }) {
    Object.assign(this, {
      resolveTarget,
      pinTitle,
      renameCodexTask,
      expectTitleConfirmation,
      invalidateCatalog,
      runForTask,
      updateRunTitle,
      catalogEntries,
      catalogEntryIsSelected,
      selection,
      saveTitles,
      saveState,
      snapshot,
      readCodexTask,
      archiveCodexTask,
      deleteCodexSettings,
      listCodexTasks,
      codexTaskTitle,
      restoreCodexSettings,
      diffs,
      providerCancel,
      progress,
      dismissedExternalTasks,
      completeRun,
      createTask,
      activeProvider,
      switchProvider,
      workspaceCatalog,
      selectionStore,
    });
  }

  async rename(params) {
    const target = await this.resolveTarget(params);
    const title = this.pinTitle(target.provider, target.threadId, String(params.title ?? ""));
    if (!title) throw new Error("Укажите непустое название");
    if (target.provider === "codex") {
      await this.renameCodexTask(target.threadId, title);
      this.expectTitleConfirmation(target.provider, target.threadId, title);
      this.invalidateCatalog();
    }
    const run = this.runForTask(target);
    if (run) this.updateRunTitle(run, title);
    const entry = this.catalogEntries().find((item) => this.catalogEntryIsSelected(item, target));
    if (entry) entry.title = title;
    if (this.catalogEntryIsSelected(target, this.selection.current())) this.selection.setTitle(title);
    await this.saveTitles();
    await this.saveState();
    return { ...await this.snapshot({ refresh: true }), renamedTitle: title };
  }

  async archive(params) {
    const target = await this.resolveTarget(params);
    if (target.provider !== "codex") throw new Error("Claude не поддерживает архивирование");
    if (this.runForTask(target)) throw new Error("Сначала остановите активный ход");
    const archivedThread = await this.readCodexTask(target.threadId);
    await this.archiveCodexTask(target.threadId);
    this.invalidateCatalog();
    this.deleteCodexSettings(target.threadId);
    let nextThread = null;
    if (this.catalogEntryIsSelected(target, this.selection.current())) {
      this.selection.clearCodex();
      this.diffs.setLatest("");
      [nextThread] = (await this.listCodexTasks()).filter((item) => item.id !== target.threadId);
      if (nextThread) {
        this.selection.selectCodex(nextThread.id, this.codexTaskTitle(nextThread));
        this.restoreCodexSettings(nextThread.id);
        this.diffs.setLatest(this.diffs.forTask(this.selection.current()));
      }
    }
    await this.saveState();
    return {
      ...await this.snapshot({ refresh: true }),
      archivedThread: archivedThread ?? { id: target.threadId },
      nextThread,
    };
  }

  async diff(params) {
    const target = await this.resolveTarget(params);
    const run = this.runForTask(target);
    const text = run ? await this.diffs.refresh(run) : this.diffs.forTask(target);
    return { text, empty: !text };
  }

  async cancel(params) {
    const target = await this.resolveTarget(params);
    const run = this.runForTask(target);
    if (!run) return { accepted: false, message: "В выбранной задаче сейчас ничего не выполняется" };
    const result = await this.providerCancel(run);
    if (result.interruptFailed) {
      if (run.observer) {
        this.progress.setStage(run, result.message);
        return { ...result, message: `${result.message}. Параллельный ход не будет запущен.` };
      }
      return result;
    }
    if (run.observer) {
      this.dismissedExternalTasks.add(run);
      await this.progress.finish(run, result.stopRequested
        ? "Остановка запрошена; наблюдение отключено."
        : "Наблюдение отключено; внешний ход продолжает работу.");
      await this.completeRun(run);
      return {
        accepted: true,
        message: result.stopRequested
          ? "Запрошена остановка этой задачи. Пока внешний ход фактически активен, новые сообщения будут сохранены, а не запущены параллельно."
          : "Отключил наблюдение. Внешний Claude продолжает работу; новые сообщения будут сохранены до его завершения.",
      };
    }
    if (!result.detach) return result;
    await this.progress.finish(run, "Наблюдение отключено; внешний Claude продолжает работу.");
    await this.completeRun(run);
    return result;
  }

  async create(params = {}) {
    const provider = String(params.provider ?? this.activeProvider()).trim();
    if (!["codex", "claude"].includes(provider)) throw new Error("Неизвестный агент");
    let workspace = null;
    let stream = null;
    if (params.streamId) {
      stream = this.workspaceCatalog.stream(params.streamId);
      if (!stream) throw new Error("Stream не найден");
      workspace = this.workspaceCatalog.workspace(stream.workspaceId);
    } else if (params.workspaceId) {
      workspace = this.workspaceCatalog.workspace(params.workspaceId);
      if (!workspace) throw new Error("Workspace не найден");
    }
    if (provider !== this.activeProvider()) await this.switchProvider(provider);
    const created = await this.createTask();
    if (!stream && workspace) {
      stream = this.workspaceCatalog.createStream({
        workspaceId: workspace.id,
        name: params.streamName,
      });
    } else if (!workspace) {
      workspace = this.workspaceCatalog.createWorkspace({
        name: String(params.workspaceName ?? created?.title ?? "New Workspace").trim(),
      });
      stream = this.workspaceCatalog.createStream({
        workspaceId: workspace.id,
        name: params.streamName,
      });
    }
    if (created?.threadId) {
      this.workspaceCatalog.bindThread({
        provider: created.provider,
        threadId: created.threadId,
        streamId: stream.id,
        projectRoot: created.projectRoot,
        source: params.streamId ? "rebirth" : "created",
      });
    }
    this.selectionStore.setThread(created?.threadId ?? null, {
      provider,
      streamId: stream.id,
      title: workspace.name,
    });
    this.invalidateCatalog();
    await this.saveState();
    return this.snapshot({ refresh: true });
  }
}
