import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function normalizedIdentity({ provider, threadId, clientUserMessageId } = {}) {
  return {
    provider: String(provider ?? "").trim(),
    threadId: String(threadId ?? "").trim(),
    clientUserMessageId: String(clientUserMessageId ?? "").trim(),
  };
}

export function messageReceiptKey(identity) {
  const normalized = normalizedIdentity(identity);
  if (!normalized.provider || !normalized.threadId || !normalized.clientUserMessageId) return "";
  return `${normalized.provider}\0${normalized.threadId}\0${normalized.clientUserMessageId}`;
}

export async function messageRequestFingerprint({
  text = "",
  attachments = [],
  followUpMode = "",
} = {}, {
  readAttachment = readFile,
} = {}) {
  const attachmentDigests = [];
  for (const attachment of attachments) {
    const content = await readAttachment(attachment);
    attachmentDigests.push(createHash("sha256").update(content).digest("hex"));
  }
  return createHash("sha256")
    .update(JSON.stringify({
      text: String(text).trim(),
      attachmentDigests,
      followUpMode: String(followUpMode).trim().toLowerCase(),
    }))
    .digest("hex");
}

export class MessageReceiptRegistry {
  constructor({ limit = 2_000 } = {}) {
    this.limit = Math.max(1, Number(limit) || 2_000);
    this.receipts = new Map();
  }

  restore(values) {
    this.receipts.clear();
    for (const value of Array.isArray(values) ? values.slice(-this.limit) : []) {
      const key = messageReceiptKey(value);
      const fingerprint = String(value?.fingerprint ?? "").trim();
      if (!key || !fingerprint || !value?.result || typeof value.result !== "object") continue;
      this.receipts.set(key, {
        ...normalizedIdentity(value),
        fingerprint,
        result: structuredClone(value.result),
        createdAt: String(value.createdAt ?? ""),
      });
    }
  }

  find(identity, fingerprint) {
    const key = messageReceiptKey(identity);
    if (!key) return null;
    const receipt = this.receipts.get(key);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) {
      const error = new Error("Идентификатор сообщения уже использован для другого содержимого");
      error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
      throw error;
    }
    return structuredClone(receipt.result);
  }

  remember(identity, fingerprint, result) {
    const key = messageReceiptKey(identity);
    if (!key) throw new Error("Нельзя сохранить квитанцию без точной identity сообщения");
    this.receipts.set(key, {
      ...normalizedIdentity(identity),
      fingerprint,
      result: structuredClone(result),
      createdAt: new Date().toISOString(),
    });
    while (this.receipts.size > this.limit) {
      this.receipts.delete(this.receipts.keys().next().value);
    }
  }

  snapshot() {
    return [...this.receipts.values()].map((value) => structuredClone(value));
  }
}
