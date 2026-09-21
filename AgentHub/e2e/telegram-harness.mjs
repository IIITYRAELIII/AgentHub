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

export function childProcessTerminal(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

function diagnosticTail(value, maxLength = 32_768) {
  const text = String(value ?? "")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/gu, "[redacted-token]")
    .replace(/\b(bearer)(\s+)\S+/giu, "$1$2[redacted]")
    .replace(/(authorization|cookie|token|secret|password|api[-_ ]?key)(\s*[:=]\s*)\S+/giu,
      "$1$2[redacted]");
  return text.length <= maxLength ? text : text.slice(-maxLength);
}

export class E2eChildProcessOwner {
  #current = null;
  #generation = 0;
  #history = [];
  #label;
  #stopPid;
  #timeoutMs;
  #delay;

  constructor({
    label = "E2E child process",
    stopPidImpl = stopPid,
    timeoutMs = 2_000,
    delayImpl = delay,
  } = {}) {
    this.#label = label;
    this.#stopPid = stopPidImpl;
    this.#timeoutMs = timeoutMs;
    this.#delay = delayImpl;
  }

  get child() {
    return this.#current?.child ?? null;
  }

  start(spawnChild) {
    if (this.#current) {
      if (!this.#terminal(this.#current)) {
        throw new Error(`${this.#label} generation ${this.#current.generation} is still running`);
      }
      this.#archive(this.#current);
      this.#current = null;
    }

    const generation = ++this.#generation;
    let child;
    try {
      child = spawnChild();
    } catch (error) {
      throw new Error(`${this.#label} generation ${generation} failed to spawn: ${error.message}`, {
        cause: error,
      });
    }
    if (!child || typeof child.once !== "function") {
      throw new TypeError(`${this.#label} generation ${generation} returned no child process`);
    }

    const record = {
      generation,
      child,
      pid: Number.isSafeInteger(child.pid) ? child.pid : null,
      spawnError: null,
      exit: null,
      close: null,
      stderr: "",
      endpointOwner: null,
    };
    this.#current = record;
    child.once("error", (error) => {
      record.spawnError = {
        name: String(error?.name ?? "Error"),
        message: diagnosticTail(error?.message),
        code: error?.code ?? null,
      };
    });
    child.once("exit", (code, signal) => {
      record.exit = { code: code ?? null, signal: signal ?? null };
    });
    child.once("close", (code, signal) => {
      record.close = { code: code ?? null, signal: signal ?? null };
    });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      record.stderr = diagnosticTail(`${record.stderr}${chunk}`);
    });
    return child;
  }

  recordEndpointOwner(value) {
    if (!this.#current) return;
    this.#current.endpointOwner = value && typeof value === "object" ? {
      pid: Number.isSafeInteger(value.pid) ? value.pid : null,
      releaseId: String(value.releaseId ?? ""),
      instanceId: String(value.instanceId ?? ""),
      status: String(value.status ?? ""),
    } : null;
  }

  diagnostics(extra = {}) {
    const record = this.#current ?? null;
    const latestRecord = record ?? this.#history.at(-1) ?? null;
    const latest = latestRecord ? this.#snapshot(latestRecord) : null;
    return {
      label: this.#label,
      generation: latest?.generation ?? this.#generation,
      pid: latest?.pid ?? null,
      exitCode: latest?.exitCode ?? null,
      signalCode: latest?.signalCode ?? null,
      exit: latest?.exit ?? null,
      close: latest?.close ?? null,
      spawnError: latest?.spawnError ?? null,
      endpointOwner: latest?.endpointOwner ?? null,
      stderr: latest?.stderr ?? "",
      generations: [
        ...this.#history.map((item) => this.#snapshot(item)),
        ...(record ? [this.#snapshot(record)] : []),
      ],
      ...extra,
    };
  }

  failure(error, extra = {}) {
    return new Error(
      `${error.message}\n${this.#label} diagnostics:\n${JSON.stringify(this.diagnostics(extra), null, 2)}`,
      { cause: error },
    );
  }

  async stop() {
    const record = this.#current;
    if (!record) return null;

    if (!this.#terminal(record)) {
      await this.#waitAfter(record, () => record.child.kill("SIGTERM"));
    }
    if (!this.#terminal(record)) {
      await this.#waitAfter(record, () => this.#stopPid(record.pid));
    }
    if (!this.#terminal(record)) {
      throw new Error(
        `${this.#label} generation ${record.generation} did not stop; ownership retained\n`
          + JSON.stringify(this.diagnostics(), null, 2),
      );
    }

    const result = this.#snapshot(record);
    this.#archive(record);
    if (this.#current === record) this.#current = null;
    return result;
  }

  #snapshot(record) {
    return {
      generation: record.generation,
      pid: record.pid,
      exitCode: record.child?.exitCode ?? null,
      signalCode: record.child?.signalCode ?? null,
      exit: record.exit,
      close: record.close,
      spawnError: record.spawnError,
      endpointOwner: record.endpointOwner,
      stderr: record.stderr,
    };
  }

  #archive(record) {
    this.#history.push(record);
    if (this.#history.length > 16) this.#history.shift();
  }

  #terminal(record) {
    return childProcessTerminal(record.child)
      || (record.spawnError !== null && !Number.isSafeInteger(record.pid));
  }

  async #waitAfter(record, action) {
    if (this.#terminal(record)) return true;
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const onTerminal = () => settle(true);
    record.child.once("exit", onTerminal);
    record.child.once("close", onTerminal);
    record.child.once("error", onTerminal);
    try {
      if (this.#terminal(record)) return true;
      await action();
      if (this.#terminal(record)) return true;
      await Promise.race([
        settled,
        this.#delay(this.#timeoutMs).then(() => false),
      ]);
      return this.#terminal(record);
    } finally {
      record.child.off("exit", onTerminal);
      record.child.off("close", onTerminal);
      record.child.off("error", onTerminal);
    }
  }
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
