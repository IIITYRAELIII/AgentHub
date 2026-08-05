export class ApprovalController {
  constructor({
    approvalProtocol,
    autoApprove,
    respond,
    send,
    sendForRun,
    runExists,
    setProgressStage,
    telegram,
    currentChatId,
  }) {
    this.approvalProtocol = approvalProtocol;
    this.autoApprove = autoApprove;
    this.respond = respond;
    this.send = send;
    this.sendForRun = sendForRun;
    this.runExists = runExists;
    this.setProgressStage = setProgressStage;
    this.telegram = telegram;
    this.currentChatId = currentChatId;
    this.pending = new Map();
  }

  async request(rpcId, kind, params, text, run = null) {
    const {
      approvalCallbackData,
      codexApprovalResponse,
      createApprovalKey,
    } = this.approvalProtocol;
    if (this.autoApprove()) {
      this.respond(rpcId, codexApprovalResponse(kind, "once", params));
      return;
    }
    const key = createApprovalKey();
    const approval = {
      rpcId,
      kind,
      params,
      text,
      runId: run?.id ?? null,
      chatId: run?.chatId ?? this.currentChatId(),
    };
    this.pending.set(key, approval);
    const extra = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Разрешить", callback_data: approvalCallbackData(key, "once") }],
          [{ text: "✅ На сессию", callback_data: approvalCallbackData(key, "session") }],
          [{ text: "❌ Отклонить", callback_data: approvalCallbackData(key, "decline") }],
        ],
      },
    };
    try {
      const message = run
        ? await this.sendForRun(run, text, extra, { kind: "approval" })
        : await this.send(text, extra);
      approval.messageId = message?.message_id ?? null;
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }
  }

  async requestMcp(rpcId, params, run = null) {
    const {
      approvalCallbackData,
      createApprovalKey,
      formatMcpElicitation,
      mcpElicitationAutoResponse,
    } = this.approvalProtocol;
    const acceptResponse = mcpElicitationAutoResponse(params);
    if (this.autoApprove() && acceptResponse) {
      this.respond(rpcId, acceptResponse);
      if (run) this.setProgressStage(run, "MCP-запрос подтверждён автоматически. Продолжаю…");
      return;
    }
    const key = createApprovalKey();
    const approval = {
      rpcId,
      kind: "mcp-elicitation",
      params,
      acceptResponse,
      runId: run?.id ?? null,
      chatId: run?.chatId ?? this.currentChatId(),
      text: formatMcpElicitation(params),
    };
    this.pending.set(key, approval);
    const decisions = [];
    if (acceptResponse) {
      decisions.push([{ text: "✅ Принять", callback_data: approvalCallbackData(key, "once") }]);
    }
    if (params.mode === "url" && params.url) {
      decisions.push([{ text: "🌐 Открыть ссылку", url: params.url }]);
    }
    decisions.push([{ text: "❌ Отклонить", callback_data: approvalCallbackData(key, "decline") }]);
    const text = formatMcpElicitation(params)
      + (!acceptResponse && params.mode === "form"
        ? "\n\nАвтоматически заполнить эту форму безопасно нельзя."
        : "");
    try {
      const extra = { reply_markup: { inline_keyboard: decisions } };
      const message = run
        ? await this.sendForRun(run, text, extra, { kind: "approval" })
        : await this.send(text, extra);
      approval.messageId = message?.message_id ?? null;
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }
  }

  async handleCallback(callback) {
    const {
      approvalMatchesTelegramMessage,
      codexApprovalResponse,
      parseApprovalCallback,
    } = this.approvalProtocol;
    const parsed = parseApprovalCallback(callback.data);
    if (!parsed) return false;
    const { key, action } = parsed;
    const approval = this.pending.get(key);
    if (!approval) {
      await this.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Запрос уже закрыт",
      });
      return true;
    }
    if (!approvalMatchesTelegramMessage(approval, callback)
      || (approval.runId && !this.runExists(approval.runId))) {
      await this.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Этот запрос больше не относится к активному ходу",
        show_alert: true,
      });
      return true;
    }
    this.pending.delete(key);
    const response = approval.kind === "mcp-elicitation"
      ? action === "decline" ? { action: "decline" } : approval.acceptResponse
      : codexApprovalResponse(approval.kind, action, approval.params);
    if (!response) {
      await this.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Для этой формы нужен явный ввод данных",
        show_alert: true,
      });
      this.pending.set(key, approval);
      return true;
    }
    this.respond(approval.rpcId, response);
    const decision = action === "once"
      ? "разрешено"
      : action === "session" ? "разрешено на сессию" : "отклонено";
    await this.telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Решение: ${decision}`,
    });
    await this.telegram("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    return true;
  }

  snapshot() {
    return [...this.pending.entries()].map(([key, approval]) => ({
      key,
      kind: approval.kind,
      runId: approval.runId,
      text: String(approval.text ?? "Требуется подтверждение"),
      canAllowSession: approval.kind !== "mcp-elicitation",
      canAccept: approval.kind !== "mcp-elicitation" || Boolean(approval.acceptResponse),
    }));
  }

  async resolveFromDesktop(key, action) {
    const { codexApprovalResponse } = this.approvalProtocol;
    const approval = this.pending.get(String(key ?? ""));
    if (!approval) throw new Error("Запрос подтверждения уже закрыт");
    if (approval.runId && !this.runExists(approval.runId)) {
      this.pending.delete(key);
      throw new Error("Запрос больше не относится к активному ходу");
    }
    if (!["once", "session", "decline"].includes(action)) throw new Error("Неизвестное решение подтверждения");
    const response = approval.kind === "mcp-elicitation"
      ? action === "decline" ? { action: "decline" } : approval.acceptResponse
      : codexApprovalResponse(approval.kind, action, approval.params);
    if (!response) throw new Error("Для этой формы нужен явный ввод данных");
    this.pending.delete(key);
    this.respond(approval.rpcId, response);
    if (approval.messageId && approval.chatId) {
      await this.telegram("editMessageReplyMarkup", {
        chat_id: approval.chatId,
        message_id: approval.messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    return {
      decision: action === "once" ? "allowed"
        : action === "session" ? "session" : "declined",
    };
  }
}
