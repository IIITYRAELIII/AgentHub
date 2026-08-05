// Routes one authorized Telegram update without owning application state.
export class TelegramMessageController {
  constructor({
    config,
    menuCommands,
    setChatId,
    findReplyBinding,
    activateBinding,
    notifyTaskSwitch,
    selectedTurnTarget,
    bindIncomingMessage,
    enqueueMedia,
    commandHandlers,
    handleBundleText = null,
    handleBundleMedia = null,
    handleText,
    sendMessage,
    logger = console,
  }) {
    this.config = config;
    this.menuCommands = menuCommands;
    this.setChatId = setChatId;
    this.findReplyBinding = findReplyBinding;
    this.activateBinding = activateBinding;
    this.notifyTaskSwitch = notifyTaskSwitch;
    this.selectedTurnTarget = selectedTurnTarget;
    this.bindIncomingMessage = bindIncomingMessage;
    this.enqueueMedia = enqueueMedia;
    this.commandHandlers = commandHandlers;
    this.handleBundleText = handleBundleText;
    this.handleBundleMedia = handleBundleMedia;
    this.handleText = handleText;
    this.sendMessage = sendMessage;
    this.logger = logger;
  }

  allowed(message) {
    const senderId = message.from?.id;
    if (!this.config.allowedUserIds.has(senderId)) {
      this.logger.warn(`Rejected Telegram user ${senderId ?? "unknown"}`);
      return false;
    }
    if (this.config.privateChatsOnly && message.chat?.type !== "private") {
      this.logger.warn(`Rejected non-private Telegram chat ${message.chat?.id ?? "unknown"}`);
      return false;
    }
    if (this.config.allowedChatIds && !this.config.allowedChatIds.has(message.chat?.id)) {
      this.logger.warn(`Rejected Telegram chat ${message.chat?.id ?? "unknown"}`);
      return false;
    }
    return true;
  }

  async activateReplyBinding(message) {
    const repliedMessageId = message.reply_to_message?.message_id;
    if (!Number.isSafeInteger(repliedMessageId)) return true;
    const binding = await this.findReplyBinding(message.chat.id, repliedMessageId);
    if (!binding) return true;
    try {
      const activated = await this.activateBinding(binding);
      if (activated.changed) await this.notifyTaskSwitch();
      return true;
    } catch (error) {
      await this.sendMessage(`Не удалось открыть задачу из этого сообщения: ${error.message}`);
      return false;
    }
  }

  async handleMedia(message) {
    if (message.photo || message.document?.mime_type?.startsWith("image/")) {
      if (this.handleBundleMedia
        && await this.handleBundleMedia(message, { forwardedOnly: true })) return true;
      if (this.handleBundleMedia && await this.handleBundleMedia(message)) return true;
      const target = this.selectedTurnTarget(message.chat.id);
      await this.bindIncomingMessage(message, message.caption?.trim() || "Изображение без подписи");
      await this.enqueueMedia("image", { message, target }, target.chatId, {
        dedupeKey: `message:${message.chat.id}:${message.message_id}:image`,
      });
      return true;
    }
    if (message.voice || message.audio) {
      const target = this.selectedTurnTarget(message.chat.id);
      await this.bindIncomingMessage(message, "Голосовое сообщение");
      await this.enqueueMedia("voice", { message, target }, target.chatId, {
        dedupeKey: `message:${message.chat.id}:${message.message_id}:voice`,
      });
      return true;
    }
    return false;
  }

  parseCommand(text) {
    if (!text.startsWith("/")) return null;
    const separator = text.indexOf(" ");
    const command = (separator < 0 ? text.slice(1) : text.slice(1, separator)).toLowerCase();
    const argument = separator < 0 ? "" : text.slice(separator + 1).trim();
    return { command, argument };
  }

  async handle(message) {
    if (!this.allowed(message)) return;
    this.setChatId(message.chat.id);
    if (!await this.activateReplyBinding(message)) return;
    if (await this.handleMedia(message)) return;

    const rawText = message.text?.trim();
    const text = this.menuCommands.get(rawText) ?? rawText;
    if (!text) return;
    if (this.handleBundleText && await this.handleBundleText(message, text, { forwardedOnly: true })) return;
    const parsed = this.parseCommand(text);
    if (!parsed) {
      if (this.handleBundleText && await this.handleBundleText(message, text)) return;
      await this.bindIncomingMessage(message, text);
      await this.handleText(message, text);
      return;
    }
    const handler = this.commandHandlers[parsed.command];
    if (!handler) {
      await this.sendMessage("Неизвестная команда. Используйте /help.");
      return;
    }
    await handler({ message, argument: parsed.argument, text });
  }
}
