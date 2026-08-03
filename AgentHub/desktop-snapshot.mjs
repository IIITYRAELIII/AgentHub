import { createHash } from "node:crypto";

export function createDesktopSnapshotFactory({
  clock,
  context,
  runs,
  tasks,
  catalog,
  selection,
  settings,
  deferred,
  receipts = {},
  approvals,
  restart,
  exchangeRates,
  server = {},
  readState = null,
  warn,
}) {
  function desktopContextSnapshot(thread, turn = "") {
    const usage = context.latestUsage(thread, turn);
    const compaction = context.compactionFor(String(thread ?? "")) ?? null;
    if (!usage && !compaction) return null;
    const windowTokens = Math.max(0, Number(usage?.modelContextWindow) || 0);
    const usedTokens = Math.max(0, Number(usage?.usedTokens) || 0);
    const compactionStartedAtMs = Date.parse(String(compaction?.startedAt ?? "")) || 0;
    const usageUpdatedAtMs = Date.parse(String(usage?.updatedAt ?? "")) || 0;
    return {
      usedTokens,
      modelContextWindow: windowTokens,
      percent: windowTokens ? Math.min(100, (usedTokens / windowTokens) * 100) : 0,
      turnId: usage?.turnId ?? compaction?.turnId ?? null,
      updatedAt: usage?.updatedAt ?? null,
      compacting: context.isCompacting(String(thread ?? "")),
      compaction,
      usagePending: compaction?.status === "completed"
        && compactionStartedAtMs > 0
        && usageUpdatedAtMs < compactionStartedAtMs,
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
      attachments: Array.isArray(run.messageAttachments)
        ? run.messageAttachments.map((attachment) => ({ ...attachment }))
        : [],
      userMessages: (Array.isArray(run.userMessages) ? run.userMessages : []).flatMap((message) => {
        const text = String(message?.text ?? "").trim();
        if (!text) return [];
        const clientUserMessageId = String(message.clientUserMessageId ?? "");
        const receipt = clientUserMessageId
          ? receipts.forMessage?.({
            provider: run.provider,
            threadId: run.threadId,
            clientUserMessageId,
          })
          : null;
        return [{
          itemId: String(message.itemId ?? ""),
          clientUserMessageId,
          role: "user",
          text,
          time: message.time ?? receipt?.createdAt ?? run.startedAt ?? null,
          attachments: (
            receipt?.result?.attachments
            ?? (clientUserMessageId === String(run.clientUserMessageId ?? "")
              ? run.messageAttachments
              : [])
            ?? []
          ).map((attachment) => ({ ...attachment })),
        }];
      }),
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

  // `thread/compact/start` may wake a previously resumed Codex thread long
  // enough for the external-task watcher to manufacture an observer.  That
  // observer is not a user turn: it carries the same turn id as the manual
  // context compaction and otherwise becomes a misleading "stopped task"
  // card in the client.  A real turn cannot coexist with a manual compaction
  // (the control route rejects it), so keep this lifecycle visible only via
  // `context.compaction`, never as a run.
  function isManualCompactionObserver(run, context) {
    const compaction = context?.compaction;
    if (
      run?.observer !== true
      || compaction?.origin !== "manual"
      || !String(compaction?.turnId ?? "").trim()
    ) return false;
    return String(run.turnId ?? "").trim() === String(compaction.turnId).trim();
  }

  function desktopTaskSnapshot(entry, { accountId = "", compactSnapshot = false } = {}) {
    const task = {
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
    };
    const run = runs.forTask(task);
    const context = desktopContextSnapshot(entry.threadId, run?.turnId);
    const manualCompactionObserver = isManualCompactionObserver(run, context);
    const visibleRun = manualCompactionObserver ? null : run;
    const lastMessage = tasks.savedLastMessage(task);
    const unread = Boolean(
      accountId
      && lastMessage?.updatedAt
      && readState?.hasUnread?.({
        accountId,
        provider: entry.provider,
        threadId: entry.threadId,
        answerAt: lastMessage.updatedAt,
        answerTurnId: lastMessage.turnId,
      }),
    );
    return {
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      projectName: entry.projectName ?? tasks.projectNameFor(entry.projectRoot),
      threadId: entry.threadId,
      title: entry.title,
      model: visibleRun?.model ?? entry.model ?? null,
      selected: tasks.entryIsSelected(entry, selection.selectedTask()),
      running: manualCompactionObserver ? false : Boolean(visibleRun || entry.running),
      activityUnknown: entry.activityUnknown === true,
      executionOwner: visibleRun?.executionOwner ?? entry.executionOwner ?? null,
      runtime: visibleRun?.appServer ?? (entry.executionOwner
        ? tasks.executionRuntimeLabel(entry.executionOwner)
        : null),
      startedAt: visibleRun?.startedAt ?? entry.startedAt ?? null,
      updatedAtMs: Math.max(
        Number(entry.lastActivityAtMs) || 0,
        Number(entry.updatedAtMs) || 0,
        Date.parse(visibleRun?.lastMeaningfulProgressAt ?? visibleRun?.startedAt ?? "") || 0,
      ),
      orderingActivityAtMs: tasks.orderingActivityAtMs(entry, { run: visibleRun, lastMessage }),
      lastAnswer: compactSnapshot && lastMessage?.turnId ? "" : lastMessage?.text ?? "",
      lastAnswerAt: lastMessage?.updatedAt ?? null,
      lastAnswerTurnId: lastMessage?.turnId ?? null,
      unread,
      context,
      run: desktopRunSnapshot(visibleRun),
    };
  }

  async function desktopSnapshot({
    refresh = false,
    accountId = "",
    knownVersion = "",
    compactSnapshot = false,
  } = {}) {
    const catalogStale = clock.nowMs() - catalog.refreshedAt() >= 5_000;
    if (refresh || !catalog.entries().length || catalogStale) {
      // A Desktop RPC must remain responsive while Codex App Server is slow or
      // recovering. The catalog owns refresh de-duplication; return its last
      // known state now and let the following poll receive the refreshed list.
      void catalog.refresh({ force: true }).catch((error) => {
        warn("Cannot refresh desktop task catalog in background:", error.message);
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
    const taskSnapshots = entries.map((entry) => desktopTaskSnapshot(entry, { accountId, compactSnapshot }));
    const current = settings.current();
    const activeProvider = current.activeProvider;
    const activeCount = taskSnapshots.filter((item) => item.running).length;
    const serverSnapshot = typeof server.snapshot === "function"
      ? await server.snapshot({
        activeCount,
        restart: {
          pending: Boolean(restart.request()),
          waiting: restart.request()?.waitingForRuns === true,
          blockingCount: restart.request()
            ? restart.blockingRuns().length
              + (restart.compactionCount?.() ?? 0)
              + restart.mediaJobCount()
              + restart.speechJobCount()
            : 0,
        },
      })
      : null;
    const snapshot = {
      apiVersion: 2,
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
        includeClaudeUsage: current.includeClaudeUsage !== false,
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
          text: deferred.editableText?.(item.input) ?? deferred.inputPreview(item.input),
          annotations: deferred.responseAnnotations?.(item.input) ?? [],
          preview: deferred.inputPreview(item.input),
          allowForce: item.allowForce === true,
          conflictKind: item.conflictKind ?? null,
          createdAt: item.createdAt ?? null,
          attachments: item.persistentFiles
            ? (deferred.describeAttachments?.(item.temporaryFiles) ?? [])
            : [],
        })),
        ...deferred.queuedValues().map((item) => ({
          id: item.id,
          state: item.dispatchingAt ? "dispatching" : "queued",
          provider: item.provider,
          threadId: item.threadId,
          taskTitle: item.taskTitle,
          clientUserMessageId: item.clientUserMessageId ?? null,
          text: deferred.editableText?.(item.input) ?? deferred.inputPreview(item.input),
          annotations: deferred.responseAnnotations?.(item.input) ?? [],
          preview: deferred.inputPreview(item.input),
          allowForce: false,
          conflictKind: item.conflictKind ?? null,
          createdAt: item.createdAt ?? null,
          attachments: item.persistentFiles
            ? (deferred.describeAttachments?.(item.temporaryFiles) ?? [])
            : [],
        })),
      ].sort((left, right) => {
        const leftAt = Date.parse(String(left.createdAt ?? ""));
        const rightAt = Date.parse(String(right.createdAt ?? ""));
        return (Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY)
          - (Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY);
      }),
      restartPending: Boolean(restart.request()),
      restartWaiting: restart.request()?.waitingForRuns === true,
      restartBlockingCount: restart.request()
        ? restart.blockingRuns().length
          + (restart.compactionCount?.() ?? 0)
          + restart.mediaJobCount()
          + restart.speechJobCount()
        : 0,
      exchangeRates: exchangeRates?.snapshot?.() ?? null,
      activeCount,
      server: serverSnapshot,
      tasks: taskSnapshots,
    };
    const version = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("base64url")
      .slice(0, 22);
    if (knownVersion && knownVersion === version) return { notModified: true, version };
    return { ...snapshot, generatedAt: clock.nowIso(), version };
  }

  return {
    desktopContextSnapshot,
    desktopRunSnapshot,
    desktopTaskSnapshot,
    desktopSnapshot,
  };
}
