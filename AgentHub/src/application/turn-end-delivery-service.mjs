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
    flushTurnProjections = null,
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
    this.flushTurnProjections = flushTurnProjections;
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
    if (completion.provider === "codex"
      && completion.operationKind === "probe" && completion.contextProbe === true) return false;
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
      operationKind: completion.operationKind,
      contextProbe: completion.contextProbe,
      clientUserMessageId: completion.clientUserMessageId,
    }, notificationBody, {
      updatedAt: completion.completedAt,
      ...(Number.isSafeInteger(completion.terminalRevision) && completion.terminalRevision > 0
        ? { terminalRevision: completion.terminalRevision }
        : {}),
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

  async reclassifyContextProbe(identity, evidence) {
    if (!this.terminalCommits?.reclassifyContextProbe) return { reclassified: false };
    const result = await this.terminalCommits.reclassifyContextProbe(identity, evidence);
    if (result?.outbox) await this.deliverOutbox(result.outbox);
    return result;
  }

  async reconcileResponseAttachments(identity, options = {}) {
    if (!this.terminalCommits?.enrichResponseAttachments) return { enriched: false };
    const result = await this.terminalCommits.enrichResponseAttachments(identity, options);
    if (!result?.enriched) return result;
    await this.deliverOutbox(result.outbox);
    return { ...result, delivered: true };
  }

  async deliverOutbox(item, { waitForProjection = null } = {}) {
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
            ...(waitForProjection ? { deferProjection: true } : {}),
          });
          if (journal?.projectionError) {
            throw new Error(`journal projection failed: ${journal.projectionError}`);
          }
          if (waitForProjection) {
            await waitForProjection(completion);
            const latest = await this.terminalCommits.get(claimed);
            if (latest?.terminalRevision !== terminalRevision) return false;
          }
          this.rememberCompletion(completion, notificationBody);
          this.legacy.markProjected(completion);
          await this.saveState();
          const acknowledged = await this.terminalCommits.acknowledge(claimed);
          if (waitForProjection && !acknowledged) return false;
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
      if (claimed) {
        await this.terminalCommits.retry(claimed, error).catch((retryError) => {
          this.logger.error(
            `Cannot return terminal revision ${claimed.terminalRevision} for ${claimed.turnId} to retry:`,
            retryError,
          );
        });
      }
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
    const migratedOutbox = [];
    for (const completion of this.legacy.values()) {
      const run = this.taskRuns.forEvent({
        provider: completion.provider,
        threadId: completion.threadId,
        turnId: completion.turnId,
        allowThreadFallback: true,
      });
      if (run && ["running", "finishing"].includes(run.status)) continue;
      const delivery = this.terminalCommits && this.flushTurnProjections
        ? this.commit(completion, { run })
        : this.deliver(completion, { run });
      await delivery.then((result) => {
        const outbox = result?.outbox;
        if (outbox && ((outbox.channels?.projection?.state ?? outbox.state) === "pending"
          || ["intent", "uncertain"].includes(outbox.channels?.telegram?.state))) {
          migratedOutbox.push(outbox);
        }
      }).catch((error) => {
        this.logger.error(
          `Cannot deliver pending turn-end notification ${completion.turnId}:`,
          error.message,
        );
      });
    }
    if (!this.terminalCommits) return;
    const pending = [...new Map([
      ...migratedOutbox,
      ...await this.terminalCommits.pending(),
    ].map((item) => [`${turnEndKey(item)}\0${item.terminalRevision}`, item])).values()];
    if (this.flushTurnProjections) {
      for (let offset = 0; offset < pending.length; offset += 16) {
        await this.#deliverProjectionBatch(pending.slice(offset, offset + 16));
      }
      return;
    }
    for (const item of pending) {
      await this.deliverOutbox(item).catch((error) => {
        this.logger.error(
          `Cannot project terminal revision ${item.terminalRevision} for ${item.turnId}:`,
          error.message,
        );
      });
    }
  }

  async #deliverProjectionBatch(items) {
    const prepared = [];
    const deliveries = [];
    for (const item of items) {
      let arrive;
      const staged = new Promise((resolve) => { arrive = resolve; });
      const delivery = this.deliverOutbox(item, {
        waitForProjection: (completion) => new Promise((resolve, reject) => {
          prepared.push({ completion, resolve, reject, delivery });
          arrive();
        }),
      }).catch((error) => {
        this.logger.error(
          `Cannot project terminal revision ${item.terminalRevision} for ${item.turnId}:`,
          error.message,
        );
      }).finally(() => arrive());
      deliveries.push(delivery);
      // History and ledger writes keep their existing order. Only the shared
      // journal projection is deferred; each durable claim remains projecting.
      await staged;
    }
    let projectionError = null;
    if (prepared.length) {
      try {
        const projection = await this.flushTurnProjections(prepared.map((entry) => entry.completion));
        if (!projection || (projection.projected !== true && projection.reason !== "unchanged")
          || projection.conflict || projection.projectionDeferred || projection.projectionError) {
          throw new Error(`journal projection failed: ${projection?.projectionError || projection?.reason || "unconfirmed"}`);
        }
      } catch (error) {
        projectionError = error;
      }
    }
    for (const entry of prepared) {
      if (projectionError) entry.reject(projectionError);
      else entry.resolve();
      await entry.delivery;
    }
    await Promise.all(deliveries);
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
