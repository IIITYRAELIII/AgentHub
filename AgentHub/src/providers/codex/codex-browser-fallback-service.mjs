import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_SNAPSHOT_CHARACTERS = 40_000;
const MAX_SELECTOR_CHARACTERS = 2_000;
const MAX_INPUT_CHARACTERS = 20_000;

function requiredText(value, name, maximumLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximumLength || text.includes("\0")) {
    throw new Error(`invalid browser ${name}`);
  }
  return text;
}

function boundedText(value, maximumLength = MAX_SNAPSHOT_CHARACTERS) {
  const text = String(value ?? "");
  return text.length <= maximumLength
    ? text
    : `${text.slice(0, maximumLength)}\n[truncated ${text.length - maximumLength} characters]`;
}

function safeUrl(value) {
  const source = requiredText(value, "URL", 8_192);
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("browser URL must be absolute");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("browser URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("browser URL must not contain credentials");
  }
  return parsed.href;
}

function sessionIdentity(context) {
  if (String(context?.provider ?? "").trim().toLowerCase() !== "codex") {
    throw new Error("browser fallback is available only to Codex");
  }
  const threadId = requiredText(context?.threadId, "Thread id", 300);
  const streamId = requiredText(context?.streamId, "Stream id", 300);
  return {
    key: `${streamId}\0${threadId}`,
    threadId,
    streamId,
  };
}

function sessionDirectory(dataDir, key) {
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return path.join(dataDir, "codex-browser-fallback", digest);
}

