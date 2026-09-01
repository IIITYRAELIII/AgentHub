import { createHash } from "node:crypto";
import {
  displayUserPrompt,
  exactTurnReceiptBindings,
  userTaskReferencePromptDetails,
} from "../../application/task-history.mjs";
import { isClaudeCompactionRun } from "../../domain/claude-context-maintenance.mjs";
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
import { restartUiProjection } from "../../domain/maintenance-operation.mjs";
import { deferredLaunchWaitReason } from "../../application/deferred-input-controller.mjs";
import { createSnapshotCollectionDelta } from "./snapshot-collection-delta.mjs";

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
  const provider = String(task?.provider ?? "");
  const threadId = String(task?.threadId ?? "");
  if (!streamId && (!provider || !threadId)) return {};
  const matches = [];
  for (const workspace of workspaces ?? []) {
    for (const stream of workspace?.streams ?? []) {
      const streamMatches = streamId
        ? String(stream?.id ?? "") === streamId
        : (stream.threads ?? []).some((candidate) => (
          String(candidate?.provider ?? "") === provider
          && String(candidate?.threadId ?? candidate?.id ?? "") === threadId
        ));
      if (!streamMatches) continue;
      matches.push({ workspace, stream });
    }
  }
  if (matches.length !== 1) return {};
  const { workspace, stream } = matches[0];
  const thread = (stream.threads ?? []).find((candidate) => (
    String(candidate?.provider ?? "") === provider
    && String(candidate?.threadId ?? candidate?.id ?? "") === threadId
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
  telemetry = {},
  board = {},
  server = {},
  readState = null,
  revision = null,
  monotonicNow = () => performance.now(),
  warn,
}) {
  const versionCache = new Map();
  const conversationDelta = createSnapshotCollectionDelta({
    keyOf: (item) => [item?.streamId, item?.provider, item?.threadId].join("\u0000"),
  });
  const workspaceDelta = createSnapshotCollectionDelta({ keyOf: (item) => item?.id });
  const boardTaskDelta = createSnapshotCollectionDelta({ keyOf: (item) => item?.id });
  const messageReceiptDelta = createSnapshotCollectionDelta({
    keyOf: (item) => [item?.provider, item?.threadId, item?.clientUserMessageId].join("\u0000"),
  });
  let catalogRefresh = null;

  function catalogActiveRun(entry, lastMessage) {
    if (entry?.running !== true) return null;
    const provider = String(entry.provider ?? "").trim();
    const threadId = String(entry.threadId ?? "").trim();
    if (!provider || !threadId) return null;
    const turnId = String(entry.turnId ?? "").trim();
    if (provider.toLowerCase() === "codex" && !turnId) return null;
    const lastAnswerTurnId = String(lastMessage?.turnId ?? "").trim();
    if (turnId && turnId === lastAnswerTurnId) return null;
    const lastActivityAtMs = Number(entry.lastActivityAtMs);
    const startedAtMs = Date.parse(String(entry.startedAt ?? ""));
    const lastAnswerAtMs = Date.parse(String(lastMessage?.updatedAt ?? ""));
    const catalogActivityAtMs = Math.max(
      Number.isFinite(lastActivityAtMs) ? lastActivityAtMs : 0,
      Number.isFinite(startedAtMs) ? startedAtMs : 0,
    );
    if (!turnId && catalogActivityAtMs > 0 && lastAnswerAtMs >= catalogActivityAtMs) return null;
    const lastMeaningfulProgressAt = Number.isFinite(lastActivityAtMs) && lastActivityAtMs > 0
      ? new Date(lastActivityAtMs).toISOString()
      : entry.startedAt ?? null;
    // Provider discovery can observe the current Thread before the external-run
    // watcher has replaced a pre-rebirth registry entry keyed by the same
    // Stream. Keep the snapshot contract coherent during that window: a task
    // advertised as running must still have a current-binding live projection.
    return {
      id: `catalog:${provider}:${threadId}`,
      turnId: turnId || null,
      provider,
      projectRoot: entry.projectRoot,
      threadId,
      status: "running",
      observer: true,
      executionOwner: entry.executionOwner ?? null,
      model: entry.model ?? null,
      progressStage: String(entry.stage ?? "").trim() || "Ход выполняется",
      promptPreview: "",
      userMessages: [],
      progressReasoning: "",
      responseText: "",
      responseItems: [],
      startedAt: entry.startedAt ?? null,
      lastMeaningfulProgressAt,
      activities: [],
      activityGroups: [],
    };
  }

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

  function versionCacheKey({ accountId, compactSnapshot, snapshotProtocol }) {
    return [
      String(accountId ?? ""),
      compactSnapshot === true ? "compact" : "full",
      Number(snapshotProtocol) >= 4 ? "v4" : "v3",
    ].join("\u0000");
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
        responseAnnotationRequest: displayUserPrompt(result.responseAnnotationRequest),
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

  function desktopRunSnapshot(run, { compactSnapshot = false, operationKind = "" } = {}) {
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
    const runUserMessages = Array.isArray(run.userMessages) ? run.userMessages : [];
    const turnReceiptsValue = receipts.forTurn?.({
      provider: run.provider,
      threadId: run.threadId,
      turnId: run.turnId,
    });
    const turnReceiptBindings = exactTurnReceiptBindings(
      runUserMessages,
      Array.isArray(turnReceiptsValue)
        ? turnReceiptsValue
        : turnReceiptsValue ? [turnReceiptsValue] : [],
    );
    return {
      id: run.id,
      turnId: run.turnId ?? null,
      provider: run.provider,
      threadId: run.threadId,
      taskTitle: runs.titleFor(run),
      status: run.status,
      ...(operationKind ? { operationKind } : {}),
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
      userMessages: runUserMessages.flatMap((message, index) => {
        const rawText = String(message?.text ?? "");
        const role = message?.role === "agent" && message?.kind === "subagent" ? "agent" : "user";
        const interstream = interstreamMessageDetails(rawText);
        const origin = normalizeInterstreamOrigin(message?.origin) ?? interstream?.origin;
        const text = displayUserPrompt(rawText);
        const turnReceipt = role === "user" ? turnReceiptBindings.get(index) ?? null : null;
        const clientUserMessageId = String(
          message.clientUserMessageId ?? turnReceipt?.clientUserMessageId ?? "",
        ).trim();
        const rootUserMessage = role === "user"
          && clientUserMessageId === String(run.clientUserMessageId ?? "").trim();
        const receipt = role === "user" && clientUserMessageId
          ? receipts.forMessage?.({
            provider: run.provider,
            threadId: run.threadId,
            clientUserMessageId,
          }) ?? turnReceipt
          : null;
        const receiptAttachments = Array.isArray(receipt?.result?.attachments)
          ? receipt.result.attachments
          : [];
        const runAttachments = clientUserMessageId === String(run.clientUserMessageId ?? "")
          && Array.isArray(run.messageAttachments)
          ? run.messageAttachments
          : [];
        const promptTaskReferences = role === "user"
          ? userTaskReferencePromptDetails(rawText)?.references ?? []
          : [];
        const attachments = (
          receiptAttachments.length
            ? receiptAttachments
            : runAttachments.length
              ? runAttachments
              : promptTaskReferences
        ).map((attachment) => ({ ...attachment }));
        if (!text && !attachments.length) return [];
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
          ...(role === "user" && Array.isArray(
            receipt?.result?.responseAnnotations ?? message.responseAnnotations,
          ) ? {
            responseAnnotations: (
              receipt?.result?.responseAnnotations ?? message.responseAnnotations
            ).map((item) => ({ ...item })),
            responseAnnotationRequest: displayUserPrompt(
              receipt?.result?.responseAnnotationRequest ?? message.responseAnnotationRequest,
            ),
          } : {}),
          ...(rootUserMessage ? {
            submittedAt: message.submittedAt ?? run.submittedAt ?? receipt?.createdAt ?? message.time ?? run.startedAt ?? null,
            startedAt: message.startedAt ?? run.startedAt ?? null,
          } : {}),
          time: rootUserMessage
            ? message.submittedAt ?? run.submittedAt ?? receipt?.createdAt ?? message.time ?? run.startedAt ?? null
            : message.time ?? run.startedAt ?? receipt?.createdAt ?? null,
          attachments,
        }];
      }),
      progress: String(run.progressReasoning ?? ""),
      response: String(run.responseText ?? ""),
      ...(responseItem?.phase ? { responsePhase: String(responseItem.phase) } : {}),
      clientUserMessageId: run.clientUserMessageId ?? null,
      submittedAt: run.submittedAt ?? runUserMessages[0]?.submittedAt ?? runUserMessages[0]?.time ?? run.startedAt ?? null,
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

  function isPostCompactionMeasurementObserver(run, context) {
    if (run?.observer !== true || context?.compaction?.status !== "completed") return false;
    const hasVisibleContent = Boolean(
      String(run.promptPreview ?? "").trim()
      || String(run.responseText ?? "").trim()
      || String(run.progressReasoning ?? "").trim()
      || (Array.isArray(run.userMessages) && run.userMessages.some((message) => (
        String(message?.text ?? "").trim()
        || (Array.isArray(message?.attachments) && message.attachments.length)
      )))
      || (Array.isArray(run.messageAttachments) && run.messageAttachments.length)
      || (Array.isArray(run.activities) && run.activities.length)
      || (Array.isArray(run.activityGroups) && run.activityGroups.length)
    );
    if (hasVisibleContent) return false;
    if (context.usagePending === true) return true;
    const runTurnId = String(run.turnId ?? "").trim();
    const usageTurnId = String(context.turnId ?? "").trim();
    const compactionTurnId = String(context.compaction.turnId ?? "").trim();
    return Boolean(
      runTurnId
      && runTurnId === usageTurnId
      && runTurnId !== compactionTurnId
    );
  }

  function isInternalMaintenanceObserver(run, context) {
    if (!run) return false;
    const turnId = String(run.turnId ?? "").trim();
    const probeTurnIds = new Set(
      (context?.compaction?.probeTurnIds ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    );
    return isCompactionOnlyObserver(run, context)
      || isPostCompactionMeasurementObserver(run, context)
      || (turnId && probeTurnIds.has(turnId))
      || isClaudeCompactionRun(run)
      || (run.provider === "codex" && isCodexContextProbeTurn({
        prompt: run.promptPreview,
        finalAnswer: run.responseText,
        clientUserMessageId: run.clientUserMessageId,
        userMessages: run.userMessages,
      }, { allowTextFallback: false }));
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
    const boundRun = candidateRun
      && String(candidateRun.provider ?? "") === String(entry.provider ?? "")
      && String(candidateRun.threadId ?? "") === String(entry.threadId ?? "")
      ? candidateRun
      : null;
    // Do not reuse a retained run from the previous Thread of this Stream.
    // When the catalog independently confirms that the new binding is active,
    // synthesize only the minimal current-binding projection until its observer
    // is registered. A matching terminal run remains authoritative and is not
    // converted back into an active one.
    const lastMessage = tasks.savedLastMessage(task);
    const run = boundRun ?? catalogActiveRun(entry, lastMessage);
    const context = desktopContextSnapshot(entry.threadId, run?.turnId, entry.contextUsage);
    const internalMaintenanceObserver = isInternalMaintenanceObserver(run, context);
    const runActive = taskRunIsActive(run);
    const runTurnId = String(run?.turnId ?? "").trim();
    const savedAnswerTurnId = String(lastMessage?.turnId ?? "").trim();
    const savedCompletionMatchesRun = Boolean(
      runActive
      && runTurnId
      && savedAnswerTurnId === runTurnId
    );
    const visibleRun = internalMaintenanceObserver || !runActive || savedCompletionMatchesRun
      ? null
      : run;
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
      running: Boolean(visibleRun),
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
      run: desktopRunSnapshot(visibleRun, {
        compactSnapshot,
        operationKind: visibleRun ? "user-turn" : "",
      }),
    };
  }

  async function desktopSnapshot({
    refresh = false,
    accountId = "",
    knownVersion = "",
    compactSnapshot = false,
    snapshotProtocol = 3,
    conversationsVersion = "",
    workspacesVersion = "",
    boardTasksVersion = "",
    messageReceiptsVersion = "",
  } = {}) {
    const snapshotStartedAt = monotonicNow();
    const snapshotTiming = {};
    const finishTiming = (result, cacheHit = false) => ({
      ...result,
      snapshotTiming: {
        cacheHit,
        ...snapshotTiming,
        totalMs: Math.round((monotonicNow() - snapshotStartedAt) * 10) / 10,
      },
    });
    const protocol = Number(snapshotProtocol) >= 4 ? 4 : 3;
    if (refresh || catalog.stale()) {
      // A Desktop RPC must remain responsive while Codex App Server is slow or
      // recovering. The catalog owns refresh de-duplication; return its last
      // known state now and let the following poll receive the refreshed list.
      scheduleCatalogRefresh(refresh);
    }
    const cacheKey = versionCacheKey({ accountId, compactSnapshot, snapshotProtocol: protocol });
    const revisionParams = { accountId, compactSnapshot, snapshotProtocol: protocol };
    const requestedCollectionVersions = {
      conversations: String(conversationsVersion),
      workspaces: String(workspacesVersion),
      boardTasks: String(boardTasksVersion),
      messageReceipts: String(messageReceiptsVersion),
    };
    let phaseStartedAt = monotonicNow();
    const beforeRevision = refresh ? null : await sourceRevision(revisionParams);
    snapshotTiming.revisionBeforeMs = Math.round((monotonicNow() - phaseStartedAt) * 10) / 10;
    const cached = versionCache.get(cacheKey);
    const collectionVersionsMatch = (versions) => protocol < 4 || (
      versions
      && Object.entries(requestedCollectionVersions).every(([name, value]) => (
        value && value === versions[name]
      ))
    );
    if (
      knownVersion
      && beforeRevision !== null
      && cached?.version === knownVersion
      && cached.revision === beforeRevision
      && collectionVersionsMatch(cached.collectionVersions)
    ) {
      return finishTiming({ notModified: true, version: knownVersion }, true);
    }
    phaseStartedAt = monotonicNow();
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
    snapshotTiming.taskProjectionMs = Math.round((monotonicNow() - phaseStartedAt) * 10) / 10;
    const selectedTaskSnapshot = taskSnapshots.find((task) => task.selected) ?? null;
    phaseStartedAt = monotonicNow();
    if (selectedTaskSnapshot && !selectedTaskSnapshot.running && telemetry.recent) {
      try {
        const [latestTelemetry] = await telemetry.recent({
          provider: selectedTaskSnapshot.provider,
          threadId: selectedTaskSnapshot.threadId,
          limit: 1,
        });
        if (latestTelemetry) {
          selectedTaskSnapshot.providerTurnTelemetry = structuredClone(latestTelemetry);
        }
      } catch (error) {
        warn?.("Cannot read latest provider turn telemetry:", error.message);
      }
    }
    snapshotTiming.telemetryMs = Math.round((monotonicNow() - phaseStartedAt) * 10) / 10;
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
    const restartRequest = restart.request();
    const restartProjection = restartUiProjection(restartRequest);
    const restartBlockingCount = restartProjection.blockingCount;
    const restartWaiting = restartProjection.waiting;
    phaseStartedAt = monotonicNow();
    const serverSnapshot = typeof server.snapshot === "function"
      ? await server.snapshot({
        activeCount,
        restart: {
          pending: restartProjection.pending,
          waiting: restartWaiting,
          blockingCount: restartBlockingCount,
        },
      })
      : null;
    snapshotTiming.serverStateMs = Math.round((monotonicNow() - phaseStartedAt) * 10) / 10;
    phaseStartedAt = monotonicNow();
    const boardTasks = board.snapshot?.() ?? [];
    const messageReceipts = desktopMessageReceiptSnapshot();
    const snapshot = {
      apiVersion: protocol,
      workspaces,
      boardTasks,
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
        streamOrderMode: current.streamOrderMode,
        streamCardWidthMode: current.streamCardWidthMode,
        streamCardFixedWidth: current.streamCardFixedWidth,
        streamCardGapEnabled: current.streamCardGapEnabled === true,
        pinnedWorkspaceStreams: current.pinnedWorkspaceStreams ?? {},
        quickMessages: current.quickMessages ?? { global: [], streams: {}, workspaces: {} },
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
      messageReceipts,
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
          state: item.dispatchingAt
            ? "dispatching"
            : item.conflictKind === "message-steer"
              ? "steering"
              : item.paused === true ? "paused" : "queued",
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
      restartPending: restartProjection.pending,
      restartWaiting,
      restartBlockingCount,
      exchangeRates: exchangeRates?.snapshot?.() ?? null,
      activeCount,
      server: serverSnapshot,
      ...(protocol >= 4 ? { conversations: taskSnapshots } : { tasks: taskSnapshots }),
    };
    snapshotTiming.stateAssemblyMs = Math.round((monotonicNow() - phaseStartedAt) * 10) / 10;
    phaseStartedAt = monotonicNow();
    const collectionDeltas = protocol >= 4 ? {
      conversations: conversationDelta(taskSnapshots, conversationsVersion),
      workspaces: workspaceDelta(workspaces, workspacesVersion),
      boardTasks: boardTaskDelta(boardTasks, boardTasksVersion),
      messageReceipts: messageReceiptDelta(messageReceipts, messageReceiptsVersion),
    } : null;
    const collectionVersions = collectionDeltas ? Object.fromEntries(
      Object.entries(collectionDeltas).map(([name, delta]) => [name, delta.version]),
    ) : null;
    const {
      workspaces: _workspaces,
      boardTasks: _boardTasks,
      messageReceipts: _messageReceipts,
      conversations: _conversations,
      ...transportSnapshot
    } = protocol >= 4 ? snapshot : {};
    const version = createHash("sha256")
      .update(JSON.stringify(protocol >= 4
        ? { ...transportSnapshot, collectionVersions }
        : snapshot))
      .digest("base64url")
      .slice(0, 22);
    snapshotTiming.versioningMs = Math.round((monotonicNow() - phaseStartedAt) * 10) / 10;
    phaseStartedAt = monotonicNow();
    const afterRevision = await sourceRevision(revisionParams);
    snapshotTiming.revisionAfterMs = Math.round((monotonicNow() - phaseStartedAt) * 10) / 10;
    if (beforeRevision !== null && beforeRevision === afterRevision) {
      versionCache.set(cacheKey, { revision: afterRevision, version, collectionVersions });
    } else {
      versionCache.delete(cacheKey);
    }
    if (
      knownVersion
      && knownVersion === version
      && collectionVersionsMatch(collectionVersions)
    ) return finishTiming({ notModified: true, version });
    if (protocol < 4) return finishTiming({ ...snapshot, generatedAt: clock.nowIso(), version });
    return finishTiming({
      ...transportSnapshot,
      collectionDeltas,
      generatedAt: clock.nowIso(),
      version,
    });
  }

  return {
    desktopContextSnapshot,
    desktopRunSnapshot,
    desktopTaskSnapshot,
    desktopSnapshot,
  };
}
