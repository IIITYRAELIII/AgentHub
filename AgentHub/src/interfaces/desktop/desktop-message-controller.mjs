import { randomUUID } from "node:crypto";
import {
  messageReceiptKey,
  messageRequestFingerprint,
} from "../../infrastructure/persistence/message-receipts.mjs";

export function createDesktopMessageController({
  attachmentPaths,
  describeAttachments = (files) => files.map((file) => ({ id: String(file) })),
  resolveTarget,
  receipts,
  persistReceipts,
  runCoordinator,
}) {
  if (!runCoordinator?.submitClientInput || !runCoordinator?.steer) {
    throw new TypeError("runCoordinator is required");
  }
  const inflightReceipts = new Map();

  async function sendMessage(params) {
    const text = String(params.text ?? "").trim();
    const attachments = await attachmentPaths(params.attachments);
    if (!text && !attachments.length) throw new Error("Введите сообщение или добавьте изображение");
    if (text.length > 100_000) throw new Error("Сообщение слишком длинное");
    const clientUserMessageId = String(
      params.clientUserMessageId ?? params.requestId ?? randomUUID(),
    ).trim().slice(0, 200);
    if (!clientUserMessageId) throw new Error("Сообщение не содержит идентификатор доставки");
    const followUpMode = String(params.followUpMode ?? "").trim().toLowerCase();
    if (followUpMode && !["queue", "steer"].includes(followUpMode)) {
      throw new Error("Неизвестный режим следующего сообщения");
    }
    const input = attachments.length
      ? [
        { type: "text", text: text || "Проанализируй приложенное изображение." },
        ...attachments.map((file) => ({ type: "localImage", path: file })),
      ]
      : text;
    const target = await resolveTarget(params);
    if (!target.threadId) throw new Error("Сначала выберите или создайте задачу");
    const receiptIdentity = {
      provider: target.provider,
      threadId: target.threadId,
      clientUserMessageId,
    };
    const fingerprint = await messageRequestFingerprint({ text, attachments, followUpMode });
    const previous = receipts.find(receiptIdentity, fingerprint);
    if (previous) return previous;

    const receiptKey = messageReceiptKey(receiptIdentity);
    const inflight = inflightReceipts.get(receiptKey);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) {
        const error = new Error("Идентификатор сообщения уже используется для другого содержимого");
        error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
        throw error;
      }
      const result = await inflight.promise;
      return result;
    }

    const promise = (async () => {
      const result = await runCoordinator.submitClientInput({
        input,
        attachments,
        target,
        clientUserMessageId,
        followUpMode,
      });
      const { snapshot: _snapshot, ...storedResult } = result;
      if (attachments.length) storedResult.attachments = describeAttachments(attachments);
      receipts.remember(receiptIdentity, fingerprint, storedResult);
      await persistReceipts();
      return storedResult;
    })();
    inflightReceipts.set(receiptKey, { fingerprint, promise });
    try {
      const result = await promise;
      return result;
    } finally {
      inflightReceipts.delete(receiptKey);
    }
  }

  return {
    sendMessage,
    steerActiveInput: (request) => runCoordinator.steer(request),
  };
}
