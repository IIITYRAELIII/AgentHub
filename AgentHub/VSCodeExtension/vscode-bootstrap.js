"use strict";

const vscode = window.acquireVsCodeApi();
window.__agentHubVscode = vscode;
const nativeFetch = window.fetch.bind(window);
const pending = new Map();
const pendingHealth = new Map();
const pendingSessions = new Map();
let sequence = 0;
const HEALTH_CONTROL_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 5_000;
const SESSION_REFRESH_MARGIN_MS = 30_000;
const EVENT_RECONNECT_MS = 1_500;
let directSession = null;
let directSessionRequest = null;
let eventAbort = null;
let motionResumeFrame = 0;

const MOTION_TARGET_SELECTOR = [
  ".rain",
  ".motes",
  ".stream-tab[data-running]",
  ".stream-tab[data-answer-ready]",
  ".task-workspace-item[data-running]",
  ".task-workspace-item[data-unread]",
].join(",");

function resumeWebviewMotion() {
  if (document.hidden) return;
  for (const animation of document.getAnimations?.() ?? []) {
    if (animation.playState !== "paused") continue;
    try {
      animation.play();
    } catch {
      // A detached effect disappears on the next render; it needs no recovery.
    }
  }
}

function scheduleWebviewMotionResume() {
  if (document.hidden || motionResumeFrame) return;
  motionResumeFrame = window.requestAnimationFrame(() => {
    motionResumeFrame = 0;
    resumeWebviewMotion();
  });
}

function mutationAddsMotion(record) {
  if (record.type === "attributes") return true;
  return [...record.addedNodes].some((node) => (
    node?.matches?.(MOTION_TARGET_SELECTOR)
    || node?.querySelector?.(MOTION_TARGET_SELECTOR)
  ));
}

const motionObserver = new MutationObserver((records) => {
  if (records.some(mutationAddsMotion)) scheduleWebviewMotionResume();
});
motionObserver.observe(document.body, {
  attributeFilter: ["data-running", "data-answer-ready", "data-unread"],
  attributes: true,
  childList: true,
  subtree: true,
});

window.addEventListener("focus", resumeWebviewMotion);
window.addEventListener("pageshow", resumeWebviewMotion);
window.addEventListener("load", resumeWebviewMotion, { once: true });
document.addEventListener("visibilitychange", resumeWebviewMotion);
window.addEventListener("pagehide", () => motionObserver.disconnect(), { once: true });

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "agenthub:session-result") {
    const request = pendingSessions.get(String(message.id ?? ""));
    if (!request) return;
    pendingSessions.delete(String(message.id));
    window.clearTimeout(request.timer);
    request.resolve(message.ok ? message.result ?? null : null);
    return;
  }
  if (message?.type === "agenthub:control-result") {
    const request = pendingHealth.get(String(message.id ?? ""));
    if (!request) return;
    pendingHealth.delete(String(message.id));
    window.clearTimeout(request.timer);
    request.resolve(new Response(`${JSON.stringify(
      message.ok ? message.result ?? {} : { error: String(message.error ?? "Agent Hub недоступен") },
    )}\n`, {
      status: message.ok ? 200 : 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }));
    return;
  }
  if (!["agenthub:http-start", "agenthub:http-chunk", "agenthub:http-result"].includes(message?.type)) {
    return;
  }
  const request = pending.get(String(message.id ?? ""));
  if (!request) return;
  if (message.type === "agenthub:http-start") {
    request.transfer = {
      status: Number(message.status) || 500,
      headers: message.headers ?? { "Content-Type": "application/json; charset=utf-8" },
      chunkCount: Number(message.chunkCount) || 0,
      chunks: [],
      received: 0,
    };
    return;
  }
  if (message.type === "agenthub:http-chunk") {
    if (!request.transfer) return;
    const index = Number(message.index);
    if (!Number.isInteger(index) || index < 0 || index >= request.transfer.chunkCount) return;
    if (typeof request.transfer.chunks[index] !== "string") request.transfer.received += 1;
    request.transfer.chunks[index] = String(message.body ?? "");
    return;
  }
  pending.delete(String(message.id));
  window.clearTimeout(request.timer);
  if (message.chunked === true) {
    const transfer = request.transfer;
    if (!transfer || transfer.received !== transfer.chunkCount) {
      request.reject(new Error("Журнал в VS Code получен не полностью"));
      return;
    }
    request.resolve(new Response(transfer.chunks.join(""), {
      status: transfer.status,
      headers: transfer.headers,
    }));
    return;
  }
  request.resolve(new Response(String(message.body ?? ""), {
    status: Number(message.status) || 500,
    headers: message.headers ?? { "Content-Type": "application/json; charset=utf-8" },
  }));
});

