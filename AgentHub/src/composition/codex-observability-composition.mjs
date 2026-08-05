import { turnEndKey } from "../application/turn-end-notifications.mjs";
import { fallbackTurnEndMessage } from "../application/turn-end-delivery-service.mjs";
import { taskRunKey } from "../domain/task-runs.mjs";
import { captureTaskGitBaseline, taskGitDiff } from "../infrastructure/filesystem/task-git-diff.mjs";
import { CodexAccountingResolver } from "../providers/codex/codex-accounting-resolver.mjs";
import { scanCodexHistoricalRolloutInWorker } from "../providers/codex/codex-historical-backfill.mjs";
import { resolveCodexJournalProject } from "../providers/codex/codex-journal-project.mjs";
import { CODEX_AUDIT_SOURCE_KINDS } from "../providers/codex/codex-subagent-accounting.mjs";
import { CodexTerminalAudit } from "../providers/codex/codex-terminal-audit.mjs";
import { CodexTerminalReconciliationService } from "../providers/codex/codex-terminal-reconciliation-service.mjs";
import {
  discoverCodexRollouts,
  discoverCodexSubagentRollouts,
  findCodexRolloutPath,
  readCodexRolloutSession,
  readCodexSubagentSpawn,
  readCodexTurnUsage,
  scanCodexHistoricalRollout,
} from "../providers/codex/codex-turn-usage.mjs";
import { CodexUsageTracker } from "../providers/codex/codex-usage-tracker.mjs";
import { ContextCompactionTracker } from "../providers/codex/context-compaction-tracker.mjs";
import {
  readCodexRolloutActivity,
} from "../../task-catalog.mjs";
import {
  normalizeTaskExecutionOwner,
  TASK_EXECUTION_OWNERS,
} from "../domain/task-execution-owner.mjs";

