import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { processIsAlive, stopProcessTree } from "../src/providers/claude/claude-run-io.mjs";
import { readRuntimeState } from "../src/infrastructure/persistence/runtime-state-store.mjs";
import { LoopbackTelegramApi } from "../src/infrastructure/network/loopback-telegram-api.mjs";

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

export class FakeTelegramApi extends LoopbackTelegramApi {
  constructor() {
    super({ userId: USER_ID, chatId: CHAT_ID });
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
