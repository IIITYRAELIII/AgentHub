import {
  buildStreamHandoffPackage,
  streamHandoffReason,
} from "../domain/stream-handoff.mjs";

const META_PREFIX = "stream-handoff:";
const HISTORY_LIMIT = 12;

function metaKey(streamId) {
  const id = String(streamId ?? "").trim();
  return id ? `${META_PREFIX}${id}` : "";
}

function normalizedProvider(value) {
  return String(value ?? "").trim().toLowerCase();
}

// Owns the durable "the next turn of this Stream starts in a new provider Thread"
// request. The request is stored per Stream so it survives a runtime restart and
// so a provider that only learns its Thread ID from the first CLI event still
// receives the package.
export class StreamHandoffService {
  #catalog;

  #workLog;

  #now;

  #historyLimit;

  #logger;

  constructor({
    workspaceCatalog,
    workLog,
    now = () => new Date(),
    historyLimit = HISTORY_LIMIT,
    logger = console,
  }) {
    if (typeof workspaceCatalog?.meta !== "function") throw new TypeError("workspaceCatalog.meta is required");
    if (typeof workspaceCatalog?.setMeta !== "function") throw new TypeError("workspaceCatalog.setMeta is required");
    if (typeof workLog?.threadTurns !== "function") throw new TypeError("workLog.threadTurns is required");
    this.#catalog = workspaceCatalog;
    this.#workLog = workLog;
    this.#now = now;
    this.#historyLimit = Math.max(1, Number(historyLimit) || HISTORY_LIMIT);
    this.#logger = logger;
  }

  async request({
    streamId,
    targetProvider,
    sourceProvider = "",
    sourceThreadId = "",
    reason = "manual",
  } = {}) {
    const key = metaKey(streamId);
    const provider = normalizedProvider(targetProvider);
    if (!key || !provider) return null;
    const pending = {
      streamId: String(streamId).trim(),
      targetProvider: provider,
      sourceProvider: normalizedProvider(sourceProvider),
      sourceThreadId: String(sourceThreadId ?? "").trim(),
      reason: streamHandoffReason(reason),
      requestedAt: this.#now().toISOString(),
    };
    await this.#catalog.setMeta(key, JSON.stringify(pending));
    return pending;
  }

  pending(streamId) {
    const key = metaKey(streamId);
    if (!key) return null;
    const raw = String(this.#catalog.meta(key) ?? "").trim();
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      return value?.targetProvider ? value : null;
    } catch (error) {
      this.#logger.warn?.(`Cannot read Stream handoff request for ${streamId}: ${error.message}`);
      void this.#clear(key).catch((clearError) => {
        this.#logger.warn?.(`Cannot clear invalid Stream handoff request for ${streamId}: ${clearError.message}`);
      });
      return null;
    }
  }

  // Returns the package for the first turn of the receiving Thread and clears the
  // request, so a Stream is handed over exactly once per requested transition.
  async consume({ streamId, provider, threadId = "" } = {}) {
    const key = metaKey(streamId);
    const pending = this.pending(streamId);
    if (!pending) return "";
    const targetProvider = normalizedProvider(provider);
    const currentThreadId = String(threadId ?? "").trim();
    // The previous Thread can still finish a queued turn. It must neither receive
    // nor drop the package that the new Thread is waiting for.
    if (currentThreadId && currentThreadId === pending.sourceThreadId) return "";
    if (pending.targetProvider !== targetProvider) {
      await this.#clear(key);
      return "";
    }
    const stream = this.#catalog.stream?.(pending.streamId) ?? null;
    const workspace = stream ? this.#catalog.workspace?.(stream.workspaceId) ?? null : null;
    const threads = (this.#catalog.threadsForStream?.(pending.streamId) ?? [])
      .filter((thread) => !(
        normalizedProvider(thread?.provider) === targetProvider
        && String(thread?.threadId ?? "").trim() === currentThreadId
      ));
    const turns = threads.length
      ? await this.#workLog.threadTurns(threads, { limit: this.#historyLimit })
      : [];
    const handoff = buildStreamHandoffPackage({
      workspaceName: workspace?.name ?? "",
      workspaceId: workspace?.id ?? "",
      streamName: stream?.displayName ?? stream?.name ?? "",
      streamId: pending.streamId,
      sourceProvider: pending.sourceProvider,
      sourceThreadId: pending.sourceThreadId,
      targetProvider,
      reason: pending.reason,
      requestedAt: pending.requestedAt,
      turns,
    });
    await this.#clear(key);
    return handoff;
  }

  discard(streamId) {
    return this.#clear(metaKey(streamId));
  }

  async #clear(key) {
    if (!key) return;
    if (typeof this.#catalog.deleteMeta === "function") await this.#catalog.deleteMeta(key);
    else await this.#catalog.setMeta(key, "");
  }
}