function setBounded(map, key, value, limit) {
  if (!key) return;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

export function createCodexObservabilityComposition({
  config,
  sendRpc,
  scheduleDeferredRestartIfReady,
  taskRuns,
  turnEndNotifications,
  workLogUsageStore,
  changedFilesForRun,
  projectTurnUsageToWorkLog,
  runtimeCommandTaskTitle,
  rememberLastTaskMessage,
  lastSeenTaskTurnIds,
  saveState,
  deliverTurnEndNotification,
  defaultNotificationChatId,
  findProject,
  resolveTaskByProviderRef,
  globalWorkLogProjectRoots,
  isHistoricalBackfillIdle,
}) {
  const usageTracker = new CodexUsageTracker();
  const rolloutPathsByProviderTaskId = new Map();
  const compactions = new ContextCompactionTracker({
    cleanupTimeoutMs: Math.max(
      2 * 60_000,
      (config.codexRolloutContext.scanIntervalSeconds + 60) * 1_000,
    ),
    onSettled: scheduleDeferredRestartIfReady,
  });
  const turnStarts = new Map();
  const accounting = new CodexAccountingResolver({
    readThread: (providerTaskId) => sendRpc("thread/read", {
      threadId: providerTaskId,
      includeTurns: false,
    }),
    findRollout: (providerTaskId) => findCodexRolloutPath(providerTaskId, ""),
    readRolloutSession: readCodexRolloutSession,
    readSubagentSpawn: readCodexSubagentSpawn,
    scanHistoricalRollout: scanCodexHistoricalRollout,
  });
  const hookReceipts = { start: null, stop: null };

  function capturedExecutionOwner(providerTaskId, turnId) {
    const normalizedTurnId = String(turnId ?? "").trim();
    if (!normalizedTurnId) return null;
    const record = turnStarts.get(turnEndKey({
      provider: "codex",
      threadId: String(providerTaskId ?? "").trim(),
      turnId: normalizedTurnId,
    }));
    const owner = normalizeTaskExecutionOwner(record?.executionOwner);
    return Object.values(TASK_EXECUTION_OWNERS).includes(owner)
        && owner !== TASK_EXECUTION_OWNERS.EXTERNAL
      ? owner
      : null;
  }

  async function knownRolloutPath(providerTaskId, startedAt = "") {
    const key = String(providerTaskId ?? "").trim();
    const known = String(rolloutPathsByProviderTaskId.get(key) ?? "").trim();
    if (known) return known;
    if (!String(startedAt ?? "").trim()) return "";
    const discovered = await findCodexRolloutPath(key, startedAt);
    if (discovered) setBounded(rolloutPathsByProviderTaskId, key, discovered, 5_000);
    return discovered;
  }

  function rememberRolloutPath(providerTaskId, rolloutPath) {
    setBounded(rolloutPathsByProviderTaskId, providerTaskId, rolloutPath, 5_000);
  }

  async function rememberAuditedTurnStart(thread, project, turn) {
    const identity = {
      provider: "codex",
      threadId: String(thread?.id ?? "").trim(),
      turnId: String(turn?.turnId ?? "").trim(),
    };
    if (!identity.threadId || !identity.turnId) return;
    const key = turnEndKey(identity);
    const existing = turnStarts.get(key);
    if (existing?.gitBaseline) return;
    const gitBaseline = await captureTaskGitBaseline(
      project.path,
      config.dataDir,
      `terminal-audit-${identity.turnId}`,
    );
    const record = {
      ...existing,
      ...identity,
      projectRoot: project.path,
      startedAt: existing?.startedAt || String(turn?.startedAt ?? ""),
      prompt: existing?.prompt || "",
      gitBaseline: gitBaseline ?? existing?.gitBaseline ?? null,
    };
    setBounded(turnStarts, key, record, 500);
    const run = taskRuns.forEvent({ ...identity, allowThreadFallback: true });
    if (!run) return;
    run.turnId ||= identity.turnId;
    run.startedAt = record.startedAt || run.startedAt;
    run.gitBaseline = record.gitBaseline ?? run.gitBaseline;
    taskRuns.reindex(run);
  }

  const terminalReconciliation = new CodexTerminalReconciliationService({
    notifications: turnEndNotifications,
    turnStarts,
    workLogStore: workLogUsageStore,
    accountingThread: (thread) => accounting.accountingThread(thread),
    subagentParentTurnId: (thread, accountingThread) => (
      accounting.subagentParentTurnId(thread, accountingThread)
    ),
    readTurnUsage: readCodexTurnUsage,
    taskGitDiff,
    dataDir: config.dataDir,
    changedFilesForRun,
    projectTurn: projectTurnUsageToWorkLog,
    taskTitle: runtimeCommandTaskTitle,
    defaultChatId: defaultNotificationChatId,
    fallbackMessage: fallbackTurnEndMessage,
    rememberLastMessage: rememberLastTaskMessage,
    rememberSeenTurn: (task, turnId) => {
      setBounded(lastSeenTaskTurnIds, taskRunKey(task), turnId, 500);
    },
    saveState,
    deliverNotification: deliverTurnEndNotification,
  });
  const terminalAudit = new CodexTerminalAudit({
    listPage: (cursor, limit) => sendRpc("thread/list", {
      cursor,
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: CODEX_AUDIT_SOURCE_KINDS,
    }),
    readThread: (providerTaskId) => sendRpc("thread/read", {
      threadId: providerTaskId,
      includeTurns: true,
    }),
    isTurnActive: async (thread, turnId) => {
      const activity = await readCodexRolloutActivity(thread?.path);
      return activity.activeTurnIds.includes(String(turnId));
    },
    onTurnStarted: rememberAuditedTurnStart,
    onTurnActive: async (thread, project, turnId) => {
      const identity = {
        provider: "codex",
        threadId: String(thread?.id ?? ""),
        turnId: String(turnId),
      };
      const result = await workLogUsageStore.retractProvisionalAndProject({
        ...identity,
        projectRoot: project.path,
        projectionProjectRoots: globalWorkLogProjectRoots,
      });
      if (!result.retracted) return;
      turnEndNotifications.retract(identity);
      await saveState();
      console.log(`Retracted premature Codex terminal turn ${identity.turnId}`);
    },
    resolveProject: (thread) => resolveCodexJournalProject(thread, {
      findProject,
      readSession: readCodexRolloutSession,
      resolveParentProject: (providerTaskId) => {
        const parent = resolveTaskByProviderRef({ provider: "codex", providerTaskId });
        return parent ? findProject(parent.projectRoot) : null;
      },
    }),
    reconcile: (...args) => terminalReconciliation.reconcile(...args),
    discoverHistoricalThreads: () => discoverCodexRollouts(),
    discoverSupplementalThreads: () => discoverCodexSubagentRollouts(),
    scanHistoricalFile: scanCodexHistoricalRolloutInWorker,
    shouldRunHistoricalBackfill: isHistoricalBackfillIdle,
  });

  return {
    usageTracker,
    turnTokenUsage: usageTracker.turns,
    compactions,
    turnStarts,
    hookReceipts,
    replaceHookReceipts(value) {
      hookReceipts.start = value?.start ?? null;
      hookReceipts.stop = value?.stop ?? null;
    },
    capturedExecutionOwner,
    knownRolloutPath,
    rememberRolloutPath,
    terminalAudit,
  };
}
