import http from "node:http";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LoopbackTelegramApi {
  constructor({ userId = 42, chatId = 84 } = {}) {
    this.userId = userId;
    this.chatId = chatId;
    this.server = null;
    this.baseUrl = "";
    this.nextUpdateId = 1;
    this.nextIncomingMessageId = 10_000;
    this.nextOutgoingMessageId = 1;
    this.updates = [];
    this.calls = [];
    this.messages = new Map();
    this.failures = new Map();
    this.fileDownloadDelayMs = 0;
    this.fileDownloads = [];
  }

  async start() {
    if (this.server) return this.baseUrl;
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this.baseUrl;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  failNext(method, status = 500) {
    const failures = this.failures.get(method) ?? [];
    failures.push(status);
    this.failures.set(method, failures);
  }

  async handle(request, response) {
    if (request.socket.remoteAddress && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, description: "Loopback access only" }));
      return;
    }
    if (request.url?.includes("/file/")) {
      const download = { startedAt: Date.now(), completedAt: null };
      this.fileDownloads.push(download);
      if (this.fileDownloadDelayMs > 0) await delay(this.fileDownloadDelayMs);
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end(Buffer.from("fake-image"));
      download.completedAt = Date.now();
      return;
    }
    const method = request.url?.split("/").at(-1) ?? "";
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = {};
    if (request.headers["content-type"]?.startsWith("application/json")) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = {};
      }
    }
    const call = { index: this.calls.length, method, body, rawBody, at: Date.now() };
    this.calls.push(call);
    const failures = this.failures.get(method) ?? [];
    if (failures.length) {
      const status = failures.shift();
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, description: `Injected HTTP ${status}` }));
      return;
    }
    if (method === "getUpdates") {
      await delay(15);
      const offset = Number(body.offset ?? 0);
      this.respond(response, this.updates.filter((update) => update.update_id >= offset));
      return;
    }
    if (method === "getFile") {
      this.respond(response, { file_path: "loopback/fake-image.jpg" });
      return;
    }
    if (method === "sendMessage" || method === "sendPhoto") {
      const message = {
        message_id: this.nextOutgoingMessageId++,
        chat: { id: Number(body.chat_id ?? this.chatId), type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: body.text,
        caption: body.caption,
        reply_markup: body.reply_markup,
      };
      this.messages.set(message.message_id, message);
      call.result = message;
      this.respond(response, message);
      return;
    }
    if (method === "editMessageText") {
      const message = this.messages.get(Number(body.message_id)) ?? {
        message_id: Number(body.message_id),
        chat: { id: Number(body.chat_id ?? this.chatId), type: "private" },
      };
      Object.assign(message, { text: body.text, reply_markup: body.reply_markup });
      this.messages.set(message.message_id, message);
      call.result = message;
      this.respond(response, message);
      return;
    }
    if (method === "editMessageReplyMarkup") {
      const message = this.messages.get(Number(body.message_id)) ?? {
        message_id: Number(body.message_id),
        chat: { id: Number(body.chat_id ?? this.chatId), type: "private" },
      };
      message.reply_markup = body.reply_markup;
      this.messages.set(message.message_id, message);
      call.result = message;
      this.respond(response, message);
      return;
    }
    if (method === "deleteMessage") {
      this.messages.delete(Number(body.message_id));
      this.respond(response, true);
      return;
    }
    this.respond(response, ["answerCallbackQuery", "setMyCommands", "setChatMenuButton", "sendChatAction"].includes(method));
  }

  respond(response, result) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  }

  pushMessage(text, extra = {}) {
    const message = {
      message_id: this.nextIncomingMessageId++,
      from: { id: this.userId, is_bot: false, first_name: "E2E" },
      chat: { id: this.chatId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
      ...extra,
    };
    this.updates.push({ update_id: this.nextUpdateId++, message });
    return message;
  }

  pushCallback(data, sourceMessage) {
    const message = typeof sourceMessage === "number"
      ? this.messages.get(sourceMessage)
      : sourceMessage;
    if (!message) throw new Error(`Source message for callback ${data} is missing`);
    const callbackQuery = {
      id: `callback-${this.nextUpdateId}`,
      from: { id: this.userId, is_bot: false, first_name: "E2E" },
      message: structuredClone(message),
      data,
    };
    this.updates.push({ update_id: this.nextUpdateId++, callback_query: callbackQuery });
    return callbackQuery;
  }
}
