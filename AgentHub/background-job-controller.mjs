import { BackgroundJobQueue } from "./background-job-queue.mjs";

const MEDIA_KINDS = Object.freeze(["image", "voice", "forward-bundle-image"]);

export class PersistentBackgroundJobController {
  #scheduledIds = new Set();

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
  } = {}) {
    if (!store) throw new TypeError("store is required");
    if (typeof sendMessage !== "function") throw new TypeError("sendMessage is required");
    this.store = store;
    this.maxMediaJobs = maxMediaJobs;
    this.maxSpeechJobs = maxSpeechJobs;
    this.isStopping = isStopping;
    this.onIdle = onIdle;
    this.sendMessage = sendMessage;
    this.media = media ?? {};
    this.forwardBundles = forwardBundles ?? {};
    this.logger = logger;
    const onChange = ({ size }) => {
      if (size === 0) this.onIdle();
    };
    this.mediaQueue = new Queue({ concurrency: 1, maxJobs: maxMediaJobs, onChange });
    this.speechQueue = new Queue({ concurrency: 1, maxJobs: maxSpeechJobs, onChange });
  }

  get mediaSize() { return this.mediaQueue.size; }
  get speechSize() { return this.speechQueue.size; }
  get speechPending() { return this.speechQueue.pending; }
  get size() { return this.mediaSize + this.speechSize; }

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
      try {
        const imagePath = await this.media.captureImage(descriptor);
        await this.forwardBundles.completeImage(item.payload.bundleId, item.payload.messageId, imagePath);
      } catch (error) {
        await this.forwardBundles.failImage(item.payload.bundleId, item.payload.messageId, error);
      }
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

  #schedule(item) {
    if (this.#scheduledIds.has(item.id)) return true;
    try {
      const job = this.#queue(item.kind).enqueue(async () => {
        try {
          if (this.isStopping()) return;
          await this.#execute(item);
        } finally {
          if (!this.isStopping()) await this.store.remove(item.id);
          this.#scheduledIds.delete(item.id);
        }
      });
      this.#scheduledIds.add(item.id);
      void job.catch((error) => {
        this.logger.error(`Background ${item.kind} processing failed:`, error.message);
      });
      return true;
    } catch (error) {
      if (error?.code !== "QUEUE_FULL") throw error;
      return false;
    }
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
