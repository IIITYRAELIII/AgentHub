import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { processIsAlive, stopProcessTree } from "../claude-run-io.mjs";
import { readRuntimeState } from "../runtime-state-store.mjs";

// Общая обвязка E2E: поддельный Telegram Bot API и ожидания. Используется и
// сценарием Codex, и матрицей параллельных задач Claude.

export const USER_ID = 42;
export const CHAT_ID = 84;

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function e2eTimeoutMs(timeoutMs, {
  platform = process.platform,
  environment = process.env,
} = {}) {
  const configured = Number(environment.TELEGRAM_E2E_TIMEOUT_MULTIPLIER);
  const multiplier = Number.isFinite(configured) && configured > 0
    ? configured
    : platform === "win32" ? 3 : 1;
  return Math.ceil(timeoutMs * multiplier);
}

export async function waitFor(check, description, timeoutMs = 8_000) {
  const effectiveTimeoutMs = e2eTimeoutMs(timeoutMs);
  const deadline = Date.now() + effectiveTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `Timeout waiting for ${description} after ${effectiveTimeoutMs} ms`
      + `${lastError ? `: ${lastError.message}` : ""}`,
  );
}

export async function readJson(filePath) {
  if (path.basename(filePath).toLowerCase() === "state.json") {
    const state = await readRuntimeState(path.dirname(filePath), { legacyFile: filePath });
    if (state) return state;
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function readLockPid(filePath) {
  const raw = String(await readFile(filePath, "utf8")).trim();
  try {
    const parsed = JSON.parse(raw);
    return Number.isSafeInteger(parsed) ? parsed : Number(parsed?.pid);
  } catch {
    return Number(raw);
  }
}

export async function stopPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const stopped = await Promise.race([
    stopProcessTree(pid).catch(() => false),
    delay(e2eTimeoutMs(2_000)).then(() => false),
  ]);
  if (!stopped && processIsAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + e2eTimeoutMs(2_000);
  while (Date.now() < deadline && processIsAlive(pid)) await delay(25);
  if (processIsAlive(pid)) throw new Error(`Process ${pid} did not stop`);
}

export class FakeTelegramApi {
  constructor() {
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
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address.port}`;
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
      try { body = JSON.parse(rawBody); } catch { body = {}; }
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
      this.respond(response, { file_path: "e2e/fake-image.jpg" });
      return;
    }
    if (method === "sendMessage" || method === "sendPhoto") {
      const message = {
        message_id: this.nextOutgoingMessageId++,
        chat: { id: Number(body.chat_id ?? CHAT_ID), type: "private" },
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
        chat: { id: Number(body.chat_id ?? CHAT_ID), type: "private" },
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
        chat: { id: Number(body.chat_id ?? CHAT_ID), type: "private" },
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
    this.respond(response, method === "answerCallbackQuery" || method === "setMyCommands" || method === "sendChatAction");
  }

  respond(response, result) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  }

  pushMessage(text, extra = {}) {
    const message = {
      message_id: this.nextIncomingMessageId++,
      from: { id: USER_ID, is_bot: false, first_name: "E2E" },
      chat: { id: CHAT_ID, type: "private" },
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
    assert.ok(message, `source message for callback ${data} must exist`);
    const callbackQuery = {
      id: `callback-${this.nextUpdateId}`,
      from: { id: USER_ID, is_bot: false, first_name: "E2E" },
      message: structuredClone(message),
      data,
    };
    this.updates.push({ update_id: this.nextUpdateId++, callback_query: callbackQuery });
    return callbackQuery;
  }

  callsAfter(index, method = null) {
    return this.calls.slice(index).filter((call) => !method || call.method === method);
  }

  recentCalls(after = 0, limit = 12) {
    return this.calls.slice(after).slice(-limit).map((call) => ({
      method: call.method,
      text: String(call.body?.text ?? call.body?.caption ?? "").slice(0, 240),
      completed: Boolean(call.result),
    }));
  }

  async waitForCall(method, predicate = () => true, { after = 0, timeoutMs = 8_000 } = {}) {
    try {
      return await waitFor(
        () => this.callsAfter(after, method).find((call) => predicate(call)),
        `${method} call`,
        timeoutMs,
      );
    } catch (error) {
      throw new Error(
        `${error.message}\nRecent Telegram calls:\n${JSON.stringify(this.recentCalls(after), null, 2)}`,
        { cause: error },
      );
    }
  }

  // Живой прогресс приходит правкой карточки, а не новым сообщением.
  async waitForVisibleText(fragment, { after = 0, timeoutMs = 8_000 } = {}) {
    try {
      return await waitFor(
        () => this.calls.slice(after).find((call) => (
          (call.method === "sendMessage" || call.method === "editMessageText")
            && String(call.body.text ?? "").includes(fragment)
        )),
        `visible text «${fragment}»`,
        timeoutMs,
      );
    } catch (error) {
      throw new Error(
        `${error.message}\nRecent Telegram calls:\n${JSON.stringify(this.recentCalls(after), null, 2)}`,
        { cause: error },
      );
    }
  }

  async waitForText(fragment, options = {}) {
    return this.waitForCall(
      "sendMessage",
      (call) => Boolean(call.result) && String(call.body.text ?? "").includes(fragment),
      options,
    );
  }
}
