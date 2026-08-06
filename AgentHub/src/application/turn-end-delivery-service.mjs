import { turnEndKey } from "./turn-end-notifications.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";

export function fallbackTurnEndMessage(status) {
  if (status === "completed") return "Ход завершён.";
  if (status === "aborted") return "Ход остановлен пользователем.";
  if (status === "cancelled") return "Ход отменён.";
  if (status === "failed") return "Ход завершился с ошибкой.";
  return `Ход завершён со статусом ${status}.`;
}

export class TurnEndDeliveryService {
  constructor({
    notifications,
    taskRuns,
    projectTurn,
    rememberLastMessage,
    rememberSeenTurn,
    saveState,
    logger = console,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.notifications = notifications;
    this.taskRuns = taskRuns;
    this.projectTurn = projectTurn;
    this.rememberLastMessage = rememberLastMessage;
    this.rememberSeenTurn = rememberSeenTurn;
    this.saveState = saveState;
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;
    this.delivering = new Set();
  }

  async deliver(completion) {
    if (!completion) return false;
    const key = turnEndKey(completion);
    if (this.notifications.hasDelivered(key) || this.delivering.has(key)) return false;
    this.delivering.add(key);
    try {
      const notificationBody = completion.finalAnswer
        || completion.message?.text
        || fallbackTurnEndMessage(completion.status);
      const notificationTitle = completion.message?.title
        || conciseTurnTitle(notificationBody, completion.status);
      const journal = await this.projectTurn(completion, {
        title: notificationTitle,
        body: notificationBody,
      });
      if (!completion.aggregateOnly) {
        this.rememberLastMessage({
          streamId: completion.streamId ?? null,
          provider: completion.provider,
          projectRoot: completion.projectRoot,
          threadId: completion.threadId,
          turnId: completion.turnId,
        }, notificationBody);
        if (completion.turnId) this.rememberSeenTurn(completion, completion.turnId);
      }
      if (journal?.projectionError) {
        this.logger.error(
          `Journal projection deferred for turn ${completion.turnId}: ${journal.projectionError}`,
        );
      }
      this.notifications.markDelivered(key);
      await this.saveState();
      return true;
    } finally {
      this.delivering.delete(key);
    }
  }

  async retryPending() {
    for (const completion of this.notifications.values()) {
      const run = this.taskRuns.forEvent({
        provider: completion.provider,
        threadId: completion.threadId,
        turnId: completion.turnId,
        allowThreadFallback: true,
      });
      if (run && ["running", "finishing"].includes(run.status)) continue;
      await this.deliver(completion).catch((error) => {
        this.logger.error(
          `Cannot deliver pending turn-end notification ${completion.turnId}:`,
          error.message,
        );
      });
    }
  }

  async waitForCompletion(identity, timeoutMs = 2_000) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const completion = this.notifications.get(identity);
      if (completion?.usageReported || Number(completion?.estimatedCredits) > 0) return completion;
      await this.sleep(50);
    }
    return this.notifications.get(identity);
  }
}
