import path from "node:path";

import { turnEndKey } from "../../application/turn-end-notifications.mjs";
import { isCodexContextProbeClientId } from "../../domain/codex-service-usage-identity.mjs";
import { conciseTurnTitle } from "../../application/turn-title.mjs";
import { MAINTENANCE_OPERATION_KINDS } from "../../domain/maintenance-operation.mjs";
import { isLegacyCodexContextProbeClientId } from "../../domain/legacy-codex-context-probe.mjs";
import { normalizeServiceTier, normalizeTokenUsage } from "../../domain/token-usage.mjs";

function sameHistoricalUsage(record, usageResult) {
  if (!record || record.provisional === true) return false;
  return record.usageReported === (usageResult.reported === true)
    && JSON.stringify(normalizeTokenUsage(record.usage)) === JSON.stringify(normalizeTokenUsage(usageResult.usage))
    && (Number(record.estimatedCredits) || 0) === (Number(usageResult.estimatedCredits) || 0)
    && String(record.estimateKind ?? "") === String(usageResult.estimateKind ?? "")
    && Math.max(0, Math.floor(Number(record.imageGenerationCount) || 0))
      === Math.max(0, Math.floor(Number(usageResult.imageGenerationCount) || 0))
    && String(record.model ?? "").trim().toLowerCase() === String(usageResult.model ?? "").trim().toLowerCase()
    && String(record.serviceUsageKind ?? "") === String(usageResult.serviceUsageKind ?? "")
    && normalizeServiceTier(record.serviceTier) === normalizeServiceTier(usageResult.serviceTier);
}

function exactGeneratedImageSources(...values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    for (const source of Array.isArray(value) ? value : []) {
      const path = String(source?.value ?? "").trim();
      if (source?.type !== "generated-path" || !path || seen.has(path)) continue;
      seen.add(path);
      result.push({ type: "generated-path", value: path });
    }
  }
  return result;
}

export class CodexTerminalReconciliationService {
  constructor({
    notifications,
    turnStarts,
    workLogStore,
    operationStore = null,
    accountingThread,
    subagentParentTurnId,
    readTurnUsage,
    taskGitDiff,
    dataDir,
    projectTurn,
    taskTitle,
    defaultChatId,
    fallbackMessage,
    rememberLastMessage,
    rememberSeenTurn,
    saveState,
    deliverNotification,
    repairTerminalAttachments = async () => ({ enriched: false }),
    correctCommittedTerminal = async () => ({ corrected: false }),
    resolveTerminalAttachments = async () => [],
    completedGraceMs = 10_000,
    now = Date.now,
    logger = console,
  }) {
    this.notifications = notifications;
    this.turnStarts = turnStarts;
    this.workLogStore = workLogStore;
    this.operationStore = operationStore;
    this.accountingThread = accountingThread;
    this.subagentParentTurnId = subagentParentTurnId;
    this.readTurnUsage = readTurnUsage;
    this.taskGitDiff = taskGitDiff;
    this.dataDir = dataDir;
    this.projectTurn = projectTurn;
    this.taskTitle = taskTitle;
    this.defaultChatId = defaultChatId;
    this.fallbackMessage = fallbackMessage;
    this.rememberLastMessage = rememberLastMessage;
    this.rememberSeenTurn = rememberSeenTurn;
    this.saveState = saveState;
    this.deliverNotification = deliverNotification;
    this.repairTerminalAttachments = repairTerminalAttachments;
    this.correctCommittedTerminal = correctCommittedTerminal;
    this.resolveTerminalAttachments = resolveTerminalAttachments;
    this.completedGraceMs = completedGraceMs;
    this.now = now;
    this.logger = logger;
    this.reconciling = new Set();
  }

