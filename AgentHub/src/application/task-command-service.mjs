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
    rotateStream,
    prepareTaskCreation,
    streamHandoff = null,
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
      rotateStream,
      prepareTaskCreation,
      streamHandoff,
    });
  }

  // A Thread created inside an existing Stream continues that Stream, but no
  // provider can resume another provider's native context. Request a Hub-built
  // handoff package so the new Thread does not start blind.
  #requestStreamHandoff({ stream, provider, previousThread, reason }) {
    if (!this.streamHandoff || !previousThread) return;
    try {
      this.streamHandoff.request({
        streamId: stream.id,
        targetProvider: provider,
        sourceProvider: previousThread.provider,
        sourceThreadId: previousThread.threadId,
        reason,
      });
    } catch (error) {
      console.warn(`Cannot prepare Stream handoff for ${stream.id}: ${error.message}`);
    }
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
    const [nextThread = null] = (await this.listCodexTasks())
      .filter((item) => item.id !== target.threadId);
    if (this.catalogEntryIsSelected(target, this.selection.current())) {
      this.selection.clearCodex();
      this.diffs.setLatest("");
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

  async create(params = {}, context = {}) {
    const normalizedSourceStreamId = String(params.sourceStreamId ?? "").trim();
    let workspace = null;
    let stream = null;
    let sourceStream = null;
    let createdWorkspace = false;
    if (params.streamId) {
      stream = this.workspaceCatalog.stream(params.streamId);
      if (!stream) throw new Error("Stream не найден");
      workspace = this.workspaceCatalog.workspace(stream.workspaceId);
    } else if (normalizedSourceStreamId) {
      sourceStream = this.workspaceCatalog.stream(normalizedSourceStreamId);
      if (!sourceStream) throw new Error("Исходный Stream не найден");
      workspace = this.workspaceCatalog.workspace(sourceStream.workspaceId);
      if (!workspace) throw new Error("Workspace исходного Stream не найден");
    } else if (params.workspaceId) {
      workspace = this.workspaceCatalog.workspace(params.workspaceId);
      if (!workspace) throw new Error("Workspace не найден");
    }
    if (stream && params.settings && typeof this.workspaceCatalog.updateStreamSettings === "function") {
      stream = this.workspaceCatalog.updateStreamSettings(stream.id, params.settings);
    }
    const streamSettings = {
      ...(stream?.settings ?? sourceStream?.settings ?? {}),
      ...(params.settings && typeof params.settings === "object" ? params.settings : {}),
    };
    const provider = String(params.provider ?? streamSettings.provider ?? this.activeProvider()).trim();
    if (!["codex", "claude"].includes(provider)) throw new Error("Неизвестный агент");
    if (provider !== this.activeProvider()) await this.switchProvider(provider);
    if (!stream && workspace) {
      stream = this.workspaceCatalog.createStream({
        workspaceId: workspace.id,
        name: params.streamName,
        settings: streamSettings,
      });
    } else if (!workspace) {
      workspace = this.workspaceCatalog.createWorkspace({
        name: String(params.workspaceName ?? "New Workspace").trim(),
      });
      createdWorkspace = true;
      stream = this.workspaceCatalog.createStream({
        workspaceId: workspace.id,
        name: params.streamName,
      });
    }
    const workingDirectory = [
      params.workingDirectory,
      streamSettings.workingDirectory,
      workspace?.settings?.workingDirectory,
      streamSettings.project,
    ].map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
    const previousThread = params.streamId && typeof this.workspaceCatalog.activeThread === "function"
      ? this.workspaceCatalog.activeThread(stream.id)
      : null;
    if (typeof this.prepareTaskCreation === "function") {
      await this.prepareTaskCreation({
        ...streamSettings,
        workingDirectory,
        provider,
        streamId: stream.id,
        title: workspace?.name ?? "",
      });
    } else {
      this.selectionStore.setThread(null, {
        provider,
        streamId: stream.id,
        title: workspace.name,
      });
      await this.saveState();
    }
    let created;
    try {
      created = await this.createTask();
    } catch (error) {
      const recoveredThreadId = String(this.selectionStore.threadId ?? "").trim();
      const recoveredStreamId = String(this.selectionStore.streamId ?? "").trim();
      const recoveredProvider = String(this.selectionStore.activeProvider ?? "").trim();
      if (!recoveredThreadId || recoveredStreamId !== stream.id || recoveredProvider !== provider) throw error;
      created = {
        provider,
        threadId: recoveredThreadId,
        projectRoot: this.selectionStore.activeProjectRoot,
        title: this.selectionStore.activeThreadTitle || workspace.name,
      };
    }
    if (createdWorkspace && !params.workspaceName && created?.title
      && typeof this.workspaceCatalog.renameWorkspace === "function") {
      workspace = this.workspaceCatalog.renameWorkspace(workspace.id, created.title);
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
    if (params.streamId && previousThread?.threadId !== created?.threadId) {
      this.#requestStreamHandoff({
        stream,
        provider,
        previousThread,
        reason: params.handoffReason,
      });
    }
    this.selectionStore.setThread(created?.threadId ?? null, {
      provider,
      streamId: stream.id,
      title: workspace.name,
    });
    this.invalidateCatalog();
    await this.saveState();
    return {
      ...await this.snapshot({ refresh: true }),
      createdTask: {
        ...created,
        streamId: stream.id,
        taskTitle: created?.title ?? workspace.name,
      },
      clientId: String(context?.clientId ?? "").trim() || null,
    };
  }

  async rotate(params = {}) {
    const target = await this.resolveTarget(params);
    if (target.provider !== "codex") throw new Error("Ротация пока доступна только для Codex");
    if (this.runForTask(target)) throw new Error("Сначала завершите или остановите текущий ход");
    const binding = this.workspaceCatalog.thread({
      provider: target.provider,
      threadId: target.threadId,
    });
    const streamId = String(params.streamId ?? binding?.streamId ?? "").trim();
    const stream = streamId ? this.workspaceCatalog.stream(streamId) : null;
    if (!binding || !stream || binding.streamId !== stream.id) throw new Error("Stream не найден");
    const workspace = this.workspaceCatalog.workspace(stream.workspaceId);
    if (!workspace) throw new Error("Workspace не найден");

    const workingDirectory = [
      params.workingDirectory,
      stream.settings?.workingDirectory,
      workspace.settings?.workingDirectory,
    ].map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
    const rotated = await this.rotateStream({
      ...target,
      streamId: stream.id,
      ...(workingDirectory ? { workingDirectory } : {}),
    });
    const threadId = String(rotated?.thread?.id ?? "").trim();
    if (!threadId) throw new Error("Codex App Server не создал новый Thread");
    return {
      ...await this.snapshot({ refresh: true }),
      rotation: {
        sourceThreadId: target.threadId,
        threadId,
        streamId: stream.id,
      },
    };
  }
}
