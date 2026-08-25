import { turnEndKey } from "./turn-end-notifications.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";

export function fallbackTurnEndMessage(status) {
  if (status === "completed") return "Ход завершён.";
  if (status === "aborted") return "Ход остановлен пользователем.";
  if (status === "cancelled") return "Ход отменён.";
  if (status === "failed") return "Ход завершился с ошибкой.";
  return `Ход завершён со статусом ${status}.`;
}

/**
 * Migration adapter for runtime snapshots written before TURN-001.
 *
 * Removal condition: every producer commits through TerminalTurnCommitService
 * and one supported runtime upgrade has drained all legacy completion entries.
 * It must never decide terminal identity or suppress a durable outbox retry.
 */
export class LegacyTurnEndProjectionAdapter {
  constructor(notifications) {
    this.notifications = notifications;
  }

  values() {
    return this.notifications?.values?.() ?? [];
  }

  completion(identity) {
    return this.notifications?.get?.(identity) ?? null;
  }

  markProjected(identity) {
    this.notifications?.markDelivered?.(identity);
  }
}

export class TurnEndDeliveryService {
  constructor({
    notifications,
    terminalCommits = null,
    taskRuns,
    persistHistory = async () => {},
    projectTurn,
    finalizeRunDelivery = null,
    rememberLastMessage,
    rememberSeenTurn,
    saveState,
    logger = console,
    now = Date.now,
    commandTrace = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.notifications = notifications;
    this.legacy = new LegacyTurnEndProjectionAdapter(notifications);
    this.terminalCommits = terminalCommits;
    this.taskRuns = taskRuns;
    this.persistHistory = persistHistory;
    this.projectTurn = projectTurn;
    this.finalizeRunDelivery = finalizeRunDelivery;
    this.rememberLastMessage = rememberLastMessage;
    this.rememberSeenTurn = rememberSeenTurn;
    this.saveState = saveState;
    this.logger = logger;
    this.now = now;
    this.commandTrace = commandTrace;
    this.sleep = sleep;
    this.delivering = new Set();
    this.recoveredOutbox = false;
  }

  rememberCompletion(completion, body = "") {
    if (!completion || completion.aggregateOnly) return false;
    const notificationBody = String(body || completion.finalAnswer
      || completion.message?.text || fallbackTurnEndMessage(completion.status)).trim();
    if (!notificationBody) return false;
    this.rememberLastMessage({
      streamId: completion.streamId ?? null,
      provider: completion.provider,
      projectRoot: completion.projectRoot,
      threadId: completion.threadId,
      turnId: completion.turnId,
      startedAt: completion.startedAt,
    }, notificationBody, {
      updatedAt: completion.completedAt,
      terminalRevision: completion.terminalRevision,
    });
    if (completion.turnId) this.rememberSeenTurn(completion, completion.turnId);
    return true;
  }

  async commit(completion, options = {}) {
    if (!this.terminalCommits) return { terminal: null, outbox: null, completion };
    return this.terminalCommits.commit(completion, options);
  }

  async deliver(completion, { run = null } = {}) {
    if (!completion) return false;
    if (this.terminalCommits) {
      const committed = await this.commit(completion, { run });
      return this.deliverOutbox(committed.outbox);
    }
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
      this.rememberCompletion(completion, notificationBody);
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

  async deliverOutbox(item) {
    if (!item || !this.terminalCommits) return false;
    const key = turnEndKey(item);
    const deliveryKey = `${key}\0${item.terminalRevision}`;
    if (this.delivering.has(deliveryKey)) return false;
    this.delivering.add(deliveryKey);
    let claimed = null;
    try {
      if ((item.channels?.projection?.state ?? item.state) === "pending") {
        claimed = await this.terminalCommits.claim(item);
        if (claimed) {
          const terminalRevision = claimed.terminalRevision;
          const completion = {
            ...(claimed.payload?.completion ?? {}),
            terminalRevision,
          };
          const history = {
            ...(claimed.payload?.history ?? {}),
            terminalRevision,
          };
          const notificationBody = completion.finalAnswer
            || completion.message?.text
            || fallbackTurnEndMessage(completion.status);
          const notificationTitle = completion.message?.title
            || conciseTurnTitle(notificationBody, completion.status);
          const historyProjection = await this.persistHistory(history, {
            answer: notificationBody,
            status: completion.status,
            active: false,
            turnId: completion.turnId,
            terminalRevision,
          });
          if (historyProjection?.failed) {
            throw new Error(`history projection failed: ${historyProjection.error || "unknown error"}`);
          }
          const journal = await this.projectTurn(completion, {
            title: notificationTitle,
            body: notificationBody,
          });
          this.rememberCompletion(completion, notificationBody);
          if (journal?.projectionError) {
            throw new Error(`journal projection failed: ${journal.projectionError}`);
          }
          this.legacy.markProjected(completion);
          await this.saveState();
          await this.terminalCommits.acknowledge(claimed);
          const commandId = String(history.clientUserMessageId ?? completion.clientUserMessageId ?? "").trim();
          this.commandTrace?.recordBestEffort?.({
            commandId,
            stage: "projection-visible",
            outcome: "succeeded",
            transport: String(history.clientSource ?? "server-runtime").trim().toLowerCase() || "server-runtime",
            metadata: {
              provider: completion.provider,
              threadId: completion.threadId,
              turnId: completion.turnId,
              terminalRevision,
              surface: "server-read-model",
            },
          });
        }
      }
      const telegram = await this.#materializeTelegramIntent(claimed ?? item);
      return { projection: Boolean(claimed), telegram };
    } catch (error) {
      if (claimed) await this.terminalCommits.retry(claimed, error).catch(() => {});
      throw error;
    } finally {
      this.delivering.delete(deliveryKey);
    }
  }

  async #materializeTelegramIntent(item) {
    const channel = item?.channels?.telegram;
    if (!channel || !["intent", "uncertain"].includes(channel.state)) return null;
    if (!channel.intent || typeof this.finalizeRunDelivery !== "function") {
      throw new Error("Telegram terminal intent cannot be materialized");
    }
    const intent = channel.intent;
    return this.finalizeRunDelivery({ ...intent.run }, {
      answer: intent.answer,
      message: intent.message,
      speechText: intent.speechText,
      forceSpeechButton: intent.forceSpeechButton === true,
      deliver: true,
      silent: intent.silent === true,
      complete: false,
      refreshDiff: false,
      description: intent.description,
      terminalIntent: {
        id: intent.id,
        provider: item.provider,
        threadId: item.threadId,
        turnId: item.turnId,
        terminalRevision: item.terminalRevision,
        channel: "telegram",
        supersedeKey: `${item.provider}\0${item.threadId}\0${item.turnId}\0telegram`,
      },
    });
  }

  async retryPending() {
    if (this.terminalCommits && !this.recoveredOutbox) {
      await this.terminalCommits.recoverProjecting();
      this.recoveredOutbox = true;
    }
    for (const completion of this.legacy.values()) {
      const run = this.taskRuns.forEvent({
        provider: completion.provider,
        threadId: completion.threadId,
        turnId: completion.turnId,
        allowThreadFallback: true,
      });
      if (run && ["running", "finishing"].includes(run.status)) continue;
      await this.deliver(completion, { run }).catch((error) => {
        this.logger.error(
          `Cannot deliver pending turn-end notification ${completion.turnId}:`,
          error.message,
        );
      });
    }
    if (!this.terminalCommits) return;
    for (const item of await this.terminalCommits.pending()) {
      await this.deliverOutbox(item).catch((error) => {
        this.logger.error(
          `Cannot project terminal revision ${item.terminalRevision} for ${item.turnId}:`,
          error.message,
        );
      });
    }
  }

  async waitForCompletion(identity, timeoutMs = 2_000) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const terminal = await this.terminalCommits?.get(identity);
      if (terminal) return {
        ...(terminal.payload?.completion ?? {}),
        terminalRevision: terminal.terminalRevision,
      };
      const completion = this.legacy.completion(identity);
      if (completion?.usageReported || Number(completion?.estimatedCredits) > 0) return completion;
      await this.sleep(50);
    }
    const terminal = await this.terminalCommits?.get(identity);
    return terminal ? {
      ...(terminal.payload?.completion ?? {}),
      terminalRevision: terminal.terminalRevision,
    } : this.legacy.completion(identity);
  }
}
