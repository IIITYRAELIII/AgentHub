import { routeCodexFinalDelivery } from "./codex-final-delivery.mjs";
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
    persistHistory,
    projectTurn,
    markRunCompleted,
    completeRun,
    routeFinalDelivery = routeCodexFinalDelivery,
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
    this.persistHistory = persistHistory;
    this.projectTurn = projectTurn;
    this.markRunCompleted = markRunCompleted;
    this.completeRun = completeRun;
    this.routeFinalDelivery = routeFinalDelivery;
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
    const identity = {
      provider: "codex",
      threadId: run.threadId,
      turnId: completedTurnId,
    };
    const existingCompletion = this.notifications.get(identity);
    await this.persistHistory(run, {
      answer,
      status,
      active: false,
      turnId: completedTurnId,
    });
    await this.markRunCompleted(run);
    if (run.rolloutChangeTrackingKnown !== true) {
      await this.refreshTaskDiff(run).catch((error) => {
        this.logger.error(`Cannot capture changed files for turn ${completedTurnId}:`, error.message);
      });
    }
    const completion = this.notifications.recordCompletion({
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
      userMessages: run.userMessages,
      finalAnswer: String(answer ?? "").trim(),
      changedFiles: this.changedFiles(run),
      diff: run.latestDiff ?? "",
      skillsUsed: tracker.toolMetricsKnown === true ? tracker.skillsUsed ?? [] : run.skillsUsed ?? [],
      mcpCalls: tracker.toolMetricsKnown === true ? tracker.mcpCalls ?? [] : run.mcpCalls ?? [],
      toolMetricsKnown: tracker.toolMetricsKnown === true || run.toolMetricsKnown === true,
    });
    this.turnStarts.delete(startKey);
    await this.saveState();
    const resolvedTracker = completion
      ? {
        usage: completion.usage,
        reported: completion.usageReported,
        estimatedCredits: completion.estimatedCredits,
        model: completion.model,
        serviceTier: completion.serviceTier,
      }
      : tracker;
    const shouldDeliver = deliver ?? (run.telegramDeliveryRequested !== false);
    const message = [answer, this.formatUsage(resolvedTracker)].filter(Boolean).join("\n\n");
    const delivery = await this.routeFinalDelivery({
      completion,
      deliverStandard: async () => {
        if (completion) {
          await this.projectTurn(completion, {
            title: this.titleForAnswer(answer, status),
            body: answer,
          }).catch((error) => {
            this.logger.error(`Cannot update journal usage for turn ${completedTurnId}:`, error.message);
          });
        }
        const result = await this.finalizeRunDelivery(run, {
          answer,
          message,
          speechText: answer,
          forceSpeechButton,
          deliver: shouldDeliver,
          silent,
          complete: false,
          refreshDiff: false,
          description,
        });
        if (completion) {
          this.notifications.markDelivered(completion);
          await this.saveState();
        }
        return result;
      },
    });
    await this.completeRun(run);
    return delivery.result;
  }
}
