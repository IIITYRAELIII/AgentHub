import { BackgroundJobQueue } from "./background-job-queue.mjs";

const MEDIA_KINDS = Object.freeze(["image", "voice", "forward-bundle-image"]);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

export class PersistentBackgroundJobController {
  #scheduledIds = new Set();
  #retryTimers = new Map();
  #pumpPromise = null;

  constructor({
    store,
    maxMediaJobs,
    maxSpeechJobs,
    isStopping = () => false,
    onIdle = () => {},
    sendMessage,
    media,
    forwardBundles,
    logger = console,
    Queue = BackgroundJobQueue,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    now = () => Date.now(),
    scheduleTimer = setTimeout,
    cancelTimer = clearTimeout,
    captureException = () => false,
  } = {}) {
    if (!store) throw new TypeError("store is required");
    if (typeof sendMessage !== "function") throw new TypeError("sendMessage is required");
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError("maxAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs < 0) {
      throw new TypeError("retryBaseDelayMs must be a non-negative integer");
    }
    if (!Number.isSafeInteger(retryMaxDelayMs) || retryMaxDelayMs < retryBaseDelayMs) {
      throw new TypeError("retryMaxDelayMs must not be smaller than retryBaseDelayMs");
    }
    this.store = store;
    this.maxMediaJobs = maxMediaJobs;
    this.maxSpeechJobs = maxSpeechJobs;
    this.isStopping = isStopping;
    this.onIdle = onIdle;
    this.sendMessage = sendMessage;
    this.media = media ?? {};
    this.forwardBundles = forwardBundles ?? {};
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
    this.now = now;
    this.scheduleTimer = scheduleTimer;
    this.cancelTimer = cancelTimer;
    this.captureException = captureException;
    const onChange = ({ size }) => {
      this.#requestPump();
      if (size === 0 && this.size === 0) this.onIdle();
    };
    this.mediaQueue = new Queue({ concurrency: 1, maxJobs: maxMediaJobs, onChange });
    this.speechQueue = new Queue({ concurrency: 1, maxJobs: maxSpeechJobs, onChange });
  }

  get mediaSize() {
    return this.#persistedCount("media");
  }
  get speechSize() { return this.#persistedCount("speech"); }
  get speechPending() { return this.speechQueue.pending; }
  get size() { return this.store.size; }

  #capture(error, action) {
    try {
      this.captureException(error, {
        surface: "server",
        kind: "background-job",
        component: "persistent-background-jobs",
        action,
      });
    } catch {}
  }

