import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { callTelegramJson, telegramBotApiUrl } from "./telegram-api.mjs";

export class TelegramClient {
  constructor({
    token,
    apiBaseUrl,
    menu,
    statusHeaderDirectory,
    selectStatusHeader,
    getStatusFileId = () => null,
    rememberStatusFileId = async () => {},
    getDefaultChatId,
    getDefaultProvider,
    rememberSpeechText,
    messageLimit = 3900,
    fetchImpl = fetch,
    fileExists = existsSync,
    readFileImpl = readFile,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  }) {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl;
    this.menu = menu;
    this.statusHeaderDirectory = statusHeaderDirectory;
    this.selectStatusHeader = selectStatusHeader;
    this.getStatusFileId = getStatusFileId;
    this.rememberStatusFileId = rememberStatusFileId;
    this.getDefaultChatId = getDefaultChatId;
    this.getDefaultProvider = getDefaultProvider;
    this.rememberSpeechText = rememberSpeechText;
    this.messageLimit = messageLimit;
    this.fetchImpl = fetchImpl;
    this.fileExists = fileExists;
    this.readFileImpl = readFileImpl;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.typingInterval = null;
  }

  request(method, body, { timeoutMs = 40_000 } = {}) {
    return callTelegramJson({
      token: this.token,
      method,
      body,
      apiBaseUrl: this.apiBaseUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs,
    });
  }

  answerCallback(body, {
    onError = () => {},
    timeoutMs = 5_000,
  } = {}) {
    void this.request("answerCallbackQuery", body, { timeoutMs }).catch(onError);
  }

  async multipart(method, body, fileField, filePath) {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value == null) continue;
      form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    form.set(
      fileField,
      new Blob([await this.readFileImpl(filePath)], { type: "image/png" }),
      path.basename(filePath),
    );
    try {
      const response = await this.fetchImpl(
        telegramBotApiUrl(this.apiBaseUrl, this.token, method),
        {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(40_000),
        },
      );
      const payload = await response.json();
      if (!payload.ok) {
        const error = new Error(`Telegram ${method}: ${payload.description ?? response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        error.retryAfterMs = Number(payload.parameters?.retry_after ?? 0) * 1000;
        throw error;
      }
      return payload.result;
    } catch (error) {
      if (typeof error.retryable !== "boolean") error.retryable = true;
      throw error;
    }
  }

  async sendMessage(text, extra = {}) {
    const targetChatId = this.getDefaultChatId();
    if (!targetChatId) return undefined;
    return this.sendMessageTo(targetChatId, text, extra);
  }

  sendMessageTo(targetChatId, text, extra = {}) {
    const options = Object.hasOwn(extra, "reply_markup")
      ? extra
      : { ...extra, reply_markup: this.menu };
    return this.request("sendMessage", {
      chat_id: targetChatId,
      text: String(text),
      ...options,
    });
  }

  async sendStatusCard(
    text,
    extra = {},
    activeProviders = [],
    { targetChatId = this.getDefaultChatId(), provider = this.getDefaultProvider() } = {},
  ) {
    if (!targetChatId) return undefined;
    const headerName = this.selectStatusHeader(provider, activeProviders);
    const headerPath = path.join(this.statusHeaderDirectory, headerName);
    if (!this.fileExists(headerPath)) return this.sendMessageTo(targetChatId, text, extra);
    const sendPhoto = async (body) => {
      const cachedFileId = this.getStatusFileId(headerName);
      if (cachedFileId) {
        try {
          return await this.request("sendPhoto", { ...body, photo: cachedFileId });
        } catch (error) {
          if (error?.retryable === true) throw error;
          await this.rememberStatusFileId(headerName, null);
        }
      }
      const result = await this.multipart("sendPhoto", body, "photo", headerPath);
      const fileId = Array.isArray(result?.photo) ? result.photo.at(-1)?.file_id : null;
      if (fileId) await this.rememberStatusFileId(headerName, fileId);
      return result;
    };
    const caption = String(text);
    if (caption.length > 1000) {
      await sendPhoto({ chat_id: targetChatId }).catch(() => undefined);
      return this.sendMessageTo(targetChatId, caption, extra);
    }
    try {
      return await sendPhoto({
        chat_id: targetChatId,
        caption,
        ...extra,
      });
    } catch {
      return this.sendMessageTo(targetChatId, caption, extra);
    }
  }

  async sendLongMessage(text, {
    speechText = null,
    forceSpeechButton = false,
    maxParts = Number.POSITIVE_INFINITY,
    targetChatId = this.getDefaultChatId(),
  } = {}) {
    const value = String(text);
    const speechId = this.rememberSpeechText(speechText, forceSpeechButton);
    const maximumLength = Number.isFinite(maxParts)
      ? this.messageLimit * Math.max(1, maxParts)
      : value.length;
    const truncated = value.length > maximumLength;
    const visible = truncated
      ? `${value.slice(0, Math.max(0, maximumLength - 80))}\n\n… вывод ограничен ${maxParts} сообщениями.`
      : value;
    for (let start = 0; start < visible.length; start += this.messageLimit) {
      const isLast = start + this.messageLimit >= visible.length;
      const extra = isLast && speechId
        ? { reply_markup: { inline_keyboard: [[{ text: "🔊 Озвучить", callback_data: `speech:${speechId}` }]] } }
        : {};
      await this.sendMessageTo(targetChatId, visible.slice(start, start + this.messageLimit), extra);
    }
  }

  startTyping() {
    if (this.typingInterval || !this.getDefaultChatId()) return;
    const tick = () => {
      const targetChatId = this.getDefaultChatId();
      if (!targetChatId) return;
      this.request("sendChatAction", { chat_id: targetChatId, action: "typing" }).catch(() => {});
    };
    tick();
    this.typingInterval = this.setIntervalImpl(tick, 4000);
  }

  stopTyping() {
    if (!this.typingInterval) return;
    this.clearIntervalImpl(this.typingInterval);
    this.typingInterval = null;
  }
}
