import { createHash } from "node:crypto";
import { displayUserPrompt } from "../../application/task-history.mjs";
import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";
import {
  interstreamMessageDetails,
  interstreamOriginAuthor,
  normalizeInterstreamOrigin,
} from "../../domain/interstream-message.mjs";
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";
import { taskRunIsActive } from "../../domain/task-runs.mjs";
import { claudeModelOptions } from "../../domain/agent-runtime-settings.mjs";
import { presentContextUsageBreakdown } from "../../domain/context-usage-breakdown.mjs";
import { deferredLaunchWaitReason } from "../../application/deferred-input-controller.mjs";

const MAX_COMPACT_ACTIVITY_DETAIL_CHARS = 1_200;

function deferredWaitProjection(item) {
  const waitReason = item.waitReason ?? deferredLaunchWaitReason(item.lastError);
  return {
    ...(waitReason ? { waitReason } : {}),
    lastError: waitReason ? null : item.lastError ?? null,
  };
}

export function workspaceBindingForTask(task, workspaces) {
  const streamId = String(task?.streamId ?? "").trim();
  if (!streamId) return {};
  for (const workspace of workspaces ?? []) {
    const stream = (workspace?.streams ?? []).find((candidate) => (
      String(candidate?.id ?? "") === streamId
    ));
    if (!stream) continue;
    const thread = (stream.threads ?? []).find((candidate) => (
      String(candidate?.provider ?? "") === String(task?.provider ?? "")
      && String(candidate?.threadId ?? candidate?.id ?? "") === String(task?.threadId ?? "")
    ));
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceKind: workspace.kind,
      streamId: stream.id,
      streamName: stream.name ?? null,
      streamDisplayName: stream.displayName ?? "",
      streamOrdinal: Number(stream.ordinal) || 1,
      threadPosition: Number(thread?.position) || 1,
    };
  }
  return {};
}

