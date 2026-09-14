import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_RECEIPT_LIMIT = 600;

function normalizedIdentity({ provider, threadId, clientUserMessageId } = {}) {
  return {
    provider: String(provider ?? "").trim(),
    threadId: String(threadId ?? "").trim(),
    clientUserMessageId: String(clientUserMessageId ?? "").trim(),
  };
}

export function messageReceiptKey(identity) {
  const normalized = normalizedIdentity(identity);
  if (!normalized.clientUserMessageId) return "";
  return normalized.clientUserMessageId;
}

function unresolvedReceipt(receipt) {
  const result = receipt?.result;
  return result?.pending === true || result?.deferred === true || result?.dispatching === true;
}

export async function messageRequestFingerprint({
  text = "",
  attachments = [],
  attachmentIdentities = null,
  taskReferences = [],
  followUpMode = "",
  clientProjectionIntent = "",
  messageOrigin = null,
} = {}, {
  readAttachment = readFile,
} = {}) {
  const attachmentDigests = Array.isArray(attachmentIdentities)
    ? attachmentIdentities.map((attachment) => String(attachment?.id ?? attachment ?? "").trim())
    : [];
  if (!Array.isArray(attachmentIdentities)) {
    for (const attachment of attachments) {
      const content = await readAttachment(attachment);
      attachmentDigests.push(createHash("sha256").update(content).digest("hex"));
    }
  }
  const normalizedOrigin = messageOrigin && typeof messageOrigin === "object"
    ? Object.fromEntries(Object.entries(messageOrigin).sort(([left], [right]) => left.localeCompare(right)))
    : null;
  return createHash("sha256")
    .update(JSON.stringify({
      text: String(text).trim(),
      attachmentDigests,
      taskReferences: (Array.isArray(taskReferences) ? taskReferences : []).map((reference) => ({
        taskId: String(reference?.taskId ?? "").trim(),
        intent: String(reference?.intent ?? "context").trim().toLowerCase(),
      })),
      followUpMode: String(followUpMode).trim().toLowerCase(),
      clientProjectionIntent: String(clientProjectionIntent).trim().toLowerCase(),
      ...(normalizedOrigin ? { messageOrigin: normalizedOrigin } : {}),
    }))
    .digest("hex");
}

export class MessageReceiptRegistry {
  constructor({ limit = DEFAULT_RECEIPT_LIMIT } = {}) {
    this.limit = Math.max(1, Number(limit) || DEFAULT_RECEIPT_LIMIT);
    this.receipts = new Map();
    this.revision = 0;
  }

  restore(values) {
    this.receipts.clear();
    const restored = [];
    for (const value of Array.isArray(values) ? values : []) {
      const key = messageReceiptKey(value);
      const fingerprint = String(value?.fingerprint ?? "").trim();
      if (!key || !fingerprint || !value?.result || typeof value.result !== "object") continue;
      restored.push([key, {
        ...normalizedIdentity(value),
        fingerprint,
        result: structuredClone(value.result),
        createdAt: String(value.createdAt ?? ""),
      }]);
    }
    const unresolved = restored.filter(([, receipt]) => unresolvedReceipt(receipt));
    const terminalCapacity = Math.max(0, this.limit - unresolved.length);
    const terminal = restored.filter(([, value]) => !unresolvedReceipt(value));
    for (const [key, receipt] of [
      ...unresolved,
      ...(terminalCapacity > 0 ? terminal.slice(-terminalCapacity) : []),
    ]) {
      this.receipts.set(key, receipt);
    }
    this.revision += 1;
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

  get(identity) {
    const key = messageReceiptKey(identity);
    if (!key) return null;
    const receipt = this.receipts.get(key);
    return receipt ? structuredClone(receipt) : null;
  }

  findByTurn({ provider, threadId, turnId } = {}) {
    return this.findAllByTurn({ provider, threadId, turnId }).at(-1) ?? null;
  }

  findAllByTurn({ provider, threadId, turnId } = {}) {
    const normalizedProvider = String(provider ?? "").trim();
    const normalizedThreadId = String(threadId ?? "").trim();
    const normalizedTurnId = String(turnId ?? "").trim();
    if (!normalizedProvider || !normalizedThreadId || !normalizedTurnId) return [];
    return [...this.receipts.values()]
      .filter((receipt) => (
        receipt.provider === normalizedProvider
        && receipt.threadId === normalizedThreadId
        && String(receipt.result?.turnId ?? "").trim() === normalizedTurnId
      ))
      .map((receipt) => structuredClone(receipt));
  }

  findByResultId(id) {
    const expected = String(id ?? "").trim();
    if (!expected) return null;
    const values = [...this.receipts.values()];
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const receipt = values[index];
      if (String(receipt.result?.id ?? "").trim() === expected) {
        return structuredClone(receipt);
      }
    }
    return null;
  }

  reserve(identity, fingerprint, result = { accepted: false, pending: true }) {
    const key = messageReceiptKey(identity);
    if (!key) throw new Error("Нельзя сохранить квитанцию без точной identity сообщения");
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const error = new Error("Идентификатор сообщения уже использован для другого содержимого");
        error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
        throw error;
      }
      return structuredClone(existing.result);
    }
    if (this.receipts.size >= this.limit) {
      const terminalKey = [...this.receipts.entries()]
        .find(([, receipt]) => !unresolvedReceipt(receipt))?.[0];
      if (!terminalKey) {
        const error = new Error("реестр квитанций заполнен незавершёнными сообщениями");
        error.code = "MESSAGE_RECEIPT_CAPACITY_EXHAUSTED";
        throw error;
      }
      this.receipts.delete(terminalKey);
    }
    this.receipts.set(key, {
      ...normalizedIdentity(identity),
      fingerprint,
      result: structuredClone(result),
      createdAt: new Date().toISOString(),
    });
    this.revision += 1;
    return structuredClone(result);
  }

  remember(identity, fingerprint, result) {
    const key = messageReceiptKey(identity);
    const existing = this.receipts.get(key);
    if (!existing) return this.reserve(identity, fingerprint, result);
    if (existing.fingerprint !== fingerprint) {
      const error = new Error("Идентификатор сообщения уже использован для другого содержимого");
      error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
      throw error;
    }
    existing.result = structuredClone(result);
    this.revision += 1;
    return structuredClone(result);
  }

  updateResult(identity, result) {
    const key = messageReceiptKey(identity);
    if (!key) return false;
    const receipt = this.receipts.get(key);
    if (!receipt) return false;
    receipt.result = {
      ...receipt.result,
      ...structuredClone(result),
    };
    this.revision += 1;
    return true;
  }

  snapshot() {
    return [...this.receipts.values()].map((value) => structuredClone(value));
  }
}
