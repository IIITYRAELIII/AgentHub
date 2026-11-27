import { turnEndKey } from "./turn-end-notifications.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";
import { normalizeServiceTier } from "../domain/token-usage.mjs";
import { journalAccountingCoversTerminal } from "./work-log-usage-projection.mjs";
import { terminalCompletionTime } from "../domain/turn-completion-time.mjs";

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

function projectionIdentityMatches(record, completion) {
  if (!record) return false;
  return String(record.provider ?? "").trim().toLowerCase() === String(completion.provider ?? "").trim().toLowerCase()
    && String(record.threadId ?? "") === String(completion.threadId ?? "")
    && String(record.turnId ?? "") === String(completion.turnId ?? "");
}

function preservesReportedUsage(record, completion) {
  return record?.usageReported === true && completion.usageReported !== true;
}

function projectionRecordMatches(status, completion, body) {
  const record = status?.record;
  if (status?.current !== true || !projectionIdentityMatches(record, completion)) return false;
  // The journal retains independently reported usage over an unreported input.
  // A retained journal time can cover sparse input only when no exact terminal time was recovered.
  return journalAccountingCoversTerminal(record, completion)
    && String(record.status ?? "") === String(completion.status ?? "")
    && String(record.model ?? "").trim().toLowerCase() === String(completion.model ?? "").trim().toLowerCase()
    && normalizeServiceTier(record.serviceTier) === normalizeServiceTier(completion.serviceTier)
    && String(record.startedAt ?? "") === String(completion.startedAt ?? "")
    && (completion.completedAt == null
      ? Number.isFinite(Date.parse(record.completedAt))
      : String(record.completedAt ?? "") === String(completion.completedAt))
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
  #telegramDeliveryLanes = new Map();

  constructor({
    notifications,
    terminalCommits = null,
    runLifecycleTerminals = null,
    taskRuns,
    persistHistory = async () => {},
    projectTurn,
    flushTurnProjections = null,
    ensureTurnUsageFact = null,
    readTurnProjection = null,
    recoverTurnCompletion = null,
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
    this.runLifecycleTerminals = runLifecycleTerminals;
    this.taskRuns = taskRuns;
    this.persistHistory = persistHistory;
    this.projectTurn = projectTurn;
    this.flushTurnProjections = flushTurnProjections;
    this.ensureTurnUsageFact = ensureTurnUsageFact;
    this.readTurnProjection = readTurnProjection;
    this.recoverTurnCompletion = recoverTurnCompletion;
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

  async #withTelegramDeliveryLane(identity, operation) {
    const key = turnEndKey(identity);
    const previous = this.#telegramDeliveryLanes.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.#telegramDeliveryLanes.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      if (this.#telegramDeliveryLanes.get(key) === current) this.#telegramDeliveryLanes.delete(key);
      release();
    }
  }

  withTelegramOutboxAttempt(item, operation) {
    if (!item?.intent?.terminalRevision) return operation();
    return this.#withTelegramDeliveryLane(item.intent, operation);
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
      prompt: completion.prompt,
      messageOrigin: completion.messageOrigin,
      userMessages: completion.userMessages,
      clientUserMessageId: completion.clientUserMessageId,
      status: completion.status,
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

  async correctFromExactProviderTerminal(identity, terminal) {
    const result = await this.#withTelegramDeliveryLane(identity, async () => {
      const committed = await this.terminalCommits?.correctFromExactProviderTerminal(identity, terminal);
      if (committed?.terminal?.status === terminal.status && !committed.conflict && !committed.stale) {
        const priorRunTerminal = this.runLifecycleTerminals?.get(identity);
        if (priorRunTerminal && priorRunTerminal.status !== terminal.status) {
          const runCorrection = await this.runLifecycleTerminals.correctFromExactTerminal({ ...identity, status: terminal.status }, {
            priorStatus: priorRunTerminal.status,
            priorCommittedAt: priorRunTerminal.committedAt,
          });
          if (runCorrection.current?.status !== terminal.status) {
            throw new Error(`run terminal correction did not settle for ${identity.turnId}`);
          }
        }
      }
      return committed;
    });
    if (result?.corrected) await this.deliverOutbox(result.outbox, { projectionOnly: true });
    return result;
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

  async recoverJournalCompletion(identity, { expectedCompletedAt, apply = false } = {}) {
    if (!this.recoverTurnCompletion || identity?.provider !== "codex"
      || !terminalCompletionTime(expectedCompletedAt)) return { eligible: false, applied: false };
    const evidence = await this.terminalCommits?.completionTimeEvidence(identity, { verifyTelemetry: true });
    if (!evidence?.completedAt || evidence.sourceRevision === evidence.terminalRevision) {
      return { eligible: false, applied: false };
    }
    if (apply !== true) return this.recoverTurnCompletion(evidence, { expectedCompletedAt });
    const result = await this.terminalCommits.withCurrentCompletionRevision(evidence,
      () => this.recoverTurnCompletion(evidence, { expectedCompletedAt, apply: true }));
    return result ?? { eligible: false, applied: false, reason: "stale-terminal-revision" };
  }

  async #projectionInputs(item) {
    const terminalRevision = item.terminalRevision;
    const rawCompletion = item.payload?.completion ?? {};
    const missingCodexTime = item.provider === "codex"
      && !terminalCompletionTime(rawCompletion.completedAt, rawCompletion.startedAt);
    let recoveredCompletedAt = rawCompletion.completedAt == null && terminalRevision > 1
      ? await this.terminalCommits.precedingProjectionCompletedAt?.(item)
      : null;
    if (!recoveredCompletedAt && missingCodexTime) {
      recoveredCompletedAt = (await this.terminalCommits.completionTimeEvidence?.(item))?.completedAt;
    }
    const completion = {
      ...rawCompletion,
      ...(recoveredCompletedAt ? { completedAt: recoveredCompletedAt, resolveAccount: false } : {}),
      terminalRevision,
    };
    const history = { ...(item.payload?.history ?? {}), terminalRevision };
    const body = completion.finalAnswer || completion.message?.text || fallbackTurnEndMessage(completion.status);
    return { rawCompletion, completion, history, body, recoveredCompletedAt };
  }

  async #persistTerminalHistory(history, completion, body) {
    const result = await this.persistHistory(history, {
      answer: body, status: completion.status, active: false,
      turnId: completion.turnId, terminalRevision: completion.terminalRevision, completedAt: completion.completedAt,
    });
    if (result?.failed) throw new Error(`history projection failed: ${result.error || "unknown error"}`);
  }

  async prepareStartupCommandAdmission() {
    if (!this.terminalCommits) return { reconciled: 0 };
    // Legacy entries without a message command can be migrated by the background drain.
    const legacy = this.legacy.values().filter(item => item.clientUserMessageId);
    const committed = new Set((await this.terminalCommits.committedProjectionKeys(legacy)).map(turnEndKey));
    await this.#migrateLegacyProjections(legacy.filter(item => !committed.has(turnEndKey(item))), { required: true });
    return this.terminalCommits.reconcileStartupCommands();
  }

  async deliverOutbox(item, { waitForProjection = null, projectionOnly = false, startupTraceId = null } = {}) {
    if (!item || !this.terminalCommits) return false;
    const key = turnEndKey(item);
    const deliveryKey = `${key}\0${item.terminalRevision}`;
    if (this.delivering.has(deliveryKey)) return false;
    this.delivering.add(deliveryKey);
    let claimed = null;
    const measure = (stage, input, operation) => this.#measure(stage, input, operation,
      startupTraceId ? { startupTraceId } : {});
    try {
      if ((item.channels?.projection?.state ?? item.state) === "pending") {
        claimed = await measure("terminal-claim", item, () => this.terminalCommits.claim(item));
        if (claimed) {
          const terminalRevision = claimed.terminalRevision;
          const { rawCompletion, completion, history, body: notificationBody, recoveredCompletedAt } = await this.#projectionInputs(claimed);
          const notificationTitle = completion.message?.title
            || conciseTurnTitle(notificationBody, completion.status);
          let projection = this.readTurnProjection
            ? await measure("terminal-projection-readback", claimed, () => this.readTurnProjection(completion))
            : null;
          let journalCurrent = projectionRecordMatches(projection, completion, notificationBody);
          const repairHistoryDate = recoveredCompletedAt && projectionIdentityMatches(projection?.record, completion)
            && projection.record.completedAt !== recoveredCompletedAt;
          // For a sparse terminal the journal proof alone does not cover the exact
          // history revision, even if its display and accounting are already current.
          if (!journalCurrent || rawCompletion.completedAt == null || preservesReportedUsage(projection?.record, completion)) {
            await measure("terminal-history-persist", claimed,
              () => this.#persistTerminalHistory(history, completion, notificationBody));
            // The exact final is already durable and readable by task-history.
            // Publish its existing last-message projection before accounting or
            // the global journal index can stall. This is not an outbox ACK:
            // all projection checks below still own acknowledgement/recovery.
            if (typeof this.terminalCommits.get === "function") {
              const latest = await measure("terminal-revision-read", claimed,
                () => this.terminalCommits.get(claimed));
              if (latest?.terminalRevision !== terminalRevision) return false;
            }
            this.rememberCompletion(completion, notificationBody);
            if (journalCurrent) {
              projection = await measure("terminal-projection-readback", claimed, () => this.readTurnProjection(completion));
              journalCurrent = projectionRecordMatches(projection, completion, notificationBody);
            }
          }
          if (!journalCurrent) {
            const matchingRecord = existingProjectionRecordMatches(projection, completion, notificationBody);
            const projectedCompletion = claimed.attempts > 1
              ? { ...completion, resolveAccount: false }
              : completion;
            if (!matchingRecord) {
              // Reuse only prior journal time for this exact turn, never a value
              // inferred from the current wall clock on every replay.
              const record = projection?.record;
              const journalCompletion = completion.completedAt == null
                && projectionIdentityMatches(record, completion)
                && Number.isFinite(Date.parse(record.completedAt))
                ? { ...projectedCompletion, completedAt: record.completedAt }
                : projectedCompletion;
              await measure("terminal-journal-project", claimed, async () => {
                const journal = await this.projectTurn(journalCompletion, {
                  title: notificationTitle,
                  body: notificationBody,
                  ...(this.flushTurnProjections ? { deferProjection: true } : {}),
                });
                if (journal?.projectionError) throw unconfirmedProjectionError(journal);
              });
            }
            if (this.ensureTurnUsageFact) {
              await measure("terminal-usage-fact", claimed,
                () => this.ensureTurnUsageFact(projectedCompletion));
            }
            let flushFailure = null;
            if (waitForProjection) {
              const batchResult = await measure("terminal-projection-batch-wait", claimed,
                () => waitForProjection(projectedCompletion));
              flushFailure = batchResult?.error ?? null;
            } else if (this.flushTurnProjections) {
              const flushed = await measure("terminal-projection-flush", claimed,
                () => this.flushTurnProjections([projectedCompletion]));
              if (!flushed || (flushed.projected !== true && flushed.reason !== "unchanged")
                || flushed.projectionError) flushFailure = unconfirmedProjectionError(flushed);
            }
            projection = this.readTurnProjection
              ? await measure("terminal-projection-readback", claimed, () => this.readTurnProjection(projectedCompletion))
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
            const latest = await measure("terminal-revision-read", claimed, () => this.terminalCommits.get(claimed));
            if (latest?.terminalRevision !== terminalRevision) return false;
          }
          if (repairHistoryDate) {
            // The history owner merges existing journal records. Publish the corrected date
            // again after the record and its derived projections have been verified.
            await measure("terminal-history-persist", claimed,
              () => this.#persistTerminalHistory(history, completion, notificationBody));
          }
          this.rememberCompletion(completion, notificationBody);
          this.legacy.markProjected(completion);
          await measure("terminal-state-save", completion, () => this.saveState());
          const ackIdentity = recoveredCompletedAt ? { ...claimed, resolvedCompletedAt: recoveredCompletedAt } : claimed;
          const acknowledged = await measure("terminal-outbox-ack", claimed,
            () => this.terminalCommits.acknowledge(ackIdentity));
          if ((waitForProjection || recoveredCompletedAt) && !acknowledged) return false;
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
        : await measure("terminal-telegram-intent", claimed ?? item,
          () => this.#materializeTelegramIntent(claimed ?? item));
      return { projection: Boolean(claimed), telegram };
    } catch (error) {
      if (claimed) {
        await measure("terminal-outbox-retry", claimed, () => this.terminalCommits.retry(claimed, error)).then(() => {
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
    return this.#withTelegramDeliveryLane(item, async () => {
      const channel = item?.channels?.telegram;
      if (!channel || !["intent", "uncertain"].includes(channel.state)) return null;
      const current = await this.terminalCommits.get(item);
      if (current?.terminalRevision !== item.terminalRevision) return null;
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
    });
  }

  async retryPendingProjections({ recoverProjecting = false, startupTraceId = null, signal } = {}) {
    signal?.throwIfAborted();
    if (this.#projectionDrain) {
      if (!recoverProjecting || this.recoveredOutbox) return this.#projectionDrain;
      // An ordinary timer may have started first. Restore abandoned claims once
      // its current drain settles, without racing either owner.
      await this.#projectionDrain.catch(() => {});
      return this.retryPendingProjections({ recoverProjecting, startupTraceId, signal });
    }
    const drain = this.#retryPendingProjections({ recoverProjecting, startupTraceId, signal })
      .finally(() => {
        if (this.#projectionDrain === drain) this.#projectionDrain = null;
        if (this.#projectionRecoveryEnabled) {
          this.#scheduleProjectionRetry(0, this.projectionRetryMaxMs);
        }
      });
    this.#projectionDrain = drain;
    return drain;
  }

  async #migrateLegacyProjections(completions = this.legacy.values(), { required = false, signal } = {}) {
    const migratedOutbox = [];
    for (const completion of completions) {
      signal?.throwIfAborted();
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
        if (required) throw error;
      });
    }
    return migratedOutbox;
  }

  async #retryPendingProjections({ recoverProjecting, startupTraceId, signal }) {
    const trace = startupTraceId ? { startupTraceId } : {};
    if (this.terminalCommits && recoverProjecting && !this.recoveredOutbox) {
      await this.#measure("terminal-outbox-recover", null, () => this.terminalCommits.recoverProjecting(), trace);
      this.recoveredOutbox = true;
    }
    const migrate = () => this.#migrateLegacyProjections(this.legacy.values(), { signal });
    const migratedOutbox = startupTraceId && this.commandTrace?.measureBestEffort
      ? await this.commandTrace.measureBestEffort({
        commandId: `startup:${startupTraceId}`,
        stage: "terminal-legacy-migration",
        transport: "server-runtime",
        metadata: trace,
      }, migrate)
      : await migrate();
    if (!this.terminalCommits) return { processed: 0 };
    const pending = [...new Map([
      ...migratedOutbox,
      ...await this.#measure("terminal-outbox-list", null,
        () => this.terminalCommits.pendingProjections({ limit: 100 }), trace),
    ].map((item) => [`${turnEndKey(item)}\0${item.terminalRevision}`, item])).values()];
    if (this.flushTurnProjections) {
      for (let offset = 0; offset < pending.length; offset += 16) {
        signal?.throwIfAborted();
        await this.#deliverProjectionBatch(pending.slice(offset, offset + 16), startupTraceId);
      }
      return { processed: pending.length };
    }
    for (const item of pending) {
      signal?.throwIfAborted();
      await this.deliverOutbox(item, { projectionOnly: true, startupTraceId }).catch((error) => {
        this.logger.error(
          `Cannot project terminal revision ${item.terminalRevision} for ${item.turnId}:`,
          error.message,
        );
      });
    }
    return { processed: pending.length };
  }

  async retryPendingTelegram({ startupTraceId, signal } = {}) {
    if (!this.terminalCommits) return { processed: 0 };
    const trace = startupTraceId ? { startupTraceId } : {};
    const pending = await this.#measure("terminal-outbox-list", null,
      () => this.terminalCommits.pending({ channel: "telegram" }), trace);
    let processed = 0;
    for (const item of pending) {
      signal?.throwIfAborted();
      if (!["intent", "uncertain"].includes(item.channels?.telegram?.state)) continue;
      await this.#measure("terminal-telegram-intent", item, () => this.#materializeTelegramIntent(item), trace);
      processed += 1;
    }
    return { processed };
  }

  async retryPending({ recoverProjecting = true, includeTelegram = true } = {}) {
    const projection = await this.retryPendingProjections({ recoverProjecting });
    const telegram = includeTelegram ? await this.retryPendingTelegram() : { processed: 0 };
    return { projection, telegram };
  }

  async #deliverProjectionBatch(items, startupTraceId) {
    const prepared = [];
    const deliveries = [];
    const staging = [];
    for (const [index, item] of items.entries()) {
      let arrive;
      const staged = new Promise((resolve) => { arrive = resolve; });
      const delivery = this.deliverOutbox(item, {
        projectionOnly: true,
        startupTraceId,
        waitForProjection: (completion) => new Promise((resolve, reject) => {
          prepared.push({ index, completion, resolve, reject, delivery });
          arrive();
        }),
      }).catch((error) => {
        this.logger.error(
          `Cannot project terminal revision ${item.terminalRevision} for ${item.turnId}:`,
          error.message,
        );
      }).finally(() => arrive());
      deliveries.push(delivery);
      // Each exact revision retains its history/ledger ordering. Independent
      // revisions in this already-bounded page need not await each other's IO.
      staging.push(staged);
    }
    await Promise.all(staging);
    prepared.sort((left, right) => left.index - right.index);
    let projectionError = null;
    if (prepared.length) {
      try {
        const projection = await this.#measure("terminal-projection-batch-flush", prepared[0].completion,
          () => this.flushTurnProjections(prepared.map((entry) => entry.completion)),
          { batchSize: prepared.length, ...(startupTraceId ? { startupTraceId } : {}) });
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
    }
    // Admit all persistence fences together so the existing state owner can
    // coalesce them. Each delivery still awaits its own durable save before ACK.
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
