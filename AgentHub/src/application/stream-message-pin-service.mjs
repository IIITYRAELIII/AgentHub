import { randomUUID } from "node:crypto";
import { streamMessagePinPreview } from "../domain/stream-message-pin.mjs";

function requiredText(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Укажите ${name}`);
  return result;
}

export class StreamMessagePinService {
  constructor({ store, workspaceCatalog, resolveMessage } = {}) {
    if (!store?.list || !store?.pin || !store?.unpin) throw new TypeError("message pin store is required");
    if (!workspaceCatalog?.stream || !workspaceCatalog?.threadsForStream) {
      throw new TypeError("workspace catalog is required");
    }
    if (typeof resolveMessage !== "function") throw new TypeError("resolveMessage is required");
    this.store = store;
    this.workspaceCatalog = workspaceCatalog;
    this.resolveMessage = resolveMessage;
    this.undo = new Map();
  }

  #stream(streamId) {
    const id = requiredText(streamId, "Stream");
    const stream = this.workspaceCatalog.stream(id);
    if (!stream) throw new Error("Stream не найден");
    return stream;
  }

  #validateThread(streamId, provider, taskThreadId) {
    const belongs = this.workspaceCatalog.threadsForStream(streamId).some((thread) => (
      String(thread?.provider ?? "").trim() === provider
      && String(thread?.threadId ?? "").trim() === taskThreadId
    ));
    if (!belongs) throw new Error("Сообщение не относится к выбранному Stream");
  }

  snapshot() {
    return this.store.list().map((pin) => {
      let available = false;
      try {
        const candidate = this.resolveMessage({ ...pin, threadId: pin.taskThreadId });
        available = candidate?.pinEligible === true
          && candidate.provider === pin.provider
          && candidate.threadId === pin.taskThreadId
          && candidate.turnId === pin.turnId
          && candidate.itemId === pin.itemId
          && candidate.role === pin.role;
      } catch {
        available = false;
      }
      return { ...pin, available };
    });
  }

  async set(params = {}) {
    const stream = this.#stream(params.streamId);
    if (params.pinned === true) {
      const undoToken = String(params.undoToken ?? "").trim();
      if (undoToken) {
        const saved = this.undo.get(undoToken);
        if (!saved || saved.expiresAtMs < Date.now() || saved.pin.streamId !== stream.id) {
          throw new Error("Срок отмены истёк");
        }
        const result = await this.store.pin(saved.pin);
        this.undo.delete(undoToken);
        return { pin: result.pin, changed: result.changed, messagePins: this.snapshot() };
      }
      const provider = requiredText(params.provider, "provider").toLowerCase();
      const taskThreadId = requiredText(params.taskThreadId ?? params.threadId, "Thread");
      this.#validateThread(stream.id, provider, taskThreadId);
      const candidate = this.resolveMessage({
        provider,
        threadId: taskThreadId,
        turnId: requiredText(params.turnId, "ход"),
        itemId: requiredText(params.itemId, "сообщение"),
        role: requiredText(params.role, "роль"),
      });
      if (!candidate || candidate.pinEligible !== true || !candidate.messageKey) {
        throw new Error("Это сообщение нельзя закрепить");
      }
      const requestedKey = String(params.messageKey ?? "").trim();
      if (requestedKey && requestedKey !== candidate.messageKey) {
        throw new Error("Durable identity сообщения изменилась; обновите историю");
      }
      const result = await this.store.pin({
        streamId: stream.id,
        messageKey: candidate.messageKey,
        sourceAlias: candidate.sourceAlias,
        provider,
        taskThreadId,
        turnThreadId: candidate.turnThreadId ?? taskThreadId,
        turnId: candidate.turnId,
        itemId: candidate.itemId,
        role: candidate.role,
        clientUserMessageId: candidate.clientUserMessageId,
        semanticSlot: candidate.semanticSlot,
        preview: streamMessagePinPreview(candidate),
        author: candidate.author,
        time: candidate.occurredAt ?? candidate.time,
      });
      return { pin: result.pin, changed: result.changed, messagePins: this.snapshot() };
    }
    const result = await this.store.unpin({
      pinId: params.pinId,
      streamId: stream.id,
      messageKey: params.messageKey,
    });
    const undoToken = result.changed ? randomUUID() : "";
    if (undoToken) {
      this.undo.set(undoToken, { pin: result.pin, expiresAtMs: Date.now() + 10_000 });
    }
    return {
      removedPin: result.pin,
      undoToken,
      changed: result.changed,
      messagePins: this.snapshot(),
    };
  }

  async clear(params = {}) {
    const stream = this.#stream(params.streamId);
    const result = await this.store.clear(stream.id);
    return { removedPins: result.pins, changed: result.changed, messagePins: this.snapshot() };
  }
}
