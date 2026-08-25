import { randomUUID } from "node:crypto";
import { messageInputWithAttachments } from "../../domain/attachment-files.mjs";
import { messageWithTaskReferences } from "../../domain/task-board-task.mjs";
import {
  interstreamOriginAuthor,
  normalizeInterstreamOrigin,
} from "../../domain/interstream-message.mjs";
import {
  messageReceiptKey,
  messageRequestFingerprint,
} from "../../infrastructure/persistence/message-receipts.mjs";

export function createDesktopMessageController({
  attachmentPaths,
  describeAttachments = (files) => files.map((file) => ({ id: String(file) })),
  resolveTaskReferences = async (values) => {
    if (Array.isArray(values) && values.length) throw new Error("Task references are not configured");
    return [];
  },
  resolveTarget,
  receipts,
  persistReceipts,
  runCoordinator,
  durableIntake = false,
  commandTrace = null,
}) {
  if (!runCoordinator?.submitClientInput || !runCoordinator?.steer) {
    throw new TypeError("runCoordinator is required");
  }
  const inflightReceipts = new Map();

  async function sendMessage(params, context = null) {
    const text = String(params.text ?? "").trim();
    const clientUserMessageId = String(
      params.clientUserMessageId ?? params.requestId ?? randomUUID(),
    ).trim().slice(0, 200);
    if (!clientUserMessageId) throw new Error("Сообщение не содержит идентификатор доставки");
    const transport = String(context?.source ?? "desktop-control").trim().toLowerCase()
      || "desktop-control";
    const preparation = commandTrace?.startBestEffortSpan?.({
      commandId: clientUserMessageId,
      stage: "attachment-preparation",
      transport,
    });
    let attachments;
    let target;
    try {
      attachments = await attachmentPaths(params.attachments);
      target = await resolveTarget(params, context);
    } catch (error) {
      preparation?.finish({ outcome: "failed", metadata: { errorCode: error?.code ?? null } });
      throw error;
    }
    if (!target.threadId) throw new Error("Сначала выберите или создайте поток");
    const taskReferences = await resolveTaskReferences(params.taskReferences, target, context);
    if (!text && !attachments.length && !taskReferences.length) {
      throw new Error("Введите сообщение или добавьте вложение");
    }
    if (text.length > 100_000) throw new Error("Сообщение слишком длинное");
    const followUpMode = String(params.followUpMode ?? "").trim().toLowerCase();
    if (followUpMode && !["queue", "steer"].includes(followUpMode)) {
      throw new Error("Неизвестный режим следующего сообщения");
    }
    const descriptors = attachments.length ? describeAttachments(attachments) : [];
    const messageAttachments = [...descriptors, ...taskReferences];
    const displayText = String(params.displayText ?? params.text ?? "").trim();
    const responseAnnotations = Array.isArray(params.responseAnnotations)
      ? params.responseAnnotations.slice(0, 20).map((item) => ({
        text: String(item?.text ?? ""),
        annotation: String(item?.annotation ?? ""),
      }))
      : [];
    const responseAnnotationRequest = String(params.responseAnnotationRequest ?? "").trim();
    const referencedInput = messageWithTaskReferences(text, taskReferences);
    const input = attachments.length
      ? messageInputWithAttachments(referencedInput, attachments, descriptors)
      : referencedInput;
    const messageOrigin = normalizeInterstreamOrigin(target.messageOrigin);
    const messageAuthor = interstreamOriginAuthor(messageOrigin);
    const receiptIdentity = {
      provider: target.provider,
      threadId: target.threadId,
      clientUserMessageId,
    };
    const fingerprint = await messageRequestFingerprint({
      text, attachmentIdentities: descriptors, taskReferences, followUpMode,
    });
    preparation?.finish({
      outcome: "succeeded",
      metadata: { attachmentCount: attachments.length, taskReferenceCount: taskReferences.length },
    });
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
    const previous = receipts.find(receiptIdentity, fingerprint);
    if (previous) return previous;

    const promise = (async () => {
      receipts.reserve(receiptIdentity, fingerprint, {
        accepted: false,
        pending: true,
        threadId: target.threadId,
        clientUserMessageId,
        displayText,
        responseAnnotations,
        responseAnnotationRequest,
        attachments: messageAttachments,
        ...(messageAuthor ? { author: messageAuthor } : {}),
        ...(messageOrigin ? { origin: messageOrigin } : {}),
        message: "Сообщение сохранено Hub и ожидает подтверждения запуска.",
      });
      const usesDurableIntake = durableIntake && typeof runCoordinator.acceptClientInput === "function";
      if (!usesDurableIntake) await persistReceipts();
      const submit = usesDurableIntake
        ? runCoordinator.acceptClientInput.bind(runCoordinator)
        : runCoordinator.submitClientInput.bind(runCoordinator);
      try {
        const result = await submit({
          input,
          attachments,
          target,
          clientUserMessageId,
          followUpMode,
        });
        const { snapshot: _snapshot, ...storedResult } = result;
        storedResult.pending = false;
        if (messageAttachments.length) storedResult.attachments = messageAttachments;
        receipts.updateResult(receiptIdentity, storedResult);
        if (!usesDurableIntake) await persistReceipts();
        return storedResult;
      } catch (error) {
        receipts.updateResult(receiptIdentity, {
          accepted: false,
          pending: false,
          rejected: true,
          error: String(error?.message ?? error),
        });
        await persistReceipts();
        throw error;
      }
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