async function defaultLoadChromium() {
  const { chromium } = await import("playwright");
  return chromium;
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const settled = Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export class CodexBrowserFallbackService {
  #browser = null;
  #browserPromise = null;
  #closed = false;
  #lanes = new Map();
  #sessions = new Map();
  #sessionPromises = new Map();
  #sessionClosures = new Map();
  #browserClosures = new Map();
  #generation = 0;

  constructor({
    dataDir,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    loadChromium = defaultLoadChromium,
    launchOptions = {},
    logger = console,
  } = {}) {
    this.dataDir = path.resolve(requiredText(dataDir, "data directory", 2_000));
    this.operationTimeoutMs = Math.max(1, Math.trunc(Number(operationTimeoutMs) || DEFAULT_OPERATION_TIMEOUT_MS));
    this.cleanupTimeoutMs = Math.max(1, Math.trunc(Number(cleanupTimeoutMs) || DEFAULT_CLEANUP_TIMEOUT_MS));
    this.loadChromium = loadChromium;
    this.launchOptions = { channel: "msedge", headless: false, ...launchOptions };
    this.logger = logger;
  }

  diagnostics() {
    return {
      status: this.#closed ? "closed" : this.#browser ? "ready" : "idle",
      browserProcess: Boolean(this.#browser),
      sessions: this.#sessions.size,
      startingSessions: this.#sessionPromises.size,
      closingSessions: this.#sessionClosures.size,
      queuedContexts: this.#lanes.size,
    };
  }

  async invoke(context, args = {}) {
    const identity = sessionIdentity(context);
    const action = requiredText(args.action, "action", 30).toLowerCase();
    if (!["open", "navigate", "snapshot", "click", "fill", "press", "screenshot", "close"].includes(action)) {
      throw new Error(`unsupported browser action: ${action}`);
    }
    this.#validateAction(action, args);
    return this.#serialize(identity.key, async () => {
      if (action === "close") {
        const existed = this.#sessions.has(identity.key) || this.#sessionPromises.has(identity.key);
        await this.#closeSession(identity.key);
        return { action, closed: existed, provider: "codex", threadId: identity.threadId };
      }
      if (this.#closed) throw new Error("browser fallback is closed");
      await this.#sessionClosures.get(identity.key)?.promise;
      if (this.#closed) throw new Error("browser fallback is closed");
      const reused = this.#sessions.has(identity.key);
      return this.#withDeadline(identity.key, action, async () => {
        const session = await this.#getSession(identity);
        const result = await this.#perform(session, action, args);
        return {
          action,
          provider: "codex",
          threadId: identity.threadId,
          sessionReused: reused,
          ...result,
        };
      });
    });
  }

  async closeForThread(threadId) {
    const target = String(threadId ?? "").trim();
    if (!target) return false;
    const keys = [...this.#sessions.entries()]
      .filter(([, session]) => session.threadId === target)
      .map(([key]) => key);
    for (const [key, pending] of this.#sessionPromises) {
      if (pending.threadId === target && !keys.includes(key)) keys.push(key);
    }
    const activeClosures = [...this.#sessionClosures.values()]
      .filter((entry) => entry.threadId === target)
      .map((entry) => entry.promise);
    await Promise.all([...keys.map((key) => this.#closeSession(key)), ...activeClosures]);
    return keys.length > 0 || activeClosures.length > 0;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#closeResources();
  }

  async reset() {
    if (this.#closed) return;
    await this.#closeResources();
  }

  async #closeResources() {
    this.#generation += 1;
    const browser = this.#browser;
    const browserPromise = this.#browserPromise;
    this.#browser = null;
    this.#browserPromise = null;
    const keys = new Set([...this.#sessions.keys(), ...this.#sessionPromises.keys()]);
    await Promise.all([...keys].map((key) => this.#closeSession(key)));
    await Promise.all([...this.#sessionClosures.values()].map((entry) => entry.promise));
    const pendingBrowser = browserPromise
      ? await settleWithin(browserPromise, this.cleanupTimeoutMs)
      : null;
    const resolvedBrowser = browser ?? (pendingBrowser?.status === "fulfilled" ? pendingBrowser.value : null);
    if (resolvedBrowser) await this.#retireBrowser(resolvedBrowser, "shutdown");
  }

  async #serialize(key, operation) {
    const previous = this.#lanes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#lanes.set(key, current);
    try {
      return await current;
    } finally {
      if (this.#lanes.get(key) === current) this.#lanes.delete(key);
    }
  }

  async #browserInstance() {
    if (this.#closed) throw new Error("browser fallback is closed");
    if (this.#browser?.isConnected?.()) return this.#browser;
    if (this.#browserPromise) return this.#browserPromise;
    const generation = this.#generation;
    const launchPromise = (async () => {
      const chromium = await this.loadChromium();
      const browser = await chromium.launch({
        ...this.launchOptions,
        timeout: this.operationTimeoutMs,
      });
      if (this.#closed || generation !== this.#generation) {
        await this.#retireBrowser(browser, "cancelled launch");
        throw new Error(this.#closed ? "browser fallback is closed" : "browser launch was cancelled");
      }
      browser.on?.("disconnected", () => {
        if (this.#browser === browser) this.#browser = null;
        for (const [key, session] of this.#sessions) {
          if (session.browser !== browser) continue;
          this.#sessions.delete(key);
          void rm(session.root, { recursive: true, force: true }).catch(() => {});
        }
      });
      this.#browser = browser;
      return browser;
    })();
    this.#browserPromise = launchPromise;
    try {
      return await launchPromise;
    } finally {
      if (this.#browserPromise === launchPromise) this.#browserPromise = null;
    }
  }

  async #getSession(identity) {
    const existing = this.#sessions.get(identity.key);
    if (existing && !existing.page.isClosed?.()) return existing;
    const pending = this.#sessionPromises.get(identity.key);
    if (pending) return pending.promise;
    const root = sessionDirectory(this.dataDir, identity.key);
    const entry = {
      cancelled: false,
      threadId: identity.threadId,
      promise: null,
    };
    entry.promise = (async () => {
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });
        const browser = await this.#browserInstance();
        const browserContext = await browser.newContext({
          acceptDownloads: false,
          serviceWorkers: "block",
        });
        const page = await browserContext.newPage();
        if (this.#closed || entry.cancelled) {
          await this.#closeContext(browserContext, browser, root);
          throw new Error(this.#closed ? "browser fallback is closed" : "browser session was cancelled");
        }
        page.setDefaultTimeout(this.operationTimeoutMs);
        page.setDefaultNavigationTimeout(this.operationTimeoutMs);
        const session = {
          browser,
          browserContext,
          page,
          root,
          threadId: identity.threadId,
          streamId: identity.streamId,
          screenshotSequence: 0,
        };
        this.#sessions.set(identity.key, session);
        return session;
      })();
    this.#sessionPromises.set(identity.key, entry);
    try {
      return await entry.promise;
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      if (this.#sessionPromises.get(identity.key) === entry) this.#sessionPromises.delete(identity.key);
    }
  }

  async #withDeadline(key, action, operation) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Codex browser ${action} timed out after ${this.operationTimeoutMs} ms`);
        error.code = "CODEX_BROWSER_TIMEOUT";
        reject(error);
        void this.#closeSession(key).catch((cleanupError) => {
          this.logger.warn?.("Cannot clean timed out Codex browser fallback session:", cleanupError.message);
        });
      }, this.operationTimeoutMs);
    });
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #perform(session, action, args) {
    let page = await this.#normalizePages(session);
    if (action === "open" || action === "navigate") {
      await page.goto(safeUrl(args.url), { waitUntil: "domcontentloaded", timeout: this.operationTimeoutMs });
      page = await this.#normalizePages(session);
      return this.#snapshot(page);
    }
    if (action === "click") {
      await page.locator(requiredText(args.selector, "selector", MAX_SELECTOR_CHARACTERS)).click({
        timeout: this.operationTimeoutMs,
      });
      page = await this.#normalizePages(session);
      return this.#snapshot(page);
    }
    if (action === "fill") {
      const selector = requiredText(args.selector, "selector", MAX_SELECTOR_CHARACTERS);
      const text = String(args.text ?? "");
      if (text.length > MAX_INPUT_CHARACTERS || text.includes("\0")) throw new Error("invalid browser input text");
      await page.locator(selector).fill(text, { timeout: this.operationTimeoutMs });
      page = await this.#normalizePages(session);
      return this.#snapshot(page);
    }
    if (action === "press") {
      const selector = requiredText(args.selector, "selector", MAX_SELECTOR_CHARACTERS);
      const key = requiredText(args.key, "key", 100);
      await page.locator(selector).press(key, { timeout: this.operationTimeoutMs });
      page = await this.#normalizePages(session);
      return this.#snapshot(page);
    }
    if (action === "screenshot") {
      session.screenshotSequence += 1;
      const screenshotPath = path.join(session.root, `screenshot-${session.screenshotSequence}.png`);
      await page.screenshot({ path: screenshotPath, type: "png", fullPage: false, timeout: this.operationTimeoutMs });
      return { ...(await this.#snapshot(page)), screenshotPath };
    }
    return this.#snapshot(page);
  }

  #validateAction(action, args) {
    if (action === "open" || action === "navigate") safeUrl(args.url);
    if (["click", "fill", "press"].includes(action)) {
      requiredText(args.selector, "selector", MAX_SELECTOR_CHARACTERS);
    }
    if (action === "fill") {
      const text = String(args.text ?? "");
      if (text.length > MAX_INPUT_CHARACTERS || text.includes("\0")) throw new Error("invalid browser input text");
    }
    if (action === "press") requiredText(args.key, "key", 100);
  }

  async #snapshot(page) {
    const locator = page.locator("body");
    let snapshot;
    try {
      snapshot = await locator.ariaSnapshot({ timeout: this.operationTimeoutMs });
    } catch {
      snapshot = await locator.innerText({ timeout: this.operationTimeoutMs });
    }
    return {
      url: boundedText(page.url(), 8_192),
      title: boundedText(await page.title(), 1_000),
      snapshot: boundedText(snapshot),
    };
  }

  async #normalizePages(session) {
    const pages = session.browserContext.pages?.() ?? [session.page];
    const livePages = pages.filter((page) => !page.isClosed?.());
    const selected = livePages.at(-1) ?? session.page;
    if (selected !== session.page) {
      selected.setDefaultTimeout?.(this.operationTimeoutMs);
      selected.setDefaultNavigationTimeout?.(this.operationTimeoutMs);
      session.page = selected;
    }
    for (const page of livePages) {
      if (page === selected) continue;
      const result = await settleWithin(page.close?.(), this.cleanupTimeoutMs);
      if (result.status !== "fulfilled") {
        this.logger.warn?.("Cannot close duplicate Codex browser fallback page");
      }
    }
    return selected;
  }

  async #closeSession(key) {
    const existingClosure = this.#sessionClosures.get(key);
    if (existingClosure) return existingClosure.promise;
    const threadId = this.#sessions.get(key)?.threadId
      ?? this.#sessionPromises.get(key)?.threadId
      ?? null;
    const entry = { threadId, promise: null };
    entry.promise = this.#closeSessionResources(key);
    this.#sessionClosures.set(key, entry);
    try {
      return await entry.promise;
    } finally {
      if (this.#sessionClosures.get(key) === entry) this.#sessionClosures.delete(key);
    }
  }

  async #closeSessionResources(key) {
    const pending = this.#sessionPromises.get(key);
    if (pending) {
      pending.cancelled = true;
      this.#sessionPromises.delete(key);
    }
    const pendingResult = pending
      ? await settleWithin(pending.promise, this.cleanupTimeoutMs)
      : null;
    const session = this.#sessions.get(key)
      ?? (pendingResult?.status === "fulfilled" ? pendingResult.value : null);
    this.#sessions.delete(key);
    if (!session) return false;
    await this.#closeContext(session.browserContext, session.browser, session.root);
    return true;
  }

  async #closeContext(browserContext, browser, root) {
    const closeResult = await settleWithin(browserContext.close(), this.cleanupTimeoutMs);
    if (closeResult.status !== "fulfilled") {
      const reason = closeResult.status === "rejected" ? closeResult.reason?.message : "deadline exceeded";
      this.logger.warn?.("Cannot close Codex browser fallback context:", reason);
      await this.#retireBrowser(browser, "context cleanup failure");
    }
    const removeResult = await settleWithin(rm(root, { recursive: true, force: true }), this.cleanupTimeoutMs);
    if (removeResult.status !== "fulfilled") {
      const reason = removeResult.status === "rejected" ? removeResult.reason?.message : "deadline exceeded";
      this.logger.warn?.("Cannot remove Codex browser fallback state:", reason);
    }
  }

  async #retireBrowser(browser, reason) {
    const existing = this.#browserClosures.get(browser);
    if (existing) return existing;
    if (this.#browser === browser) this.#browser = null;
    const roots = [];
    for (const [key, session] of this.#sessions) {
      if (session.browser !== browser) continue;
      this.#sessions.delete(key);
      roots.push(session.root);
    }
    const closure = (async () => {
      const closeResult = await settleWithin(browser.close?.(), this.cleanupTimeoutMs);
      if (closeResult.status !== "fulfilled") {
        const detail = closeResult.status === "rejected" ? closeResult.reason?.message : "deadline exceeded";
        this.logger.warn?.(`Cannot retire Codex browser fallback process after ${reason}:`, detail);
      }
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => {})));
    })();
    this.#browserClosures.set(browser, closure);
    try {
      await closure;
    } finally {
      this.#browserClosures.delete(browser);
    }
  }
}

export const CODEX_BROWSER_FALLBACK_ACTIONS = Object.freeze([
  "open", "navigate", "snapshot", "click", "fill", "press", "screenshot", "close",
]);
