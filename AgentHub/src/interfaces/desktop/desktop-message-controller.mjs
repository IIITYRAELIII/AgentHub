import { randomUUID } from "node:crypto";
import { messageInputWithAttachments } from "../../domain/attachment-files.mjs";
import { messageWithTaskReferences } from "../../domain/task-board-task.mjs";
import {
  createInterstreamMessage,
  interstreamOriginAuthor,
  normalizeInterstreamOrigin,
  trustedInterstreamMessageDetails,
} from "../../domain/interstream-message.mjs";
import {
  messageReceiptKey,
  messageRequestFingerprint,
} from "../../infrastructure/persistence/message-receipts.mjs";
import { normalizedResponseAnnotations } from "../../domain/response-annotation-source.mjs";

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
  composerTransfers = null,
  discardPreparedAttachments = async () => {},
  commandMapping = null,
}) {
  if (!runCoordinator?.submitClientInput || !runCoordinator?.steer) {
    throw new TypeError("runCoordinator is required");
  }
  if (composerTransfers && (typeof composerTransfers.resolve !== "function"
    || typeof composerTransfers.claim !== "function"
    || typeof composerTransfers.consume !== "function")) {
    throw new TypeError("composerTransfers must provide resolve, claim and consume");
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
    let target;
    try {
      target = await resolveTarget(params, context);
      if (commandMapping) target = commandMapping.target(target);
      await composerTransfers?.ready?.();
    } catch (error) {
      preparation?.finish({ outcome: "failed", metadata: { errorCode: error?.code ?? null } });
      throw error;
    }
    if (!target.threadId) throw new Error("Сначала выберите или создайте поток");
    const requestedComposerTransfer = params.composerTransfer && typeof params.composerTransfer === "object"
      ? params.composerTransfer
      : null;
    let composerTransfer = requestedComposerTransfer
      ? composerTransfers?.resolve?.(requestedComposerTransfer, target, { clientUserMessageId }) ?? null
      : null;
    if (requestedComposerTransfer && !composerTransfer) {
      throw new Error("Перенос черновика устарел или закреплён за другой отправкой; сообщение не отправлено");
    }
    let attachments;
    try {
      attachments = await attachmentPaths(params.attachments);
    } catch (error) {
      preparation?.finish({ outcome: "failed", metadata: { errorCode: error?.code ?? null } });
      throw error;
    }
    const taskReferences = await resolveTaskReferences(params.taskReferences, target, context);
    if (!text && !attachments.length && !taskReferences.length) {
      throw new Error("Введите сообщение или добавьте вложение");
    }
    if (text.length > 100_000) throw new Error("Сообщение слишком длинное");
    const followUpMode = String(params.followUpMode ?? "").trim().toLowerCase();
    if (followUpMode && !["queue", "steer"].includes(followUpMode)) {
      throw new Error("Неизвестный режим следующего сообщения");
    }
    const clientProjectionIntent = String(params.clientProjectionIntent ?? "").trim().toLowerCase();
    if (clientProjectionIntent && !["conversation", "queue"].includes(clientProjectionIntent)) {
      throw new Error("Неизвестная проекция отправленного сообщения");
    }
    const descriptors = attachments.length ? describeAttachments(attachments) : [];
    const messageAttachments = [...descriptors, ...taskReferences];
    const displayText = String(params.displayText ?? params.text ?? "").trim();
    const responseAnnotations = normalizedResponseAnnotations(params.responseAnnotations, {
      annotationLimit: 20_000,
    });
    const responseAnnotationRequest = String(params.responseAnnotationRequest ?? "").trim();
    const messageOrigin = normalizeInterstreamOrigin(
      composerTransfer?.messageOrigin ?? target.messageOrigin,
    );
    if (clientUserMessageId.startsWith("mcp:") && (
      transport !== "mcp"
      || !messageOrigin?.requestId
      || clientUserMessageId !== `mcp:${messageOrigin.requestId}`
    )) {
      throw new Error("Идентификатор mcp: зарезервирован для подтверждённых межпоточных сообщений");
    }
    const taskReferencedInput = messageWithTaskReferences(text, taskReferences);
    const referencedInput = messageOrigin && !trustedInterstreamMessageDetails(taskReferencedInput, {
      origin: messageOrigin,
    })
      ? createInterstreamMessage({ ...messageOrigin, text: taskReferencedInput })
      : taskReferencedInput;
    if (transport === "mcp") {
      if (typeof context?.bindInterstreamAuditContent !== "function") {
        throw new Error("Межпоточное сообщение не связано с MCP audit");
      }
      await context.bindInterstreamAuditContent(referencedInput);
    }
    const commandAttachments = commandMapping ? commandMapping.files(attachments, clientUserMessageId) : attachments;
    let input = attachments.length
      ? messageInputWithAttachments(referencedInput, commandAttachments, descriptors)
      : referencedInput;
    if (commandMapping) input = commandMapping.input(input, clientUserMessageId);
    const messageAuthor = interstreamOriginAuthor(messageOrigin);
    const receiptIdentity = {
      provider: target.provider,
      threadId: target.threadId,
      clientUserMessageId,
    };
    const fingerprint = await messageRequestFingerprint({
      text, attachmentIdentities: descriptors, taskReferences, followUpMode, clientProjectionIntent,
      messageOrigin: composerTransfer ? messageOrigin : null,
    });
    const discardUnownedPreparedAttachments = async (files) => {
      const receipt = receipts.get?.(receiptIdentity);
      const ownedIds = new Set(receipt
        && receipt.provider === receiptIdentity.provider
        && receipt.threadId === receiptIdentity.threadId
        && receipt.clientUserMessageId === clientUserMessageId
        ? (receipt.result?.attachments ?? []).map((attachment) => attachment?.id).filter(Boolean)
        : []);
      const inflightFiles = inflightReceipts.get(messageReceiptKey(receiptIdentity))?.attachments ?? [];
      await discardPreparedAttachments(files.filter((file) => (
        !inflightFiles.includes(file)
        && !ownedIds.has(descriptors[attachments.indexOf(file)]?.id)
      )));
    };
    if (composerTransfer) {
      try {
        composerTransfer = await composerTransfers.claim(requestedComposerTransfer, target, {
          clientUserMessageId,
        });
      } catch (error) {
        await discardUnownedPreparedAttachments(attachments);
        preparation?.finish({ outcome: "failed", metadata: { errorCode: error?.code ?? null } });
        throw error;
      }
      if (!composerTransfer) {
        await discardUnownedPreparedAttachments(attachments);
        preparation?.finish({ outcome: "failed" });
        throw new Error("Перенос черновика уже закреплён за другой отправкой");
      }
    }
    preparation?.finish({
      outcome: "succeeded",
      metadata: { attachmentCount: attachments.length, taskReferenceCount: taskReferences.length },
    });
    const receiptKey = messageReceiptKey(receiptIdentity);
    const inflight = inflightReceipts.get(receiptKey);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) {
        if (composerTransfer) await discardUnownedPreparedAttachments(attachments);
        const error = new Error("Идентификатор сообщения уже используется для другого содержимого");
        error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
        throw error;
      }
      try {
        return await inflight.promise;
      } finally {
        if (composerTransfer) {
          const duplicateFiles = attachments.filter((file) => !inflight.attachments.includes(file));
          await discardUnownedPreparedAttachments(duplicateFiles);
        }
      }
    }
    let previous;
    try {
      previous = receipts.find(receiptIdentity, fingerprint);
    } catch (error) {
      if (composerTransfer) await discardUnownedPreparedAttachments(attachments);
      throw error;
    }
    if (previous) {
      if (composerTransfer) {
        // Ordinary retries reuse the already accepted files. Composer retries
        // can prepare replacement uploads, but must keep receipt-owned IDs.
        await discardUnownedPreparedAttachments(attachments);
        const consumed = await composerTransfers.consume(composerTransfer, { clientUserMessageId });
        if (!consumed) throw new Error("Не удалось подтвердить владение переносом черновика");
      }
      return previous;
    }
    const promise = (async () => {
      receipts.reserve(receiptIdentity, fingerprint, {
        accepted: false,
        pending: true,
        threadId: target.threadId,
        clientUserMessageId,
        ...(clientProjectionIntent ? { clientProjectionIntent } : {}),
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
      let result;
      try {
        result = await submit({
          input,
          attachments: commandAttachments,
          target,
          clientUserMessageId,
          clientProjectionIntent,
          followUpMode,
        });
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
      const { snapshot: _snapshot, ...storedResult } = result;
      storedResult.pending = false;
      if (clientProjectionIntent) storedResult.clientProjectionIntent = clientProjectionIntent;
      if (messageAttachments.length) storedResult.attachments = messageAttachments;
      receipts.updateResult(receiptIdentity, storedResult);
      if (composerTransfer) {
        const consumed = await composerTransfers.consume(composerTransfer, { clientUserMessageId });
        if (!consumed) {
          receipts.updateResult(receiptIdentity, {
            attentionRequired: true,
            reconciliationRequired: true,
            error: "Не подтверждено владение переносом после принятой отправки",
          });
          await persistReceipts();
          const error = new Error("Не удалось подтвердить владение переносом после отправки");
          error.code = "COMPOSER_TRANSFER_OWNERSHIP_LOST";
          throw error;
        }
      }
      if (!usesDurableIntake) await persistReceipts();
      return storedResult;
    })();
    inflightReceipts.set(receiptKey, { fingerprint, promise, attachments: [...attachments] });
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
