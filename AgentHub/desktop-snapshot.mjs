export function createDesktopSnapshotFactory({
  clock,
  context,
  runs,
  tasks,
  catalog,
  selection,
  settings,
  deferred,
  approvals,
  restart,
  warn,
}) {
  function desktopContextSnapshot(thread, turn = "") {
    const usage = context.latestUsage(thread, turn);
    if (!usage) return null;
    const windowTokens = Math.max(0, Number(usage.modelContextWindow) || 0);
    const usedTokens = Math.max(0, Number(usage.usedTokens) || 0);
    return {
      usedTokens,
      modelContextWindow: windowTokens,
      percent: windowTokens ? Math.min(100, (usedTokens / windowTokens) * 100) : 0,
      turnId: usage.turnId,
      updatedAt: usage.updatedAt,
      compacting: context.isCompacting(String(thread ?? "")),
      compaction: context.compactionFor(String(thread ?? "")) ?? null,
    };
  }

  function desktopRunSnapshot(run) {
    if (!run) return null;
    return {
      id: run.id,
      turnId: run.turnId ?? null,
      provider: run.provider,
      threadId: run.threadId,
      taskTitle: runs.titleFor(run),
      status: run.status,
      observer: run.observer === true,
      executionOwner: run.executionOwner ?? null,
      runtime: run.appServer ?? null,
      model: run.model ?? null,
      reasoning: run.reasoning ?? null,
      stage: String(run.progressStage ?? "Выполняется…"),
      prompt: String(run.promptPreview ?? ""),
      progress: String(run.progressReasoning ?? ""),
      response: String(run.responseText ?? ""),
      clientUserMessageId: run.clientUserMessageId ?? null,
      responseItemId: run.responseItemId ?? null,
      startedAt: run.startedAt ?? null,
      lastActivityAt: run.lastMeaningfulProgressAt ?? run.progressHeartbeatAt ?? run.startedAt ?? null,
      activities: Array.isArray(run.activities) ? run.activities.slice(-100) : [],
      context: desktopContextSnapshot(run.threadId, run.turnId),
    };
  }

  function desktopTaskSnapshot(entry) {
    const task = {
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
    };
    const run = runs.forTask(task);
    const lastMessage = tasks.savedLastMessage(task);
    return {
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      projectName: entry.projectName ?? tasks.projectNameFor(entry.projectRoot),
      threadId: entry.threadId,
      title: entry.title,
      selected: tasks.entryIsSelected(entry, selection.selectedTask()),
      running: Boolean(run || entry.running),
      activityUnknown: entry.activityUnknown === true,
      executionOwner: run?.executionOwner ?? entry.executionOwner ?? null,
      runtime: run?.appServer ?? (entry.executionOwner
        ? tasks.executionRuntimeLabel(entry.executionOwner)
        : null),
      updatedAtMs: Math.max(
        Number(entry.lastActivityAtMs) || 0,
        Number(entry.updatedAtMs) || 0,
        Date.parse(run?.lastMeaningfulProgressAt ?? run?.startedAt ?? "") || 0,
      ),
      orderingActivityAtMs: tasks.orderingActivityAtMs(entry, { run, lastMessage }),
      lastAnswer: lastMessage?.text ?? "",
      lastAnswerAt: lastMessage?.updatedAt ?? null,
      context: desktopContextSnapshot(entry.threadId, run?.turnId),
      run: desktopRunSnapshot(run),
    };
  }

  async function desktopSnapshot({ refresh = false } = {}) {
    const catalogStale = clock.nowMs() - catalog.refreshedAt() >= 5_000;
    if (refresh || !catalog.entries().length || catalogStale) {
      await catalog.refresh({ force: Boolean(refresh || catalogStale) }).catch((error) => {
        warn("Cannot refresh desktop task catalog:", error.message);
      });
    }
    let entries = catalog.entries();
    if (
      !entries.some((entry) => tasks.entryIsSelected(entry, selection.selectedTask()))
      && selection.hasThread()
    ) {
      entries = catalog.merge(entries, [{
        ...selection.selectedTurnTarget(),
        projectName: selection.activeProject().name,
        startedAt: clock.nowIso(),
      }]);
    }
    const taskSnapshots = entries.map(desktopTaskSnapshot);
    const current = settings.current();
    const activeProvider = current.activeProvider;
    return {
      apiVersion: 2,
      generatedAt: clock.nowIso(),
      selected: {
        ...selection.selectedTask(),
        title: selection.activeThreadTitle(),
        projectName: selection.activeProject().name,
        model: activeProvider === "codex"
          ? current.codexModelLabel(current.codexModel)
          : current.claudeModelLabels[current.claudeModel],
        reasoning: current.reasoningLabels[
          activeProvider === "codex"
            ? current.codexReasoningEffort
            : current.claudeReasoningEffort
        ],
        mode: current.collaborationModeLabels[
          activeProvider === "codex"
            ? current.codexCollaborationMode
            : current.claudeCollaborationMode
        ],
      },
      settings: {
        provider: activeProvider,
        model: activeProvider === "codex" ? current.codexModel : current.claudeModel,
        reasoning: activeProvider === "codex"
          ? current.codexReasoningEffort
          : current.claudeReasoningEffort,
        mode: activeProvider === "codex"
          ? current.codexCollaborationMode
          : current.claudeCollaborationMode,
        approvalMode: current.autoApprove ? "auto" : "manual",
        models: activeProvider === "codex"
          ? current.codexModels.map((model) => ({ value: model.value, label: model.label }))
          : current.claudeModels.map((value) => ({
            value,
            label: current.claudeModelLabels[value],
          })),
        reasoningOptions: current.reasoningEfforts.map((value) => ({
          value,
          label: current.reasoningLabels[value],
        })),
        modeOptions: current.collaborationModes.map((value) => ({
          value,
          label: current.collaborationModeLabels[value],
        })),
        projects: current.projects.map((project) => ({
          name: project.name,
          path: project.path,
          selected: tasks.samePath(project.path, current.activeProjectRoot),
        })),
      },
      pendingApprovals: approvals.snapshot(),
      deferredInputs: [
        ...deferred.pendingValues().map((item) => ({
          id: item.id,
          state: "pending",
          provider: item.provider,
          threadId: item.threadId,
          taskTitle: item.taskTitle,
          clientUserMessageId: item.clientUserMessageId ?? null,
          preview: deferred.inputPreview(item.input).slice(0, 1_000),
          allowForce: item.allowForce === true,
          conflictKind: item.conflictKind ?? null,
        })),
        ...deferred.queuedValues().map((item) => ({
          id: item.id,
          state: "queued",
          provider: item.provider,
          threadId: item.threadId,
          taskTitle: item.taskTitle,
          clientUserMessageId: item.clientUserMessageId ?? null,
          preview: deferred.inputPreview(item.input).slice(0, 1_000),
          allowForce: false,
          conflictKind: item.conflictKind ?? null,
        })),
      ],
      restartPending: Boolean(restart.request()),
      restartWaiting: restart.request()?.waitingForRuns === true,
      restartBlockingCount: restart.request()
        ? restart.blockingRuns().length + restart.mediaJobCount() + restart.speechJobCount()
        : 0,
      activeCount: taskSnapshots.filter((item) => item.running).length,
      tasks: taskSnapshots,
    };
  }

  return {
    desktopContextSnapshot,
    desktopRunSnapshot,
    desktopTaskSnapshot,
    desktopSnapshot,
  };
}
