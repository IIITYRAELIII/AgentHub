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
    mcpAdmissionCoordinator = null,
    transportGeneration = null,
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
    this.mcpAdmissionCoordinator = mcpAdmissionCoordinator;
    this.transportGeneration = typeof transportGeneration === "function"
      ? transportGeneration
      : null;
    this.pending = new Map();
  }

  async request(rpcId, kind, params, text, run = null) {
    const {
      approvalCallbackData,
      codexApprovalResponse,
      createApprovalKey,
    } = this.approvalProtocol;
    if (this.autoApprove()) {
      this.#respondOnce(rpcId, codexApprovalResponse(kind, "once", params));
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
    if (run?.telegramDeliveryRequested === false) return;
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
      mcpElicitationAcceptResponse,
      mcpElicitationAutoResponse,
      mcpElicitationUrl,
    } = this.approvalProtocol;
    const autoResponse = mcpElicitationAutoResponse(params);
    if (this.autoApprove() && autoResponse) {
      this.#respondMcp(rpcId, params, autoResponse, run, "auto");
      if (run) this.setProgressStage(run, "MCP-запрос подтверждён автоматически. Продолжаю…");
      return;
    }
    const acceptResponse = mcpElicitationAcceptResponse(params);
    const url = mcpElicitationUrl(params);
    const key = createApprovalKey();
    const approval = {
      rpcId,
      kind: "mcp-elicitation",
      params,
      acceptResponse,
      url,
      runId: run?.id ?? null,
      chatId: run?.chatId ?? this.currentChatId(),
      text: formatMcpElicitation(params),
    };
    this.pending.set(key, approval);
    if (run?.telegramDeliveryRequested === false) return;
    const decisions = [];
    if (url) {
      decisions.push([{ text: "🌐 Открыть ссылку", url }]);
      decisions.push([{ text: "✅ Продолжить", callback_data: approvalCallbackData(key, "once") }]);
    } else if (acceptResponse) {
      decisions.push([{ text: "✅ Принять", callback_data: approvalCallbackData(key, "once") }]);
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

  async requestUserInput(rpcId, params, run = null) {
    const { createApprovalKey, formatToolRequestUserInput } = this.approvalProtocol;
    const key = createApprovalKey();
    const approval = {
      rpcId,
      kind: "user-input",
      params,
      questions: Array.isArray(params?.questions) ? params.questions : [],
      runId: run?.id ?? null,
      chatId: run?.chatId ?? this.currentChatId(),
      text: formatToolRequestUserInput(params),
    };
    this.pending.set(key, approval);
    if (run?.telegramDeliveryRequested === false) return;
    try {
      const text = `${approval.text}\n\nОтветьте в Agent Hub: этот запрос требует структурированного ввода.`;
      const message = run
        ? await this.sendForRun(run, text, {}, { kind: "approval" })
        : await this.send(text);
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
    if (approval.kind === "mcp-elicitation" && response.action === "accept") {
      this.#respondMcp(approval.rpcId, approval.params, response, approval.runId, "telegram");
    } else this.#respondOnce(approval.rpcId, response);
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
      url: approval.kind === "mcp-elicitation" ? approval.url : "",
      questions: approval.kind === "user-input"
        ? approval.questions.map((question) => ({
          id: String(question?.id ?? ""),
          header: String(question?.header ?? ""),
          question: String(question?.question ?? ""),
          isOther: question?.isOther === true,
          isSecret: question?.isSecret === true,
          options: Array.isArray(question?.options)
            ? question.options.map((option) => ({
              label: String(option?.label ?? ""),
              description: String(option?.description ?? ""),
            }))
            : null,
        }))
        : null,
    }));
  }

  async resolveFromDesktop(key, action, submitted = {}) {
    const { codexApprovalResponse, codexToolUserInputResponse } = this.approvalProtocol;
    const approval = this.pending.get(String(key ?? ""));
    if (!approval) throw new Error("Запрос подтверждения уже закрыт");
    if (approval.runId && !this.runExists(approval.runId)) {
      this.pending.delete(key);
      throw new Error("Запрос больше не относится к активному ходу");
    }
    const allowedActions = approval.kind === "user-input"
      ? ["submit", "decline"]
      : ["once", "session", "decline"];
    if (!allowedActions.includes(action)) throw new Error("Неизвестное решение подтверждения");
    const response = approval.kind === "user-input"
      ? action === "decline"
        ? codexToolUserInputResponse({ ...approval.params, isBlocking: false }, {})
        : codexToolUserInputResponse(approval.params, submitted.answers)
      : approval.kind === "mcp-elicitation"
      ? action === "decline" ? { action: "decline" } : approval.acceptResponse
      : codexApprovalResponse(approval.kind, action, approval.params);
    if (!response) throw new Error("Для этой формы нужен явный ввод данных");
    this.pending.delete(key);
    if (approval.kind === "mcp-elicitation" && response.action === "accept") {
      this.#respondMcp(approval.rpcId, approval.params, response, approval.runId, "desktop");
    } else this.#respondOnce(approval.rpcId, response);
    if (approval.messageId && approval.chatId) {
      await this.telegram("editMessageReplyMarkup", {
        chat_id: approval.chatId,
        message_id: approval.messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    return {
      decision: action === "submit" ? "submitted"
        : action === "once" ? "allowed"
          : action === "session" ? "session" : "declined",
    };
  }

  #respondMcp(rpcId, params, response, run, source) {
    if (!this.mcpAdmissionCoordinator) {
      this.#respondOnce(rpcId, response);
      return;
    }
    const runId = typeof run === "object" ? run?.id : run;
    const currentTransportGeneration = this.transportGeneration;
    const transportGeneration = currentTransportGeneration?.() ?? null;
    this.mcpAdmissionCoordinator.begin({
      rpcId,
      params,
      response,
      respond: (id, value) => this.#respondOnce(id, value, false, {
        expectedGeneration: transportGeneration,
      }),
      runId,
      threadId: typeof run === "object" ? run?.threadId : params?.threadId,
      turnId: typeof run === "object" ? run?.turnId : params?.turnId,
      source,
      isActive: () => !runId || this.runExists(runId),
      transportGeneration,
      currentTransportGeneration,
    });
  }

  #respondOnce(rpcId, response, logFailure = true, options = {}) {
    const result = this.respond(rpcId, response, options);
    if (logFailure && result && typeof result.catch === "function") {
      result.catch((error) => console.error(
        `[mcp-admission] ${JSON.stringify({
          component: "mcp-admission",
          stage: "rpc-response-write-failed",
          rpcId: String(rpcId),
          error: error.message,
        })}`,
      ));
    }
    return result;
  }
}
