import { turnEndKey } from "./turn-end-notifications.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";
import { normalizeServiceTier, normalizeTokenUsage } from "../domain/token-usage.mjs";

const DEFAULT_PROJECTION_RETRY_BASE_MS = 250;
const DEFAULT_PROJECTION_RETRY_MAX_MS = 30_000;
const DEFAULT_PROJECTION_RETRY_LIMIT = 6;

export function transientTurnProjectionFailure(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  const primarySqliteCode = Number(error?.errcode) & 0xff;
  return primarySqliteCode === 5
    || primarySqliteCode === 6
    || /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u.test(code)
    || code === "JOURNAL_REVISION_CONFLICT"
    || code === "JOURNAL_PROJECTION_CONFLICT";
}

function projectionRecordMatches(status, completion, body) {
  const record = status?.record;
  if (!record || status.current !== true) return false;
  return String(record.provider ?? "").trim().toLowerCase() === String(completion.provider ?? "").trim().toLowerCase()
    && String(record.threadId ?? "") === String(completion.threadId ?? "")
    && String(record.turnId ?? "") === String(completion.turnId ?? "")
    && record.usageReported === (completion.usageReported === true)
    && JSON.stringify(normalizeTokenUsage(record.usage)) === JSON.stringify(normalizeTokenUsage(completion.usage))
    && String(record.status ?? "") === String(completion.status ?? "")
    && String(record.model ?? "").trim().toLowerCase() === String(completion.model ?? "").trim().toLowerCase()
    && normalizeServiceTier(record.serviceTier) === normalizeServiceTier(completion.serviceTier)
    && String(record.startedAt ?? "") === String(completion.startedAt ?? "")
    && String(record.completedAt ?? "") === String(completion.completedAt ?? "")
    && String(record.body ?? "").trim() === String(body ?? "").trim();
}

function existingProjectionRecordMatches(status, completion, body) {
  return projectionRecordMatches({ ...status, current: true }, completion, body);
}

