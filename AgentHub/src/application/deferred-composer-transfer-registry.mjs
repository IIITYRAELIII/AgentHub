import { normalizeInterstreamOrigin } from "../domain/interstream-message.mjs";

function normalizedIdentity(value = {}) {
  return {
    provider: String(value.provider ?? "").trim().toLowerCase(),
    threadId: String(value.threadId ?? "").trim(),
    streamId: String(value.streamId ?? "").trim(),
  };
}

function sameIdentity(left, right) {
  const expected = normalizedIdentity(left);
  const actual = normalizedIdentity(right);
  return Boolean(expected.provider && expected.threadId
    && expected.provider === actual.provider
    && expected.threadId === actual.threadId
    && (!expected.streamId || expected.streamId === actual.streamId));
}

export class DeferredComposerTransferRegistry {
  #values = new Map();
  #cleanup;

  #limit;

  constructor({ cleanup = async () => {}, limit = 600 } = {}) {
    this.#cleanup = cleanup;
    this.#limit = Math.max(1, Number(limit) || 600);
  }

  remember(item, token) {
    const id = String(item?.id ?? "").trim();
    const normalizedToken = String(token ?? "").trim();
    if (!id || !normalizedToken) throw new Error("Некорректная identity переноса черновика");
    this.#values.set(normalizedToken, {
      id,
      identity: normalizedIdentity(item),
      messageOrigin: normalizeInterstreamOrigin(item.messageOrigin),
      item,
      consumed: false,
    });
    while (this.#values.size > this.#limit) this.#values.delete(this.#values.keys().next().value);
  }

  resolve(value, target) {
    const token = String(value?.token ?? "").trim();
    const id = String(value?.id ?? "").trim();
    const stored = token ? this.#values.get(token) : null;
    if (!stored || stored.id !== id || !sameIdentity(stored.identity, target)) return null;
    return {
      token,
      id,
      messageOrigin: stored.messageOrigin,
    };
  }

  async consume(value) {
    const token = String(value?.token ?? "").trim();
    const id = String(value?.id ?? "").trim();
    const stored = token ? this.#values.get(token) : null;
    if (!stored || stored.id !== id) return false;
    if (stored.consumed) return true;
    stored.consumed = true;
    await this.#cleanup(stored.item).catch(() => {});
    return true;
  }

  has(value) {
    const token = String(value?.token ?? "").trim();
    const id = String(value?.id ?? "").trim();
    const stored = token ? this.#values.get(token) : null;
    return Boolean(stored && stored.id === id);
  }
}