function deferredMessageProjection(item, deferred) {
  const rawText = deferred.editableText?.(item.input) ?? deferred.inputPreview(item.input);
  const rawPreview = deferred.inputPreview(item.input);
  const interstream = interstreamMessageDetails(rawText) ?? interstreamMessageDetails(rawPreview);
  const origin = normalizeInterstreamOrigin(item.messageOrigin) ?? interstream?.origin;
  return {
    text: displayUserPrompt(rawText),
    preview: displayUserPrompt(rawPreview),
    ...(origin ? { author: interstreamOriginAuthor(origin), origin } : {}),
  };
}

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
  revision = null,
  warn,
}) {
  const versionCache = new Map();
  let catalogRefresh = null;

  function scheduleCatalogRefresh(force) {
    if (catalogRefresh) return;
    catalogRefresh = Promise.resolve()
      .then(() => catalog.refresh({ force }))
      .catch((error) => {
        warn("Cannot refresh desktop task catalog in background:", error.message);
      })
      .finally(() => {
        catalogRefresh = null;
      });
  }

  function versionCacheKey({ accountId, compactSnapshot }) {
    return `${String(accountId ?? "")}\u0000${compactSnapshot === true ? "compact" : "full"}`;
  }

  async function sourceRevision(params) {
    if (typeof revision !== "function") return null;
    try {
      const value = await revision(params);
      if (value == null) return null;
      return String(value);
    } catch (error) {
      warn?.("Cannot read desktop snapshot revision:", error.message);
      return null;
    }
  }

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
        deliveredAt: result.deliveredAt ?? null,
        message: result.message ?? null,
        displayText: String(result.displayText ?? ""),
        ...(String(result.author ?? "").trim() ? { author: String(result.author).trim() } : {}),
        ...(normalizeInterstreamOrigin(result.origin)
          ? { origin: normalizeInterstreamOrigin(result.origin) }
          : {}),
        responseAnnotations: Array.isArray(result.responseAnnotations)
          ? result.responseAnnotations.map((item) => ({ ...item }))
          : [],
        responseAnnotationRequest: String(result.responseAnnotationRequest ?? ""),
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

  function desktopContextSnapshot(thread, turn = "", fallbackUsage = null) {
    const usage = context.latestUsage(thread, turn) ?? fallbackUsage;
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
      breakdown: presentContextUsageBreakdown({
        breakdown: usage?.breakdown,
        provider: usage?.provider,
        usedTokens,
        modelContextWindow: windowTokens,
      }),
    };
  }

  function desktopRunSnapshot(run, { compactSnapshot = false } = {}) {
    if (!run) return null;
    const promptInterstream = interstreamMessageDetails(run.promptPreview);
    const promptOrigin = normalizeInterstreamOrigin(run.messageOrigin) ?? promptInterstream?.origin;
    const responseItem = (Array.isArray(run.responseItems) ? run.responseItems : [])
      .find((item) => String(item?.id ?? "") === String(run.responseItemId ?? ""));
    const compactActivity = (activity) => {
      const cloned = structuredClone(activity);
      if (!compactSnapshot || typeof cloned?.detail !== "string") return cloned;
      if (cloned.detail.length <= MAX_COMPACT_ACTIVITY_DETAIL_CHARS) return cloned;
      return {
        ...cloned,
        detail: `${cloned.detail.slice(0, MAX_COMPACT_ACTIVITY_DETAIL_CHARS)}…`,
      };
    };
    const activityGroups = (Array.isArray(run.activityGroups) ? run.activityGroups : []).map((group) => ({
      ...structuredClone(group),
      activities: (Array.isArray(group?.activities) ? group.activities : []).map(compactActivity),
    }));
    const activities = compactSnapshot && activityGroups.length
      ? []
      : (Array.isArray(run.activities) ? run.activities : []).map(compactActivity);
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
      ...(run.providerStart ? { providerStart: structuredClone(run.providerStart) } : {}),
      prompt: displayUserPrompt(run.promptPreview),
      ...(promptOrigin ? {
        promptAuthor: interstreamOriginAuthor(promptOrigin),
        promptOrigin,
      } : {}),
      attachments: Array.isArray(run.messageAttachments)
        ? run.messageAttachments.map((attachment) => ({ ...attachment }))
        : [],
      userMessages: (Array.isArray(run.userMessages) ? run.userMessages : []).flatMap((message) => {
        const rawText = String(message?.text ?? "");
        const role = message?.role === "agent" && message?.kind === "subagent" ? "agent" : "user";
        const interstream = interstreamMessageDetails(rawText);
        const origin = normalizeInterstreamOrigin(message?.origin) ?? interstream?.origin;
        const text = displayUserPrompt(rawText);
        if (!text) return [];
        const clientUserMessageId = String(message.clientUserMessageId ?? "");
        const receipt = role === "user" && clientUserMessageId
          ? receipts.forMessage?.({
            provider: run.provider,
            threadId: run.threadId,
            clientUserMessageId,
          })
          : null;
        return [{
          itemId: String(message.itemId ?? ""),
          clientUserMessageId,
          role,
          text,
          ...(message?.kind ? { kind: String(message.kind) } : {}),
          ...(message?.agentThreadId ? { agentThreadId: String(message.agentThreadId) } : {}),
          ...(message?.model ? { model: String(message.model) } : {}),
          ...((interstreamOriginAuthor(origin) || String(message.author ?? "").trim())
            ? { author: interstreamOriginAuthor(origin) || String(message.author).trim() }
            : {}),
          ...(origin ? { origin } : {}),
          time: message.time ?? run.startedAt ?? receipt?.createdAt ?? null,
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
      ...(responseItem?.phase ? { responsePhase: String(responseItem.phase) } : {}),
      clientUserMessageId: run.clientUserMessageId ?? null,
      responseItemId: run.responseItemId ?? null,
      startedAt: run.startedAt ?? null,
      lastActivityAt: run.lastMeaningfulProgressAt ?? run.progressHeartbeatAt ?? run.startedAt ?? null,
      activities,
      ...(activityGroups.length
        ? { activityGroups }
        : {}),
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
    const candidateRun = runs.forTask(task);
    const run = candidateRun
      && String(candidateRun.provider ?? "") === String(entry.provider ?? "")
      && String(candidateRun.threadId ?? "") === String(entry.threadId ?? "")
      ? candidateRun
      : null;
    const context = desktopContextSnapshot(entry.threadId, run?.turnId, entry.contextUsage);
    const internalMaintenanceObserver = isInternalMaintenanceObserver(run, context);
    const runActive = taskRunIsActive(run);
    const visibleRun = internalMaintenanceObserver || !runActive ? null : run;
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
      sessionCwd: entry.sessionCwd ?? null,
      projectName: entry.projectName ?? tasks.projectNameFor(entry.projectRoot),
      threadId: entry.threadId,
      title: displayTitle,
      displayTitle,
      threadTitle: entry.title,
      model: visibleRun?.model ?? entry.model ?? null,
      selected: tasks.entryIsSelected(entry, selection.selectedTask()),
      running: internalMaintenanceObserver
        ? false
        : (run ? runActive : Boolean(entry.running)),
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
      run: desktopRunSnapshot(visibleRun, { compactSnapshot }),
    };
  }

  async function desktopSnapshot({
    refresh = false,
    accountId = "",
    knownVersion = "",
    compactSnapshot = false,
  } = {}) {
    if (refresh || catalog.stale()) {
      // A Desktop RPC must remain responsive while Codex App Server is slow or
      // recovering. The catalog owns refresh de-duplication; return its last
      // known state now and let the following poll receive the refreshed list.
      scheduleCatalogRefresh(refresh);
    }
    const cacheKey = versionCacheKey({ accountId, compactSnapshot });
    const beforeRevision = refresh ? null : await sourceRevision({ accountId, compactSnapshot });
    const cached = versionCache.get(cacheKey);
    if (
      knownVersion
      && beforeRevision !== null
      && cached?.version === knownVersion
      && cached.revision === beforeRevision
    ) {
      return { notModified: true, version: knownVersion };
    }
    const workspaces = board.workspaces?.() ?? catalog.hierarchy?.() ?? [];
    let entries = catalog.entries();
    if (
      !entries.some((entry) => tasks.entryIsSelected(entry, selection.selectedTask()))
      && selection.hasThread()
    ) {
      const selectedTarget = selection.selectedTurnTarget();
      const transientTitle = String(
        selectedTarget.taskTitle ?? selection.activeThreadTitle?.() ?? "",
      ).trim() || `${selectedTarget.provider} · ${String(selectedTarget.threadId).slice(0, 8)}`;
      entries = catalog.merge([...entries, {
        ...selectedTarget,
        ...workspaceBindingForTask(selectedTarget, workspaces),
        projectName: selection.activeProject().name,
        title: transientTitle,
        model: selectedTarget.modelId ?? null,
        updatedAtMs: 0,
        running: false,
      }]);
    }
    const taskSnapshots = entries.map((entry) => desktopTaskSnapshot(entry, { accountId, compactSnapshot }));
    const selectedTaskSnapshot = taskSnapshots.find((task) => task.selected) ?? null;
    const selectedIdentity = selection.selectedTask();
    const current = settings.current();
    const activeProvider = current.activeProvider;
    const claudeReasoningEfforts = current.claudeReasoningEfforts ?? current.reasoningEfforts;
    const claudeReasoningLabels = current.claudeReasoningLabels ?? current.reasoningLabels;
    const claudeLabel = current.claudeModelLabel
      ?? ((value) => current.claudeModelLabels[value] ?? value);
    const claudeOptions = claudeModelOptions({
      aliases: current.claudeModels,
      observed: taskSnapshots
        .filter((task) => task.provider === "claude")
        .map((task) => task.model),
      selected: current.claudeModel,
    });
    const reasoningEfforts = activeProvider === "codex"
      ? current.reasoningEfforts
      : claudeReasoningEfforts;
    const reasoningLabels = activeProvider === "codex"
      ? current.reasoningLabels
      : claudeReasoningLabels;
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
      workspaces,
      boardTasks: board.snapshot?.() ?? [],
      boardLayout: board.layout?.() ?? { columnOrder: [], notesComment: "" },
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
          : claudeLabel(current.claudeModel),
        reasoning: reasoningLabels[activeProvider === "codex"
          ? current.codexReasoningEffort
          : current.claudeReasoningEffort],
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
        activityRecentMinutes: current.activityRecentMinutes,
        models: activeProvider === "codex"
          ? current.codexModels.map((model) => ({ value: model.value, label: model.label }))
          : claudeOptions,
        modelOptionsByProvider: {
          codex: current.codexModels.map((model) => ({ value: model.value, label: model.label })),
          claude: claudeOptions,
        },
        reasoningOptions: reasoningEfforts.map((value) => ({
          value,
          label: reasoningLabels[value],
        })),
        reasoningOptionsByProvider: {
          codex: current.reasoningEfforts.map((value) => ({
            value,
            label: current.reasoningLabels[value],
          })),
          claude: claudeReasoningEfforts.map((value) => ({
            value,
            label: claudeReasoningLabels[value],
          })),
        },
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
          ...deferredMessageProjection(item, deferred),
          annotations: deferred.responseAnnotations?.(item.input) ?? [],
          allowForce: item.allowForce === true,
          conflictKind: item.conflictKind ?? null,
          ...deferredWaitProjection(item),
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
          ...deferredMessageProjection(item, deferred),
          annotations: deferred.responseAnnotations?.(item.input) ?? [],
          allowForce: false,
          conflictKind: item.conflictKind ?? null,
          ...deferredWaitProjection(item),
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
    const afterRevision = await sourceRevision({ accountId, compactSnapshot });
    if (beforeRevision !== null && beforeRevision === afterRevision) {
      versionCache.set(cacheKey, { revision: afterRevision, version });
    } else {
      versionCache.delete(cacheKey);
    }
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
