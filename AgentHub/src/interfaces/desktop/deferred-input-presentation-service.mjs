import { userTaskReferencePromptDetails } from "../../application/task-history.mjs";
import { deferredInputText } from "../../domain/deferred-input.mjs";

export function deferredInputAttachments(item, describeAttachments) {
  const files = item.persistentFiles ? describeAttachments?.(item.temporaryFiles ?? []) ?? [] : [];
  const references = userTaskReferencePromptDetails(deferredInputText(item.input))?.references ?? [];
  return [...files, ...references];
}

export class DeferredInputPresentationService {
  constructor({ telegram, receipts, describeAttachments }) {
    this.telegram = telegram;
    this.receipts = receipts;
    this.describeAttachments = describeAttachments;
  }

  async updateTelegramMessage(item, text, replyMarkup = { inline_keyboard: [] }) {
    if (!item?.messageId) return;
    await this.telegram("editMessageText", {
      chat_id: item.chatId,
      message_id: item.messageId,
      text,
      reply_markup: replyMarkup,
    }).catch(() => {});
  }

  updateDesktopReceipt(item, state, started = null) {
    const identity = {
      provider: item?.provider,
      threadId: item?.threadId,
      clientUserMessageId: item?.clientUserMessageId,
    };
    if (!identity.clientUserMessageId) return false;
    const base = { id: item.id, clientUserMessageId: item.clientUserMessageId };
    if (state === "expired") {
      return this.receipts.updateResult(identity, { ...base, ...started });
    }
    if (state === "started") {
      const acceptedTurnId = String(started?.providerStart?.turnId ?? "").trim();
      const providerAccepted = Boolean(acceptedTurnId)
        && acceptedTurnId === String(started?.turnId ?? "").trim()
        && ["accepted-awaiting-first-event", "observed"].includes(
          String(started?.providerStart?.state ?? ""),
        );
      return this.receipts.updateResult(identity, {
        accepted: true,
        providerAccepted,
        deferred: false,
        queued: false,
        dispatching: false,
        reason: null,
        cancelled: false,
        steered: false,
        runId: started?.id ?? null,
        threadId: started?.threadId ?? item.threadId,
        turnId: started?.turnId ?? null,
        clientUserMessageId: item.clientUserMessageId,
        deliveredAt: started?.startedAt ?? item.dispatchingAt ?? null,
        attachments: deferredInputAttachments(item, this.describeAttachments),
      });
    }
    if (state === "steered") {
      return this.receipts.updateResult(identity, {
        accepted: true,
        providerAccepted: Boolean(String(started?.turnId ?? "").trim()),
        deferred: false,
        queued: false,
        reason: null,
        cancelled: false,
        steered: true,
        id: item.id,
        runId: started?.runId ?? null,
        threadId: started?.threadId ?? item.threadId,
        turnId: started?.turnId ?? null,
        clientUserMessageId: item.clientUserMessageId,
        attachments: deferredInputAttachments(item, this.describeAttachments),
      });
    }
    if (state === "cancelled") {
      return this.receipts.updateResult(identity, {
        ...base,
        deferred: false,
        cancelled: true,
        message: "Сохранённое сообщение отменено.",
      });
    }
    const queued = ["queued", "dispatching", "retrying", "reconciling"].includes(state);
    return this.receipts.updateResult(identity, {
      ...base,
      deferred: true,
      queued,
      dispatching: ["dispatching", "reconciling"].includes(state),
      reason: state === "pending"
        ? "launch-failed"
        : state === "reconciling"
          ? "provider-start-unconfirmed"
          : item.conflictKind ?? "task-running",
      message: state === "dispatching"
        ? "Сообщение отправляется в поток."
        : state === "reconciling"
          ? "Сообщение принято Hub; уточняется точный запуск Codex без повторной отправки."
        : state === "retrying"
          ? "Запуск временно недоступен; сообщение остаётся первым в очереди."
          : state === "pending"
            ? "Не удалось запустить сообщение; требуется выбрать дальнейшее действие."
            : "Сообщение поставлено в очередь и будет отправлено после текущего хода.",
    });
  }
}
