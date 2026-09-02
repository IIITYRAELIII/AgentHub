import { emptyTokenUsage, formatTurnTokenUsage } from "../../domain/token-usage.mjs";
import { turnEndKey } from "../../application/turn-end-notifications.mjs";
import { conciseTurnTitle } from "../../application/turn-title.mjs";

function exactRunChangedFiles(run) {
  if (run?.rolloutChangeTrackingKnown !== true) return [];
  return [...new Set(Array.isArray(run.rolloutChangedFiles) ? run.rolloutChangedFiles : [])]
    .sort((left, right) => left.localeCompare(right));
}

function preferredResponseAnnotationReferences(primary, fallback) {
  if (Array.isArray(primary) && primary.length) return primary;
  return Array.isArray(fallback) ? fallback : [];
}

function exactTerminalCompletion(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    responseAnnotationReferences: preferredResponseAnnotationReferences(
      incoming.responseAnnotationReferences,
      existing.responseAnnotationReferences,
    ),
    responseAttachments: incoming.responseAttachments.length
      ? incoming.responseAttachments
      : existing.responseAttachments ?? [],
  };
}

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
    saveState,
    commitTerminal,
    deliverTerminal,
    markRunCompleted,
    completeRun,
    resolveTerminalAttachments = async () => [],
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
    this.saveState = saveState;
    this.commitTerminal = commitTerminal;
    this.deliverTerminal = deliverTerminal;
    this.markRunCompleted = markRunCompleted;
    this.completeRun = completeRun;
    this.resolveTerminalAttachments = resolveTerminalAttachments;
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
    const responseAttachments = await this.resolveTerminalAttachments(run, completedTurnId);
    run.responseAttachments = responseAttachments;
    const responseAnnotationReferences = preferredResponseAnnotationReferences(
      tracker.responseAnnotationReferences,
      run.responseAnnotationReferences,
    );
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
      responseAnnotationReferences,
      responseAttachments,
      changedFiles: exactRunChangedFiles(run),
      diff: run.latestDiff ?? "",
      gitBaseline: run.gitBaseline ?? null,
      skillsUsed: tracker.toolMetricsKnown === true ? tracker.skillsUsed ?? [] : run.skillsUsed ?? [],
      mcpCalls: tracker.toolMetricsKnown === true ? tracker.mcpCalls ?? [] : run.mcpCalls ?? [],
      toolMetricsKnown: tracker.toolMetricsKnown === true || run.toolMetricsKnown === true,
    };
    const completion = this.notifications.recordCompletion(completionInput)
      ?? exactTerminalCompletion(existingCompletion, completionInput);
    const visibleAnswer = String(completion.finalAnswer ?? answer ?? "").trim();
    const resolvedTracker = {
      usage: completion.usage,
      reported: completion.usageReported,
      estimatedCredits: completion.estimatedCredits,
      model: completion.model,
      serviceTier: completion.serviceTier,
    };
    const shouldDeliver = deliver ?? (run.telegramDeliveryRequested !== false);
    const message = [visibleAnswer, this.formatUsage(resolvedTracker)].filter(Boolean).join("\n\n");
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
          answer: visibleAnswer,
          message,
          speechText: visibleAnswer,
          forceSpeechButton,
          silent,
          description,
        },
      },
    });
    run.responseText = String(
      committed.terminal?.finalAnswer ?? completion.finalAnswer ?? answer ?? "",
    ).trim();
    run.responseAnnotationReferences = structuredClone(
      preferredResponseAnnotationReferences(
        completion.responseAnnotationReferences,
        run.responseAnnotationReferences,
      ),
    );
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
