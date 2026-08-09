import { createHash } from "node:crypto";
import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";
import { taskRunIsActive } from "../../domain/task-runs.mjs";

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
  maintenance = {},
  board = {},
  server = {},
  readState = null,
  warn,
}) {
  function desktopMessageReceiptSnapshot() {
    return (receipts.recent?.() ?? []).slice(-100).flatMap((receipt) => {
      const provider = String(receipt?.provider ?? "").trim();
      const threadId = String(receipt?.threadId ?? "").trim();
      const clientUserMessageId = String(receipt?.clientUserMessageId ?? "").trim();
      const result = receipt?.result;
      if (!provider || !threadId || !clientUserMessageId || !result) return [];
      return [{
        provider,
        threadId,
        clientUserMessageId,
        createdAt: receipt.createdAt ?? null,
        accepted: result.accepted === true,
        deferred: result.deferred === true,
        queued: result.queued === true,
        dispatching: result.dispatching === true,
        steered: result.steered === true,
        cancelled: result.cancelled === true,
        id: result.id ?? null,
        runId: result.runId ?? null,
        turnId: result.turnId ?? null,
        message: result.message ?? null,
        attachments: Array.isArray(result.attachments)
          ? result.attachments.map((attachment) => ({ ...attachment }))
          : [],
      }];
    });
  }

  function deferredTaskTitle(item) {
    const entry = catalog.entries().find((candidate) => (
      (item.streamId && candidate.streamId === item.streamId)
      || (candidate.provider === item.provider && candidate.threadId === item.threadId)
    ));
    return taskDisplayTitle(entry, item.taskTitle);
  }

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
      percent: windowTokens ? Math.min(100, (usedTokens / windowTokens) * 100) : null,
      turnId: usage?.turnId ?? compaction?.turnId ?? null,
      updatedAt: usage?.updatedAt ?? null,
      compacting: context.isCompacting(String(thread ?? "")),
      compaction,
      usagePending: !usage || usage?.provisional === true || (
        compaction?.status === "completed"
        && compactionStartedAtMs > 0
        && usageUpdatedAtMs < compactionStartedAtMs
      ),
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
      activities: Array.isArray(run.activities) ? run.activities : [],
      context: desktopContextSnapshot(run.threadId, run.turnId),
    };
  }

  // `thread/compact/start` may wake a previously resumed Codex thread long
  // enough for the external-task watcher to manufacture an observer. That
  // observer is not a user turn when it belongs to a manual compaction or a
  // standalone automatic compaction with no prompt or answer. A real turn can
  // contain an automatic compaction, so keep it visible when user content is
  // present and hide only the maintenance-only observer.
  function isCompactionOnlyObserver(run, context) {
    const compaction = context?.compaction;
    if (
      run?.observer !== true
      || !String(compaction?.turnId ?? "").trim()
    ) return false;
    if (String(run.turnId ?? "").trim() !== String(compaction.turnId).trim()) return false;
    if (compaction.origin === "manual") return true;
    return !String(run.promptPreview ?? "").trim()
      && !(Array.isArray(run.userMessages) && run.userMessages.some((message) => (
        String(message?.text ?? "").trim()
      )))
      && !String(run.responseText ?? "").trim();
  }

  function isInternalMaintenanceObserver(run, context) {
    if (!run) return false;
    return isCompactionOnlyObserver(run, context)
      || (run.provider === "codex" && isCodexContextProbeTurn({
        prompt: run.promptPreview,
        finalAnswer: run.responseText,
        clientUserMessageId: run.clientUserMessageId,
        userMessages: run.userMessages,
      }));
  }

  function desktopTaskSnapshot(entry, { accountId = "", compactSnapshot = false } = {}) {
    const displayTitle = taskDisplayTitle(entry);
    const task = {
      streamId: entry.streamId ?? null,
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
    };
    const run = runs.forTask(task);
    const context = desktopContextSnapshot(entry.threadId, run?.turnId);
    const internalMaintenanceObserver = isInternalMaintenanceObserver(run, context);
    const visibleRun = internalMaintenanceObserver ? null : run;
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
      workspaceId: entry.workspaceId ?? null,
      workspaceName: entry.workspaceName ?? null,
      workspaceKind: entry.workspaceKind ?? null,
      streamId: entry.streamId ?? null,
      streamName: entry.streamName ?? null,
      streamDisplayName: entry.streamDisplayName ?? "",
      streamOrdinal: Number(entry.streamOrdinal) || 1,
      threadPosition: Number(entry.threadPosition) || 1,
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      projectName: entry.projectName ?? tasks.projectNameFor(entry.projectRoot),
      threadId: entry.threadId,
      title: displayTitle,
      displayTitle,
      threadTitle: entry.title,
      model: visibleRun?.model ?? entry.model ?? null,
      selected: tasks.entryIsSelected(entry, selection.selectedTask()),
      running: internalMaintenanceObserver
        ? false
        : Boolean(taskRunIsActive(visibleRun) || entry.running),
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
      maintenance: maintenance.entryFor?.(task) ?? null,
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
    const selectedTaskSnapshot = taskSnapshots.find((task) => task.selected) ?? null;
    const selectedIdentity = selection.selectedTask();
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
              + restart.mediaJobCount()
              + restart.speechJobCount()
            : 0,
        },
      })
      : null;
    const snapshot = {
      apiVersion: 3,
      workspaces: board.workspaces?.() ?? catalog.hierarchy?.() ?? [],
      boardTasks: board.snapshot?.() ?? [],
      selected: {
        ...selectedIdentity,
        workspaceId: selectedTaskSnapshot?.workspaceId ?? selectedIdentity.workspaceId ?? null,
        workspaceName: selectedTaskSnapshot?.workspaceName ?? null,
        streamId: selectedTaskSnapshot?.streamId ?? selectedIdentity.streamId ?? null,
        streamName: selectedTaskSnapshot?.streamName ?? null,
        streamDisplayName: selectedTaskSnapshot?.streamDisplayName ?? "",
        streamOrdinal: selectedTaskSnapshot?.streamOrdinal ?? 1,
        title: selectedTaskSnapshot?.displayTitle
          ?? taskDisplayTitle(selectedTaskSnapshot, selection.activeThreadTitle()),
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
      messageReceipts: desktopMessageReceiptSnapshot(),
      deferredInputs: [
        ...deferred.pendingValues().map((item) => ({
          id: item.id,
          state: item.manualAction === "steer" ? "steering" : "pending",
          provider: item.provider,
          threadId: item.threadId,
          taskTitle: deferredTaskTitle(item),
          clientUserMessageId: item.clientUserMessageId ?? null,
          text: deferred.editableText?.(item.input) ?? deferred.inputPreview(item.input),
          annotations: deferred.responseAnnotations?.(item.input) ?? [],
          preview: deferred.inputPreview(item.input),
          allowForce: item.allowForce === true,
          conflictKind: item.conflictKind ?? null,
          lastError: item.lastError ?? null,
          attempts: Number(item.attempts) || 0,
          createdAt: item.createdAt ?? null,
          attachments: item.persistentFiles
            ? (deferred.describeAttachments?.(item.temporaryFiles) ?? [])
            : [],
        })),
        ...deferred.queuedValues().map((item) => ({
          id: item.id,
          state: item.dispatchingAt ? "dispatching" : item.paused === true ? "paused" : "queued",
          provider: item.provider,
          threadId: item.threadId,
          taskTitle: deferredTaskTitle(item),
          clientUserMessageId: item.clientUserMessageId ?? null,
          text: deferred.editableText?.(item.input) ?? deferred.inputPreview(item.input),
          annotations: deferred.responseAnnotations?.(item.input) ?? [],
          preview: deferred.inputPreview(item.input),
          allowForce: false,
          conflictKind: item.conflictKind ?? null,
          lastError: item.lastError ?? null,
          attempts: Number(item.attempts) || 0,
          queueOrder: Number.isFinite(Number(item.queueOrder)) ? Number(item.queueOrder) : null,
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