  async reconcile(thread, project, terminal, {
    localOnlyAccounting = false,
    deferProjection = false,
    onProjectionDeferred = null,
  } = {}) {
    const completedAtMs = Date.parse(String(terminal?.completedAt ?? ""));
    if (terminal?.status === "completed"
      && Number.isFinite(completedAtMs)
      && this.now() - completedAtMs < this.completedGraceMs) return false;
    const identity = {
      provider: "codex",
      threadId: String(thread.id),
      turnId: String(terminal.turnId),
    };
    const key = turnEndKey(identity);
    const operation = await this.operationStore?.forProviderTurn({
      kind: MAINTENANCE_OPERATION_KINDS.CONTEXT_COMPACTION,
      threadId: identity.threadId,
      providerTurnId: identity.turnId,
    });
    // Inline provider compaction shares an ordinary user turn. Only a persisted
    // Hub request for a dedicated provider turn authorizes internal accounting.
    const dedicatedCompaction = operation?.kind === MAINTENANCE_OPERATION_KINDS.CONTEXT_COMPACTION
      && operation.threadId === identity.threadId
      && operation.providerTurnId === identity.turnId
      && operation.metadata?.dedicatedProviderTurn === true;
    const subagentThread = Boolean(String(thread?.parentThreadId ?? "").trim());
    const alreadyDelivered = this.notifications.hasDelivered(identity);
    const pendingCompletion = this.notifications.get(identity);
    if (!dedicatedCompaction && terminal?.historical !== true && terminal?.attachmentRepairOnly !== true && !alreadyDelivered && !subagentThread
      && pendingCompletion
      && pendingCompletion.status !== "unknown"
      && pendingCompletion.usageReported
      && terminal?.usageResult?.terminal !== true) return true;
    if (this.reconciling.has(key)) return false;
    this.reconciling.add(key);
    try {
      if (terminal?.attachmentRepairOnly === true) {
        const generatedImageSources = exactGeneratedImageSources(terminal.generatedImageSources);
        if (!generatedImageSources.length) return true;
        await this.repairTerminalAttachments(identity, {
          expectedCount: generatedImageSources.length,
          resolveAttachments: () => this.resolveTerminalAttachments({
            threadId: identity.threadId,
            rolloutPath: thread.path,
            generatedImageSources,
          }, identity.turnId),
        });
        return true;
      }
      const usageResult = terminal?.usageResult
        ?? await this.readTurnUsage(thread.path, identity.turnId);
      const legacyProbe = isLegacyCodexContextProbeClientId(usageResult?.clientUserMessageId);
      if (legacyProbe && this.rememberLastMessage({ ...identity, projectRoot: project.path }, "", {
        removeTurnId: true,
      })) await this.saveState();
      const generatedImageSources = exactGeneratedImageSources(
        terminal?.generatedImageSources,
        usageResult?.generatedImageSources,
      );
      const expectedImageCount = Math.max(
        generatedImageSources.length,
        Math.floor(Number(usageResult.imageGenerationCount) || 0),
      );
      if (alreadyDelivered && expectedImageCount > 0) {
        await this.repairTerminalAttachments(identity, {
          expectedCount: expectedImageCount,
          resolveAttachments: () => this.resolveTerminalAttachments({
            threadId: identity.threadId,
            startedAt: usageResult.startedAt,
            rolloutPath: thread.path,
            expectedImageCount,
            ...(generatedImageSources.length ? { generatedImageSources } : {}),
          }, identity.turnId),
        });
      }
      const authoritativeStatus = terminal?.authoritative === true;
      if (!usageResult.terminal && !authoritativeStatus) return false;
      const resolvedStatus = usageResult.terminal
        ? (usageResult.status || terminal.status)
        : terminal.status;
      const resolvedCompletedAt = usageResult.terminal
        ? (usageResult.completedAt || terminal.completedAt)
        : terminal.completedAt;
      // Only a terminal event parsed from this exact provider rollout may
      // supersede a previously delivered status. An idle App Server snapshot,
      // timeout, or another turn is not terminal evidence.
      // The notification flag is not evidence that the terminal-store commit
      // exists (or does not exist). An exact rollout terminal may correct a
      // committed revision even when notification delivery was interrupted.
      let committedCorrection = null;
      if (terminal?.usageResult?.terminal === true
        && terminal.status === resolvedStatus
        && ["completed", "failed", "aborted", "cancelled"].includes(resolvedStatus)) {
        committedCorrection = await this.correctCommittedTerminal(identity, {
          status: resolvedStatus,
          completedAt: resolvedCompletedAt,
          finalAnswer: usageResult.finalAnswer,
        });
      }
      // The terminal outbox, not the notification flag, owns a committed turn.
      // Its pending projection must drain under the original revision; routing
      // through ordinary notification delivery here would commit a new one.
      if (committedCorrection?.terminal
        && (committedCorrection.corrected || !alreadyDelivered
          || committedCorrection.conflict || committedCorrection.stale)) {
        this.turnStarts.delete(key);
        return true;
      }
      if (terminal?.historical === true) {
        const existingJournalTurn = await this.workLogStore.getTurn(identity);
        if (sameHistoricalUsage(existingJournalTurn, usageResult)
          && (!legacyProbe || existingJournalTurn?.operationKind === "context-measurement")) {
          this.turnStarts.delete(key);
          return true;
        }
      }
      const accountingThread = await this.accountingThread(thread, {
        localOnly: localOnlyAccounting,
      });
      const parentTurnId = accountingThread.isSubagent
        ? await this.subagentParentTurnId(thread, accountingThread)
        : "";
      const provisional = authoritativeStatus && !usageResult.terminal;
      const turnStart = this.turnStarts.get(key);
      const baselineDiff = turnStart?.gitBaseline
        ? await this.taskGitDiff(
          turnStart.gitBaseline,
          this.dataDir,
          `terminal-audit-${identity.turnId}`,
        ) ?? ""
        : "";
      const turnDiff = baselineDiff || usageResult.diff || "";
      // Service usage is projected without a user message. Route it before the
      // ordinary historical/subagent decision, which belongs to terminal flow.
      if (usageResult.serviceUsageKind && !dedicatedCompaction
        && !accountingThread.isSubagent && terminal?.historical !== true) {
        const serviceChangedFiles = [...new Set((usageResult.changedFiles ?? []).flatMap((file) => {
          const value = String(file ?? "").trim();
          const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(project.path, value);
          const relative = path.relative(project.path, absolute);
          if (!value || !relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
          return [relative.replaceAll(path.sep, "/")];
        }))];
        await this.#projectHistorical({
          identity,
          thread,
          project,
          terminal,
          usageResult,
          dedicatedCompaction,
          accountingThread,
          parentTurnId,
          resolvedStatus,
          resolvedCompletedAt,
          provisional,
          changedFiles: serviceChangedFiles,
          turnDiff,
          gitBaseline: turnStart?.gitBaseline ?? null,
          onProjectionDeferred,
        });
        this.turnStarts.delete(key);
        this.logger.log(`Accounted service Codex turn ${identity.turnId} to thread ${accountingThread.threadId}`);
        return true;
      }
      const changedFiles = [...new Set((usageResult.changedFiles ?? []).flatMap((file) => {
        const value = String(file ?? "").trim();
        const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(project.path, value);
        const relative = path.relative(project.path, absolute);
        if (!value || !relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
        return [relative.replaceAll(path.sep, "/")];
      }))];
      if (dedicatedCompaction || legacyProbe || accountingThread.isSubagent || terminal?.historical === true) {
        await this.#projectHistorical({
          identity,
          thread,
          project,
          terminal,
          usageResult,
          dedicatedCompaction,
          legacyProbe,
          accountingThread,
          parentTurnId,
          resolvedStatus,
          resolvedCompletedAt,
          provisional,
          changedFiles,
          turnDiff,
          gitBaseline: turnStart?.gitBaseline ?? null,
          onProjectionDeferred,
        });
        this.turnStarts.delete(key);
        this.logger.log(
          `Accounted historical Codex turn ${identity.turnId} to thread ${accountingThread.threadId}`,
        );
        return true;
      }
      if (alreadyDelivered) {
        await this.#reconcileDelivered({
          identity,
          thread,
          project,
          usageResult,
          legacyProbe,
          resolvedStatus,
          resolvedCompletedAt,
          changedFiles,
          turnDiff,
          gitBaseline: turnStart?.gitBaseline ?? null,
          deferProjection,
          onProjectionDeferred,
        });
        this.turnStarts.delete(key);
        this.logger.log(`Reconciled delivered Codex terminal turn ${identity.turnId} (${resolvedStatus})`);
        return true;
      }
      const responseAttachments = await this.resolveTerminalAttachments({
        threadId: identity.threadId,
        startedAt: usageResult.startedAt,
        rolloutPath: thread.path,
        ...(generatedImageSources.length ? { generatedImageSources } : {}),
      }, identity.turnId);
      const completion = this.notifications.recordCompletion({
        ...identity,
        projectRoot: project.path,
        taskTitle: await this.taskTitle({ ...identity, thread }),
        chatId: this.defaultChatId(),
        status: resolvedStatus,
        provisional,
        usage: usageResult.usage,
        usageReported: usageResult.reported === true,
        imageGenerationCount: usageResult.imageGenerationCount,
        estimatedCredits: usageResult.estimatedCredits,
        estimateKind: usageResult.estimateKind,
        limitSamples: usageResult.limitSamples,
        model: usageResult.model,
        serviceTier: usageResult.serviceTier,
        startedAt: usageResult.startedAt,
        completedAt: resolvedCompletedAt,
        operationKind: legacyProbe ? "context-measurement" : "user-turn",
        clientUserMessageId: usageResult.clientUserMessageId ?? null,
        prompt: usageResult.prompt,
        finalAnswer: usageResult.finalAnswer,
        responseAttachments,
        changedFiles,
        diff: turnDiff,
        gitBaseline: turnStart?.gitBaseline ?? null,
        skillsUsed: usageResult.skillsUsed,
        mcpCalls: usageResult.mcpCalls,
        toolMetricsKnown: usageResult.toolMetricsKnown,
      });
      this.turnStarts.delete(key);
      await this.saveState();
      if (completion) {
        await this.deliverNotification(completion);
        this.logger.log(`Recovered unhooked Codex terminal turn ${identity.turnId} (${completion.status})`);
      }
      return true;
    } catch (error) {
      this.logger.error(`Cannot recover unhooked Codex turn ${identity.turnId}:`, error.message);
      throw error;
    } finally {
      this.reconciling.delete(key);
    }
  }

  async #projectHistorical({
    identity,
    project,
    terminal,
    usageResult,
    dedicatedCompaction,
    legacyProbe,
    accountingThread,
    parentTurnId,
    resolvedStatus,
    resolvedCompletedAt,
    provisional,
    changedFiles,
    turnDiff,
    gitBaseline,
    onProjectionDeferred,
  }) {
    const contextProbe = usageResult.serviceUsageKind === "context-probe"
      && isCodexContextProbeClientId(usageResult.clientUserMessageId);
    const finalAnswer = contextProbe ? "" : String(usageResult.finalAnswer ?? "").trim();
    const journal = await this.projectTurn({
      ...identity,
      taskThreadId: accountingThread.threadId,
      parentThreadId: accountingThread.parentThreadId,
      parentTurnId,
      aggregateOnly: accountingThread.isSubagent,
      projectRoot: project.path,
      taskTitle: await this.taskTitle({
        provider: "codex",
        threadId: accountingThread.threadId,
        thread: accountingThread.thread,
      }),
      status: resolvedStatus,
      provisional,
      usage: usageResult.usage,
      usageReported: usageResult.reported === true,
      imageGenerationCount: usageResult.imageGenerationCount,
      estimatedCredits: usageResult.estimatedCredits,
      estimateKind: usageResult.estimateKind,
      operationKind: dedicatedCompaction ? "context-compaction"
        : legacyProbe ? "context-measurement" : "user-turn",
      clientUserMessageId: usageResult.clientUserMessageId ?? null,
      limitSamples: usageResult.limitSamples,
      resolveAccount: terminal?.historical !== true,
      model: usageResult.model,
      serviceTier: usageResult.serviceTier,
      startedAt: usageResult.startedAt,
      completedAt: resolvedCompletedAt,
      prompt: usageResult.prompt,
      changedFiles,
      diff: turnDiff,
      gitBaseline,
      skillsUsed: usageResult.skillsUsed,
      mcpCalls: usageResult.mcpCalls,
      toolMetricsKnown: usageResult.toolMetricsKnown,
      serviceUsageKind: usageResult.serviceUsageKind
        || (dedicatedCompaction ? "context-compaction" : ""),
      ...(usageResult.serviceUsageKind ? { accountAttribution: "unknown", resolveAccount: false } : {}),
      ...(contextProbe ? { operationKind: "context-measurement" } : {}),
      message: null,
    }, {
      title: dedicatedCompaction ? "Свёртка контекста"
        : legacyProbe ? "Измерение контекста" : conciseTurnTitle(finalAnswer, resolvedStatus),
      body: legacyProbe ? "" : finalAnswer,
      deferProjection: true,
      ...(contextProbe ? { title: "Измерение контекста", body: "" } : {}),
    });
    if (journal?.projectionDeferred === true) onProjectionDeferred?.();
    if (journal?.projectionError) {
      this.logger.error(
        `Journal historical projection deferred for turn ${identity.turnId}: ${journal.projectionError}`,
      );
    }
  }

  async #reconcileDelivered({
    identity,
    thread,
    project,
    usageResult,
    legacyProbe,
    resolvedStatus,
    resolvedCompletedAt,
    changedFiles,
    turnDiff,
    gitBaseline,
    deferProjection,
    onProjectionDeferred,
  }) {
    const registeredMessage = this.notifications.takePendingMessage(identity);
    const journalTurn = await this.workLogStore.getTurn(identity);
    const correctedBody = usageResult.finalAnswer
      || registeredMessage?.text
      || (journalTurn?.provisional ? this.fallbackMessage(resolvedStatus) : "");
    const correctedTitle = correctedBody
      ? registeredMessage?.title || conciseTurnTitle(correctedBody, resolvedStatus)
      : "";
    const journal = await this.projectTurn({
      ...identity,
      projectRoot: project.path,
      taskTitle: await this.taskTitle({ ...identity, thread }),
      status: resolvedStatus,
      usage: usageResult.usage,
      usageReported: usageResult.reported === true,
      estimatedCredits: usageResult.estimatedCredits,
      estimateKind: usageResult.estimateKind,
      limitSamples: usageResult.limitSamples,
      model: usageResult.model,
      serviceTier: usageResult.serviceTier,
      startedAt: usageResult.startedAt,
      completedAt: resolvedCompletedAt,
      operationKind: legacyProbe ? "context-measurement" : "user-turn",
      clientUserMessageId: usageResult.clientUserMessageId ?? null,
      prompt: usageResult.prompt,
      changedFiles,
      diff: turnDiff,
      gitBaseline,
      skillsUsed: usageResult.skillsUsed,
      mcpCalls: usageResult.mcpCalls,
      toolMetricsKnown: usageResult.toolMetricsKnown,
      message: null,
    }, {
      title: correctedTitle,
      body: correctedBody,
      deferProjection,
    });
    if (journal?.projectionDeferred) onProjectionDeferred?.();
    if (journal?.projectionError) {
      this.logger.error(
        `Journal correction deferred for turn ${identity.turnId}: ${journal.projectionError}`,
      );
    }
    if (correctedBody && !legacyProbe) {
      const task = {
        ...identity,
        projectRoot: project.path,
        operationKind: "user-turn",
      };
      this.rememberLastMessage(task, correctedBody, { updatedAt: resolvedCompletedAt });
      this.rememberSeenTurn(task, identity.turnId);
    }
    if (registeredMessage || correctedBody) await this.saveState();
  }
}
