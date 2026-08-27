import { emptyTokenUsage, formatTurnTokenUsage } from "../../domain/token-usage.mjs";
import { turnEndKey } from "../../application/turn-end-notifications.mjs";
import { conciseTurnTitle } from "../../application/turn-title.mjs";

export class CodexRunFinalizer {
  constructor({
    turnStarts,
    notifications,
    discardContextCompaction,
    finalizeRunDelivery,
    refreshTaskDiff,
    runTitle,
    currentChatId,
    defaultNotificationChatId,
    changedFiles,
    saveState,
    commitTerminal,
    deliverTerminal,
    markRunCompleted,
    completeRun,
    formatUsage = formatTurnTokenUsage,
    titleForAnswer = conciseTurnTitle,
    logger = console,
  }) {
    this.turnStarts = turnStarts;
    this.notifications = notifications;
    this.discardContextCompaction = discardContextCompaction;
    this.finalizeRunDelivery = finalizeRunDelivery;
    this.refreshTaskDiff = refreshTaskDiff;
    this.runTitle = runTitle;
    this.currentChatId = currentChatId;
    this.defaultNotificationChatId = defaultNotificationChatId;
    this.changedFiles = changedFiles;
    this.saveState = saveState;
    this.commitTerminal = commitTerminal;
    this.deliverTerminal = deliverTerminal;
    this.markRunCompleted = markRunCompleted;
    this.completeRun = completeRun;
    this.formatUsage = formatUsage;
    this.titleForAnswer = titleForAnswer;
    this.logger = logger;
  }

  async finalize(run, {
    answer,
    turnId: completedTurnId = run?.turnId,
    status = "completed",
    tracker = { usage: emptyTokenUsage(), reported: false },
    forceSpeechButton = false,
    deliver,
    silent = false,
    description = "финальный ответ Codex",
  } = {}) {
    if (await this.discardContextCompaction(run, completedTurnId)) return null;
    if (!run || !completedTurnId) {
      return this.finalizeRunDelivery(run, {
        answer,
        forceSpeechButton,
        deliver,
        silent,
        description,
      });
    }
    const startKey = turnEndKey({
      provider: "codex",
      threadId: run.threadId,
      turnId: completedTurnId,
    });
    const turnStart = this.turnStarts.get(startKey);
    if (turnStart) {
      run.gitBaseline = turnStart.gitBaseline ?? run.gitBaseline;
      run.startedAt = turnStart.startedAt || run.startedAt;
      run.promptPreview = turnStart.prompt || run.promptPreview;
    }
    if (run.rolloutChangeTrackingKnown !== true) {
      await this.refreshTaskDiff(run).catch((error) => {
        this.logger.error(`Cannot capture changed files for turn ${completedTurnId}:`, error.message);
      });
    }
    const identity = {
      provider: "codex",
      threadId: run.threadId,
      turnId: completedTurnId,
    };
    const existingCompletion = this.notifications.get(identity);
    const completionInput = {
      ...identity,
      streamId: run.streamId ?? null,
      projectRoot: run.projectRoot,
      taskTitle: this.runTitle(run),
      chatId: run.chatId ?? this.currentChatId() ?? this.defaultNotificationChatId(),
      status,
      usage: tracker.usage,
      usageReported: tracker.reported === true,
      imageGenerationCount: tracker.imageGenerationCount ?? 0,
      estimatedCredits: tracker.estimatedCredits ?? 0,
      estimateKind: tracker.estimateKind ?? "",
      model: tracker.model ?? run.modelId ?? "",
      serviceTier: tracker.serviceTier ?? run.serviceTier ?? "default",
      startedAt: run.startedAt,
      prompt: run.promptPreview,
      clientUserMessageId: run.clientUserMessageId ?? null,
      userMessages: run.userMessages,
      finalAnswer: String(answer ?? "").trim(),
      changedFiles: this.changedFiles(run),
      diff: run.latestDiff ?? "",
      skillsUsed: tracker.toolMetricsKnown === true ? tracker.skillsUsed ?? [] : run.skillsUsed ?? [],
      mcpCalls: tracker.toolMetricsKnown === true ? tracker.mcpCalls ?? [] : run.mcpCalls ?? [],
      toolMetricsKnown: tracker.toolMetricsKnown === true || run.toolMetricsKnown === true,
    };
    const completion = this.notifications.recordCompletion(completionInput)
      ?? existingCompletion
      ?? completionInput;
    const resolvedTracker = {
      usage: completion.usage,
      reported: completion.usageReported,
      estimatedCredits: completion.estimatedCredits,
      model: completion.model,
      serviceTier: completion.serviceTier,
    };
    const shouldDeliver = deliver ?? (run.telegramDeliveryRequested !== false);
    const message = [answer, this.formatUsage(resolvedTracker)].filter(Boolean).join("\n\n");
    const telegramRequested = shouldDeliver && Number.isSafeInteger(completion.chatId);
    const committed = await this.commitTerminal(completion, {
      run,
      channelIntents: {
        telegram: {
          requested: telegramRequested,
          run: {
            id: run.id ?? null,
            streamId: run.streamId ?? null,
            provider: "codex",
            projectRoot: run.projectRoot,
            threadId: run.threadId,
            turnId: completedTurnId,
            taskTitle: completion.taskTitle,
            chatId: completion.chatId,
            modelId: run.modelId ?? null,
            serviceTier: run.serviceTier ?? null,
            finishedProgressMessageIds: [...(run.finishedProgressMessageIds ?? [])],
          },
          answer: String(answer ?? ""),
          message,
          speechText: String(answer ?? ""),
          forceSpeechButton,
          silent,
          description,
        },
      },
    });
    run.responseText = String(
      committed.terminal?.finalAnswer ?? completion.finalAnswer ?? answer ?? "",
    ).trim();
    run.terminalRevision = Number(committed.terminal?.terminalRevision) || null;
    await this.markRunCompleted(run);
    this.turnStarts.delete(startKey);
    await this.saveState();
    let deliveryResult = null;
    try {
      deliveryResult = await this.deliverTerminal(committed.outbox);
    } catch (error) {
      this.logger.error(
        `Terminal revision ${committed.terminal.terminalRevision} remains pending for ${completedTurnId}:`,
        error.message,
      );
    } finally {
      await this.completeRun(run);
    }
    return deliveryResult?.telegram ?? deliveryResult;
  }
}
