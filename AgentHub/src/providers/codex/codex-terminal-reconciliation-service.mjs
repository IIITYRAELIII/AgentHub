import path from "node:path";

import { turnEndKey } from "../../application/turn-end-notifications.mjs";
import { conciseTurnTitle } from "../../application/turn-title.mjs";
import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";
import { normalizeServiceTier, normalizeTokenUsage } from "../../domain/token-usage.mjs";

function sameHistoricalUsage(record, usageResult, contextProbe) {
  if (!record || record.provisional === true) return false;
  return record.usageReported === (usageResult.reported === true)
    && JSON.stringify(normalizeTokenUsage(record.usage)) === JSON.stringify(normalizeTokenUsage(usageResult.usage))
    && (Number(record.estimatedCredits) || 0) === (Number(usageResult.estimatedCredits) || 0)
    && String(record.estimateKind ?? "") === String(usageResult.estimateKind ?? "")
    && Math.max(0, Math.floor(Number(record.imageGenerationCount) || 0))
      === Math.max(0, Math.floor(Number(usageResult.imageGenerationCount) || 0))
    && String(record.model ?? "").trim().toLowerCase() === String(usageResult.model ?? "").trim().toLowerCase()
    && normalizeServiceTier(record.serviceTier) === normalizeServiceTier(usageResult.serviceTier)
    && (record.contextProbe === true) === contextProbe;
}

export class CodexTerminalReconciliationService {
  constructor({
    notifications,
    turnStarts,
    workLogStore,
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
    completedGraceMs = 10_000,
    now = Date.now,
    logger = console,
  }) {
    this.notifications = notifications;
    this.turnStarts = turnStarts;
    this.workLogStore = workLogStore;
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
    this.completedGraceMs = completedGraceMs;
    this.now = now;
    this.logger = logger;
    this.reconciling = new Set();
  }

  async reconcile(thread, project, terminal) {
    const terminalContextProbe = isCodexContextProbeTurn(terminal);
    if (terminalContextProbe && terminal?.historical !== true) return true;
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
    const subagentThread = Boolean(String(thread?.parentThreadId ?? "").trim());
    const alreadyDelivered = this.notifications.hasDelivered(identity);
    const pendingCompletion = this.notifications.get(identity);
    if (!subagentThread
      && pendingCompletion
      && pendingCompletion.status !== "unknown"
      && pendingCompletion.usageReported) return true;
    if (this.reconciling.has(key)) return false;
    this.reconciling.add(key);
    try {
      const usageResult = terminal?.usageResult
        ?? await this.readTurnUsage(thread.path, identity.turnId);
      const contextProbe = terminalContextProbe || isCodexContextProbeTurn(usageResult);
      if (terminal?.historical === true) {
        const existingJournalTurn = await this.workLogStore.getTurn(identity);
        if (sameHistoricalUsage(existingJournalTurn, usageResult, contextProbe)) {
          this.turnStarts.delete(key);
          return true;
        }
      }
      const accountingThread = await this.accountingThread(thread);
      const parentTurnId = accountingThread.isSubagent
        ? await this.subagentParentTurnId(thread, accountingThread)
        : "";
      const authoritativeStatus = terminal?.authoritative === true;
      if (!usageResult.terminal && !authoritativeStatus) return false;
      const resolvedStatus = usageResult.terminal
        ? (usageResult.status || terminal.status)
        : terminal.status;
      const resolvedCompletedAt = usageResult.terminal
        ? (usageResult.completedAt || terminal.completedAt)
        : terminal.completedAt;
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
      const changedFiles = [...new Set((usageResult.changedFiles ?? []).flatMap((file) => {
        const value = String(file ?? "").trim();
        const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(project.path, value);
        const relative = path.relative(project.path, absolute);
        if (!value || !relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
        return [relative.replaceAll(path.sep, "/")];
      }))];
      if (accountingThread.isSubagent || terminal?.historical === true) {
        await this.#projectHistorical({
          identity,
          thread,
          project,
          terminal,
          usageResult,
          contextProbe,
          accountingThread,
          parentTurnId,
          resolvedStatus,
          resolvedCompletedAt,
          provisional,
          changedFiles,
          turnDiff,
          gitBaseline: turnStart?.gitBaseline ?? null,
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
          resolvedStatus,
          resolvedCompletedAt,
          changedFiles,
          turnDiff,
          gitBaseline: turnStart?.gitBaseline ?? null,
        });
        this.turnStarts.delete(key);
        this.logger.log(`Reconciled delivered Codex terminal turn ${identity.turnId} (${resolvedStatus})`);
        return true;
      }
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
        model: usageResult.model,
        serviceTier: usageResult.serviceTier,
        startedAt: usageResult.startedAt,
        completedAt: resolvedCompletedAt,
        prompt: usageResult.prompt,
        finalAnswer: usageResult.finalAnswer,
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
    contextProbe,
    accountingThread,
    parentTurnId,
    resolvedStatus,
    resolvedCompletedAt,
    provisional,
    changedFiles,
    turnDiff,
    gitBaseline,
  }) {
    const finalAnswer = String(usageResult.finalAnswer ?? "").trim();
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
      contextProbe,
      resolveAccount: terminal?.historical !== true || terminal?.resolveCurrentAccount === true,
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
      message: null,
    }, {
      title: conciseTurnTitle(finalAnswer, resolvedStatus),
      body: finalAnswer,
      deferProjection: true,
    });
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
    resolvedStatus,
    resolvedCompletedAt,
    changedFiles,
    turnDiff,
    gitBaseline,
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
      message: null,
    }, {
      title: correctedTitle,
      body: correctedBody,
    });
    if (journal?.projectionError) {
      this.logger.error(
        `Journal correction deferred for turn ${identity.turnId}: ${journal.projectionError}`,
      );
    }
    if (correctedBody) {
      const task = { ...identity, projectRoot: project.path };
      this.rememberLastMessage(task, correctedBody, { updatedAt: resolvedCompletedAt });
      this.rememberSeenTurn(task, identity.turnId);
    }
    if (registeredMessage || correctedBody) await this.saveState();
  }
}