function requestDirectSession() {
  const id = `session-${Date.now()}-${++sequence}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingSessions.delete(id);
      resolve(null);
    }, SESSION_TIMEOUT_MS);
    pendingSessions.set(id, { resolve, timer });
    vscode.postMessage({ type: "agenthub:session", id });
  });
}

async function ensureDirectSession({ force = false } = {}) {
  if (
    !force
    && directSession
    && Number(directSession.expiresAt) - Date.now() > SESSION_REFRESH_MARGIN_MS
  ) return directSession;
  if (!directSessionRequest) {
    directSessionRequest = requestDirectSession()
      .then((value) => {
        directSession = value?.baseUrl && value?.token ? value : null;
        return directSession;
      })
      .finally(() => { directSessionRequest = null; });
  }
  return directSessionRequest;
}

function directRequestUrl(session, url) {
  return `${String(session.baseUrl).replace(/\/+$/u, "")}${url.pathname}${url.search}`;
}

async function directFetch(url, init = {}, retry = true) {
  const session = await ensureDirectSession();
  if (!session) return null;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `webview ${session.token}`);
  const response = await nativeFetch(directRequestUrl(session, url), {
    ...init,
    headers,
    credentials: "omit",
  });
  if (response.status === 401 && retry) {
    directSession = null;
    await ensureDirectSession({ force: true });
    return directFetch(url, init, false);
  }
  return response;
}

function runtimeHealth() {
  const id = `health-${Date.now()}-${++sequence}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingHealth.delete(id);
      resolve(new Response(`${JSON.stringify({ error: "Agent Hub недоступен" })}\n`, {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }));
    }, HEALTH_CONTROL_TIMEOUT_MS);
    pendingHealth.set(id, { resolve, timer });
    vscode.postMessage({
      type: "agenthub:control",
      id,
      action: "runtime-health",
      params: {},
    });
  });
}

function fallbackRequestBody(init) {
  if (init.body == null) return "";
  if (typeof init.body === "string") return init.body;
  if (init.body instanceof URLSearchParams) return init.body.toString();
  return "";
}

function fallbackFetch(url, input, init) {
  if (url.pathname === "/health") return runtimeHealth();
  if (!url.pathname.startsWith("/api/journal")
    && url.pathname !== "/api/rate-limits") {
    return nativeFetch(input, init);
  }
  const id = `http-${Date.now()}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("Журнал в VS Code не ответил вовремя"));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    vscode.postMessage({
      type: "agenthub:http",
      id,
      method: String(init.method ?? "GET"),
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: fallbackRequestBody(init),
    });
  });
}

window.fetch = async function agentHubFetch(input, init = {}) {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const url = new URL(raw, window.location.href);
  const hubRequest = raw.startsWith("/")
    && (url.pathname === "/health" || url.pathname === "/events" || url.pathname.startsWith("/api/"));
  if (!hubRequest) return nativeFetch(input, init);
  return await directFetch(url, init) ?? fallbackFetch(url, input, init);
};

function parseEventBlock(block) {
  let type = "message";
  const data = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) type = line.slice(6).trim() || "message";
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { type, data: data.join("\n") };
}

async function streamDirectEvents() {
  while (!eventAbort?.signal.aborted) {
    try {
      const session = await ensureDirectSession();
      if (!session) return;
      const response = await nativeFetch(`${String(session.baseUrl).replace(/\/+$/u, "")}/events`, {
        headers: { Authorization: `webview ${session.token}` },
        credentials: "omit",
        signal: eventAbort.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Agent Hub events: HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (!eventAbort.signal.aborted) {
        const { value, done } = await reader.read();
        buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        let boundary = buffered.search(/\r?\n\r?\n/u);
        while (boundary >= 0) {
          const separator = buffered.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? "\n\n";
          const event = parseEventBlock(buffered.slice(0, boundary));
          buffered = buffered.slice(boundary + separator.length);
          if (event.type === "journal") {
            window.postMessage({ type: "agenthub:journal-changed", force: false }, "*");
          }
          boundary = buffered.search(/\r?\n\r?\n/u);
        }
        if (done) break;
      }
    } catch (error) {
      if (eventAbort?.signal.aborted) return;
      console.warn("Agent Hub VS Code events disconnected", error);
    }
    await new Promise((resolve) => window.setTimeout(resolve, EVENT_RECONNECT_MS));
  }
}

window.__agentHubDirectTransport = {
  available: async () => Boolean(await ensureDirectSession()),
};

void ensureDirectSession().then((session) => {
  if (!session) return;
  eventAbort = new AbortController();
  void streamDirectEvents();
});

window.addEventListener("pagehide", () => eventAbort?.abort(), { once: true });