function unconfirmedProjectionError(result) {
  const reason = String(result?.projectionError ?? result?.reason ?? "unconfirmed");
  const error = new Error(`journal projection failed: ${reason}`);
  if (result?.conflict || result?.projectionDeferred || reason === "stale-journal-revision") {
    error.code = "JOURNAL_REVISION_CONFLICT";
  }
  return error;
}

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
  #projectionRetryTimer = null;
  #projectionRecoveryEnabled = false;
  #projectionDrain = null;

  constructor({
    notifications,
    terminalCommits = null,
    taskRuns,
    persistHistory = async () => {},
    projectTurn,
    flushTurnProjections = null,
    ensureTurnUsageFact = null,
    readTurnProjection = null,
    finalizeRunDelivery = null,
    rememberLastMessage,
    rememberSeenTurn,
    saveState,
    logger = console,
    now = Date.now,
    commandTrace = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    projectionRetryBaseMs = DEFAULT_PROJECTION_RETRY_BASE_MS,
    projectionRetryMaxMs = DEFAULT_PROJECTION_RETRY_MAX_MS,
    projectionRetryLimit = DEFAULT_PROJECTION_RETRY_LIMIT,
  }) {
    this.notifications = notifications;
    this.legacy = new LegacyTurnEndProjectionAdapter(notifications);
    this.terminalCommits = terminalCommits;
    this.taskRuns = taskRuns;
    this.persistHistory = persistHistory;
    this.projectTurn = projectTurn;
    this.flushTurnProjections = flushTurnProjections;
    this.ensureTurnUsageFact = ensureTurnUsageFact;
    this.readTurnProjection = readTurnProjection;
    this.finalizeRunDelivery = finalizeRunDelivery;
    this.rememberLastMessage = rememberLastMessage;
    this.rememberSeenTurn = rememberSeenTurn;
    this.saveState = saveState;
    this.logger = logger;
    this.now = now;
    this.commandTrace = commandTrace;
    this.sleep = sleep;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.projectionRetryBaseMs = Math.max(1, Number(projectionRetryBaseMs) || DEFAULT_PROJECTION_RETRY_BASE_MS);
    this.projectionRetryMaxMs = Math.max(this.projectionRetryBaseMs,
      Number(projectionRetryMaxMs) || DEFAULT_PROJECTION_RETRY_MAX_MS);
    this.projectionRetryLimit = Math.max(1, Math.floor(Number(projectionRetryLimit) || DEFAULT_PROJECTION_RETRY_LIMIT));
    this.delivering = new Set();
    this.recoveredOutbox = false;
  }

  #measure(stage, item, operation, metadata = {}) {
    const completion = item?.payload?.completion ?? item ?? {};
    const history = item?.payload?.history ?? {};
    const commandId = String(history.clientUserMessageId ?? completion.clientUserMessageId ?? "").trim()
      || `terminal:${completion.provider ?? "hub"}:${completion.threadId ?? "recovery"}:${completion.turnId ?? "outbox"}`;
    return this.commandTrace?.measureBestEffort ? this.commandTrace.measureBestEffort({
      commandId, stage, transport: "server-runtime",
      metadata: {
        provider: item?.provider ?? completion.provider,
        threadId: item?.threadId ?? completion.threadId,
        turnId: item?.turnId ?? completion.turnId,
        streamId: completion.streamId,
        terminalRevision: item?.terminalRevision,
        outboxId: item?.id,
        ...metadata,
      },
    }, operation) : operation();
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
      operationKind: completion.operationKind,
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
      const journal = await this.#measure("terminal-journal-project", completion, () => this.projectTurn(completion, {
        title: notificationTitle,
        body: notificationBody,
      }));
      this.rememberCompletion(completion, notificationBody);
      if (journal?.projectionError) {
        this.logger.error(
          `Journal projection deferred for turn ${completion.turnId}: ${journal.projectionError}`,
        );
      }
      this.notifications.markDelivered(key);
      await this.#measure("terminal-state-save", completion, () => this.saveState());
      return true;
    } finally {
      this.delivering.delete(key);
    }
  }

  async reconcileResponseAttachments(identity, options = {}) {
    if (!this.terminalCommits?.enrichResponseAttachments) return { enriched: false };
    const result = await this.terminalCommits.enrichResponseAttachments(identity, options);
    if (!result?.enriched) return result;
    await this.deliverOutbox(result.outbox);
    return { ...result, delivered: true };
  }

  async deliverOutbox(item, { waitForProjection = null, projectionOnly = false } = {}) {
    if (!item || !this.terminalCommits) return false;
    const key = turnEndKey(item);
    const deliveryKey = `${key}\0${item.terminalRevision}`;
    if (this.delivering.has(deliveryKey)) return false;
    this.delivering.add(deliveryKey);
    let claimed = null;
    try {
      if ((item.channels?.projection?.state ?? item.state) === "pending") {
        claimed = await this.#measure("terminal-claim", item, () => this.terminalCommits.claim(item));
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
          let projection = this.readTurnProjection
            ? await this.#measure("terminal-projection-readback", claimed, () => this.readTurnProjection(completion))
            : null;
          if (!projectionRecordMatches(projection, completion, notificationBody)) {
            await this.#measure("terminal-history-persist", claimed, async () => {
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
            });
            // The exact final is already durable and readable by task-history.
            // Publish its existing last-message projection before accounting or
            // the global journal index can stall. This is not an outbox ACK:
            // all projection checks below still own acknowledgement/recovery.
            if (typeof this.terminalCommits.get === "function") {
              const latest = await this.#measure("terminal-revision-read", claimed,
                () => this.terminalCommits.get(claimed));
              if (latest?.terminalRevision !== terminalRevision) return false;
            }
            this.rememberCompletion(completion, notificationBody);
            const matchingRecord = existingProjectionRecordMatches(projection, completion, notificationBody);
            const projectedCompletion = claimed.attempts > 1
              ? { ...completion, resolveAccount: false }
              : completion;
            if (!matchingRecord) {
              await this.#measure("terminal-journal-project", claimed, async () => {
                const journal = await this.projectTurn(projectedCompletion, {
                  title: notificationTitle,
                  body: notificationBody,
                  ...(this.flushTurnProjections ? { deferProjection: true } : {}),
                });
                if (journal?.projectionError) throw unconfirmedProjectionError(journal);
              });
            }
            if (this.ensureTurnUsageFact) {
              await this.#measure("terminal-usage-fact", claimed,
                () => this.ensureTurnUsageFact(projectedCompletion));
            }
            let flushFailure = null;
            if (waitForProjection) {
              const batchResult = await this.#measure("terminal-projection-batch-wait", claimed,
                () => waitForProjection(projectedCompletion));
              flushFailure = batchResult?.error ?? null;
            } else if (this.flushTurnProjections) {
              const flushed = await this.#measure("terminal-projection-flush", claimed,
                () => this.flushTurnProjections([projectedCompletion]));
              if (!flushed || (flushed.projected !== true && flushed.reason !== "unchanged")
                || flushed.projectionError) flushFailure = unconfirmedProjectionError(flushed);
            }
            projection = this.readTurnProjection
              ? await this.#measure("terminal-projection-readback", claimed, () => this.readTurnProjection(projectedCompletion))
              : null;
            if (this.readTurnProjection && !projectionRecordMatches(projection, projectedCompletion, notificationBody)) {
              if (flushFailure) throw flushFailure;
              const readbackError = new Error(`terminal projection readback is incomplete for ${completion.turnId}`);
              readbackError.code = projection?.record ? "JOURNAL_REVISION_CONFLICT" : "TERMINAL_PROJECTION_INCOMPLETE";
              throw readbackError;
            }
            if (!this.readTurnProjection && flushFailure) throw flushFailure;
          }
          if (typeof this.terminalCommits.get === "function") {
            const latest = await this.#measure("terminal-revision-read", claimed, () => this.terminalCommits.get(claimed));
            if (latest?.terminalRevision !== terminalRevision) return false;
          }
          this.rememberCompletion(completion, notificationBody);
          this.legacy.markProjected(completion);
          await this.#measure("terminal-state-save", completion, () => this.saveState());
          const acknowledged = await this.#measure("terminal-outbox-ack", claimed, () => this.terminalCommits.acknowledge(claimed));
          if (waitForProjection && !acknowledged) return false;
          const commandId = String(history.clientUserMessageId ?? completion.clientUserMessageId ?? "").trim();
          if (!projectionOnly) {
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
      }
      const telegram = projectionOnly ? null
        : await this.#measure("terminal-telegram-intent", claimed ?? item,
          () => this.#materializeTelegramIntent(claimed ?? item));
      return { projection: Boolean(claimed), telegram };
    } catch (error) {
      if (claimed) {
        await this.#measure("terminal-outbox-retry", claimed, () => this.terminalCommits.retry(claimed, error)).then(() => {
          if (transientTurnProjectionFailure(error)) this.#scheduleProjectionRetry(claimed.attempts);
        }).catch((retryError) => {
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

  startProjectionRecovery() {
    this.#projectionRecoveryEnabled = true;
    this.#scheduleProjectionRetry(0, 0);
  }

  stopProjectionRecovery() {
    this.#projectionRecoveryEnabled = false;
    if (this.#projectionRetryTimer !== null) this.clearTimer(this.#projectionRetryTimer);
    this.#projectionRetryTimer = null;
  }

  #scheduleProjectionRetry(attempts = 1, explicitDelay = null) {
    if (!this.#projectionRecoveryEnabled || attempts >= this.projectionRetryLimit) return false;
    const delay = explicitDelay == null
      ? Math.min(this.projectionRetryMaxMs, this.projectionRetryBaseMs * (2 ** Math.max(0, attempts - 1)))
      : Math.max(0, Number(explicitDelay) || 0);
    if (this.#projectionRetryTimer !== null) return false;
    this.#projectionRetryTimer = this.setTimer(() => {
      this.#projectionRetryTimer = null;
      void this.retryPendingProjections().catch((error) => {
        this.logger.error("Cannot retry terminal projections:", error.message);
      });
    }, delay);
    return true;
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

  async retryPendingProjections({ recoverProjecting = false } = {}) {
    if (this.#projectionDrain) return this.#projectionDrain;
    const drain = this.#retryPendingProjections({ recoverProjecting })
      .finally(() => {
        if (this.#projectionDrain === drain) this.#projectionDrain = null;
        if (this.#projectionRecoveryEnabled) {
          this.#scheduleProjectionRetry(0, this.projectionRetryMaxMs);
        }
      });
    this.#projectionDrain = drain;
    return drain;
  }

  async #retryPendingProjections({ recoverProjecting }) {
    if (this.terminalCommits && recoverProjecting && !this.recoveredOutbox) {
      await this.#measure("terminal-outbox-recover", null, () => this.terminalCommits.recoverProjecting());
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
      const delivery = this.terminalCommits
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
    if (!this.terminalCommits) return { processed: 0 };
    const pending = [...new Map([
      ...migratedOutbox,
      ...await this.#measure("terminal-outbox-list", null,
        () => this.terminalCommits.pendingProjections({ limit: 100 })),
    ].map((item) => [`${turnEndKey(item)}\0${item.terminalRevision}`, item])).values()];
    if (this.flushTurnProjections) {
      for (let offset = 0; offset < pending.length; offset += 16) {
        await this.#deliverProjectionBatch(pending.slice(offset, offset + 16));
      }
      return { processed: pending.length };
    }
    for (const item of pending) {
      await this.deliverOutbox(item, { projectionOnly: true }).catch((error) => {
        this.logger.error(
          `Cannot project terminal revision ${item.terminalRevision} for ${item.turnId}:`,
          error.message,
        );
      });
    }
    return { processed: pending.length };
  }

  async retryPendingTelegram() {
    if (!this.terminalCommits) return { processed: 0 };
    const pending = await this.#measure("terminal-outbox-list", null, () => this.terminalCommits.pending());
    let processed = 0;
    for (const item of pending) {
      if (!["intent", "uncertain"].includes(item.channels?.telegram?.state)) continue;
      await this.#measure("terminal-telegram-intent", item, () => this.#materializeTelegramIntent(item));
      processed += 1;
    }
    return { processed };
  }

  async retryPending({ recoverProjecting = true, includeTelegram = true } = {}) {
    const projection = await this.retryPendingProjections({ recoverProjecting });
    const telegram = includeTelegram ? await this.retryPendingTelegram() : { processed: 0 };
    return { projection, telegram };
  }

  async #deliverProjectionBatch(items) {
    const prepared = [];
    const deliveries = [];
    for (const item of items) {
      let arrive;
      const staged = new Promise((resolve) => { arrive = resolve; });
      const delivery = this.deliverOutbox(item, {
        projectionOnly: true,
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
        const projection = await this.#measure("terminal-projection-batch-flush", prepared[0].completion,
          () => this.flushTurnProjections(prepared.map((entry) => entry.completion)), { batchSize: prepared.length });
        if (!projection || (projection.projected !== true && projection.reason !== "unchanged")
          || projection.conflict || projection.projectionDeferred || projection.projectionError) {
          throw unconfirmedProjectionError(projection);
        }
      } catch (error) {
        projectionError = error;
      }
    }
    for (const entry of prepared) {
      entry.resolve(projectionError ? { error: projectionError } : { projected: true });
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
