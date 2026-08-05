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
    if (state === "started") {
      return this.receipts.updateResult(identity, {
        accepted: true,
        deferred: false,
        queued: false,
        cancelled: false,
        runId: started?.id ?? null,
        threadId: started?.threadId ?? item.threadId,
        turnId: started?.turnId ?? null,
        clientUserMessageId: item.clientUserMessageId,
        attachments: item.persistentFiles ? this.describeAttachments(item.temporaryFiles) : [],
      });
    }
    if (state === "steered") {
      return this.receipts.updateResult(identity, {
        accepted: true,
        deferred: false,
        queued: false,
        cancelled: false,
        steered: true,
        id: item.id,
        runId: started?.runId ?? null,
        threadId: started?.threadId ?? item.threadId,
        turnId: started?.turnId ?? null,
        clientUserMessageId: item.clientUserMessageId,
        attachments: item.persistentFiles ? this.describeAttachments(item.temporaryFiles) : [],
      });
    }
    if (state === "cancelled") {
      return this.receipts.updateResult(identity, {
        ...base,
        accepted: false,
        deferred: false,
        cancelled: true,
        message: "Сохранённое сообщение отменено.",
      });
    }
    const queued = ["queued", "dispatching", "retrying"].includes(state);
    return this.receipts.updateResult(identity, {
      ...base,
      accepted: false,
      deferred: true,
      queued,
      dispatching: state === "dispatching",
      reason: state === "pending" ? "launch-failed" : item.conflictKind ?? "task-running",
      message: state === "dispatching"
        ? "Сообщение отправляется в задачу."
        : state === "retrying"
          ? "Запуск временно недоступен; сообщение остаётся первым в очереди."
          : state === "pending"
            ? "Не удалось запустить сообщение; требуется выбрать дальнейшее действие."
            : "Сообщение поставлено в очередь и будет отправлено после текущего хода.",
    });
  }
}