  #queue(kind) {
    return kind === "speech" ? this.speechQueue : this.mediaQueue;
  }

  #persistedCount(kind) {
    if (kind === "speech") return this.store.count("speech");
    return MEDIA_KINDS.reduce((count, mediaKind) => count + this.store.count(mediaKind), 0);
  }

  async #execute(item) {
    if (item.kind === "forward-bundle-image") {
      const descriptor = this.forwardBundles.imageDescriptor?.(item.payload.bundleId, item.payload.messageId);
      if (!descriptor) return;
      const imagePath = await this.media.captureImage(descriptor);
      await this.forwardBundles.completeImage(item.payload.bundleId, item.payload.messageId, imagePath);
      return;
    }
    if (item.kind === "image") {
      await this.media.analyzeImage(item.payload.message, item.payload.target);
      return;
    }
    if (item.kind === "voice") {
      await this.media.transcribeVoice(item.payload.message, item.payload.target);
      return;
    }
    if (item.kind === "speech") {
      await this.media.processSpeechRequest(item.payload.chatId, item.payload.text);
      return;
    }
    throw new Error(`unsupported background job kind: ${item.kind}`);
  }

  #retryDelay(attempts) {
    return Math.min(this.retryBaseDelayMs * (2 ** Math.max(0, attempts - 1)), this.retryMaxDelayMs);
  }

  #release(itemId) {
    const timer = this.#retryTimers.get(itemId);
    if (timer !== undefined) this.cancelTimer(timer);
    this.#retryTimers.delete(itemId);
    this.#scheduledIds.delete(itemId);
  }

  #requestPump() {
    if (this.isStopping() || this.#pumpPromise) return;
    this.#pumpPromise = Promise.resolve()
      .then(() => this.#pumpPersistedJobs())
      .catch((error) => {
        this.logger.error("Cannot schedule persistent background jobs:", error.message);
        this.#capture(error, "pump");
      })
      .finally(() => {
        this.#pumpPromise = null;
      });
  }

  #pumpPersistedJobs() {
    const fullKinds = new Set();
    for (const item of this.store.values()) {
      if (this.isStopping()) return;
      if (this.#scheduledIds.has(item.id) || fullKinds.has(item.kind)) continue;
      if (!this.#schedule(item)) fullKinds.add(item.kind);
    }
  }

  async #run(item) {
    let retryItem = null;
    try {
      if (this.isStopping()) return;
      await this.#execute(item);
      if (!this.isStopping()) await this.store.remove(item.id);
    } catch (error) {
      if (this.isStopping()) return;
      const attempts = Number.isSafeInteger(item.attempts) ? item.attempts + 1 : 1;
      if (attempts < this.maxAttempts) {
        const delayMs = this.#retryDelay(attempts);
        retryItem = await this.store.recordFailure(item.id, {
          attempts,
          nextAttemptAt: new Date(this.now() + delayMs).toISOString(),
          lastError: error?.message ?? error,
        });
        this.logger.warn(
          `Background ${item.kind} job ${item.id} failed; retry ${attempts + 1}/${this.maxAttempts}`
            + ` in ${delayMs} ms: ${error?.message ?? error}`,
        );
      } else {
        this.#capture(error, `terminal:${item.kind}`);
        this.logger.error(
          `Background ${item.kind} job ${item.id} failed after ${attempts} attempt(s):`,
          error?.message ?? error,
        );
        if (item.kind === "forward-bundle-image") {
          await this.forwardBundles.failImage?.(
            item.payload.bundleId,
            item.payload.messageId,
            error,
          ).catch((notificationError) => {
            this.logger.error("Cannot mark forwarded image as failed:", notificationError.message);
            this.#capture(notificationError, "forward-bundle-notification");
          });
        }
        await this.store.remove(item.id);
      }
    } finally {
      this.#release(item.id);
      if (retryItem && !this.isStopping() && !this.#schedule(retryItem)) {
        this.logger.warn(`Persistent background job ${item.id} is waiting for a free ${item.kind} queue slot.`);
      }
    }
  }

  #enqueueScheduled(item) {
    try {
      const job = this.#queue(item.kind).enqueue(() => this.#run(item));
      void job.catch((error) => {
        this.logger.error(`Background ${item.kind} processing failed:`, error.message);
        this.#capture(error, `queue:${item.kind}`);
      });
      return true;
    } catch (error) {
      this.#release(item.id);
      if (error?.code !== "QUEUE_FULL") throw error;
      return false;
    }
  }

  #schedule(item) {
    if (this.#scheduledIds.has(item.id)) return true;
    this.#scheduledIds.add(item.id);
    const dueAt = Date.parse(String(item.nextAttemptAt ?? ""));
    const delayMs = Number.isFinite(dueAt) ? Math.max(0, dueAt - this.now()) : 0;
    if (delayMs > 0) {
      const timer = this.scheduleTimer(() => {
        this.#retryTimers.delete(item.id);
        try {
          if (this.isStopping()) {
            this.#release(item.id);
            return;
          }
          this.#enqueueScheduled(item);
        } catch (error) {
          this.logger.error(`Cannot schedule background ${item.kind} retry:`, error.message);
          this.#capture(error, `retry:${item.kind}`);
        }
      }, delayMs);
      timer?.unref?.();
      this.#retryTimers.set(item.id, timer);
      return true;
    }
    return this.#enqueueScheduled(item);
  }

  async enqueue(kind, payload, targetChatId, { dedupeKey = null } = {}) {
    await this.store.load();
    const replayed = this.store.findByDedupeKey(dedupeKey);
    if (replayed) {
      this.#schedule(replayed);
      return replayed;
    }
    const limit = kind === "speech" ? this.maxSpeechJobs : this.maxMediaJobs;
    if (this.#persistedCount(kind) >= limit) {
      if (kind !== "speech") {
        await this.sendMessage(targetChatId, `Очередь медиа переполнена (${this.maxMediaJobs}). Отправьте файл позже.`);
      }
      return null;
    }
    const item = await this.store.enqueue({ kind, payload, dedupeKey });
    if (!this.#schedule(item)) {
      this.logger.warn(`Persistent background job ${item.id} is waiting for a free ${kind} queue slot.`);
    }
    return item;
  }

  async restore() {
    await this.store.load();
    for (const pending of this.forwardBundles.pendingImageJobs?.() ?? []) {
      try {
        const restored = await this.enqueue(
          "forward-bundle-image",
          { bundleId: pending.bundleId, chatId: pending.chatId, messageId: pending.messageId },
          pending.chatId,
          { dedupeKey: pending.dedupeKey },
        );
        if (!restored) {
          await this.forwardBundles.failImage(
            pending.bundleId,
            pending.messageId,
            "очередь медиа переполнена при восстановлении",
          );
        }
      } catch (error) {
        this.#capture(error, "restore-forward-bundle");
        await this.forwardBundles.failImage(pending.bundleId, pending.messageId, error);
      }
    }
    const count = this.store.size;
    if (!count) return { restored: 0, total: 0 };
    let scheduled = 0;
    for (const item of this.store.values()) {
      if (this.#schedule(item)) scheduled += 1;
    }
    this.logger.log(`Restored ${scheduled}/${count} persistent background job(s).`);
    return { restored: scheduled, total: count };
  }
}
