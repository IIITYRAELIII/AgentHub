"use strict";

const nativeVscode = window.acquireVsCodeApi();
const commandAliases = new Map();
const nativeVscodePostMessage = nativeVscode.postMessage.bind(nativeVscode);
const vscode = Object.freeze({
  postMessage(message, transfer) {
    const clientUserMessageId = message?.type === "agenthub:control"
      && message?.action === "send-message"
      ? String(message.params?.clientUserMessageId ?? "").trim()
      : "";
    return nativeVscodePostMessage(clientUserMessageId
      ? { ...message, commandId: clientUserMessageId }
      : message, transfer);
  },
  ...(typeof nativeVscode.getState === "function"
    ? { getState: nativeVscode.getState.bind(nativeVscode) }
    : {}),
  ...(typeof nativeVscode.setState === "function"
    ? { setState: nativeVscode.setState.bind(nativeVscode) }
    : {}),
});
window.__agentHubVscode = vscode;
const nativeFetch = window.fetch.bind(window);
const pending = new Map();
const pendingHealth = new Map();
const pendingSessions = new Map();
let sequence = 0;
const HEALTH_CONTROL_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 5_000;
const SESSION_REFRESH_MARGIN_MS = 30_000;
let directSession = null;
let directSessionRequest = null;
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
    !node?.closest?.("[data-journal]")
    && (
    node?.matches?.(MOTION_TARGET_SELECTOR)
    || node?.querySelector?.(MOTION_TARGET_SELECTOR)
    )
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
  request.cleanup?.();
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

function activeDirectSession() {
  if (!directSession?.baseUrl || !directSession?.token) return null;
  return Number(directSession.expiresAt) > Date.now() ? directSession : null;
}

function rememberCommandAlias(alias, commandId) {
  if (!alias || !commandId || alias === commandId) return;
  if (commandAliases.has(alias)) commandAliases.delete(alias);
  commandAliases.set(alias, commandId);
  while (commandAliases.size > 500) commandAliases.delete(commandAliases.keys().next().value);
}

function canonicalDirectControl(url, init) {
  if (String(init.method ?? "GET").toUpperCase() !== "POST") return { init, receiptAlias: "" };
  if (!["/api/control", "/api/control/ack"].includes(url.pathname)) {
    return { init, receiptAlias: "" };
  }
  try {
    const body = JSON.parse(String(init.body ?? "{}"));
    if (url.pathname === "/api/control") {
      const clientUserMessageId = body.action === "send-message"
        ? String(body.params?.clientUserMessageId ?? "").trim()
        : "";
      if (!clientUserMessageId) return { init, receiptAlias: "" };
      const receiptAlias = String(body.commandId ?? "").trim();
      rememberCommandAlias(receiptAlias, clientUserMessageId);
      return {
        init: { ...init, body: JSON.stringify({ ...body, commandId: clientUserMessageId }) },
        receiptAlias,
      };
    }
    const alias = String(body.commandId ?? "").trim();
    const commandId = commandAliases.get(alias);
    if (!commandId) return { init, receiptAlias: "" };
    return {
      init: { ...init, body: JSON.stringify({ ...body, commandId }) },
      receiptAlias: alias,
    };
  } catch {
    return { init, receiptAlias: "" };
  }
}

async function clientControlResponse(url, response, receiptAlias) {
  if (!receiptAlias || url.pathname !== "/api/control") return response;
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") return response;
  if (payload.receiptId) payload.receiptId = receiptAlias;
  return new Response(`${JSON.stringify(payload)}\n`, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function directFetch(url, init = {}, retry = true) {
  const session = activeDirectSession();
  if (!session) {
    void ensureDirectSession();
    return null;
  }
  if (Number(session.expiresAt) - Date.now() <= SESSION_REFRESH_MARGIN_MS) {
    void ensureDirectSession();
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `webview ${session.token}`);
  const control = canonicalDirectControl(url, { ...init, headers });
  const response = await nativeFetch(directRequestUrl(session, url), {
    ...control.init,
    credentials: "omit",
  });
  if (response.status === 401 && retry) {
    directSession = null;
    await ensureDirectSession({ force: true });
    return directFetch(url, init, false);
  }
  const result = await clientControlResponse(url, response, control.receiptAlias);
  if (url.pathname === "/api/control/ack" && control.receiptAlias && result.ok) {
    commandAliases.delete(control.receiptAlias);
  }
  return result;
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

window.__agentHubIpcRuntimeHealth = runtimeHealth;

function fallbackRequestBody(init) {
  if (init.body == null) return "";
  if (typeof init.body === "string") return init.body;
  if (init.body instanceof URLSearchParams) return init.body.toString();
  return "";
}

async function fallbackFetch(url, input, init) {
  if (url.pathname === "/health") return runtimeHealth();
  const attachmentUpload = url.pathname === "/api/attachment-upload";
  if (!url.pathname.startsWith("/api/journal")
    && url.pathname !== "/api/rate-limits" && !attachmentUpload) {
    return nativeFetch(input, init);
  }
  init.signal?.throwIfAborted();
  let body = fallbackRequestBody(init);
  let bodyEncoding;
  if (attachmentUpload && String(init.method).toUpperCase() === "PUT") {
    const chunk = init.body;
    if (!chunk || !Number.isSafeInteger(chunk.size) || chunk.size < 1
      || chunk.size > 1024 * 1024 || typeof chunk.arrayBuffer !== "function") {
      throw new Error("Некорректная часть вложения: максимум 1 МиБ");
    }
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    body = btoa(binary);
    bodyEncoding = "base64";
  }
  init.signal?.throwIfAborted();
  const id = `http-${Date.now()}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const cleanup = () => init.signal?.removeEventListener("abort", abort);
    const abort = () => {
      pending.delete(id);
      window.clearTimeout(timer);
      cleanup();
      reject(init.signal.reason);
    };
    const timer = window.setTimeout(() => {
      pending.delete(id);
      cleanup();
      reject(new Error(attachmentUpload ? "Загрузка в VS Code не ответила вовремя" : "Журнал в VS Code не ответил вовремя"));
    }, 30_000);
    pending.set(id, { resolve, reject, timer, cleanup });
    init.signal?.addEventListener("abort", abort, { once: true });
    vscode.postMessage({
      type: "agenthub:http",
      id,
      method: String(init.method ?? "GET"),
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body,
      ...(bodyEncoding ? { bodyEncoding } : {}),
    });
  });
}

window.fetch = async function agentHubFetch(input, init = {}) {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const url = new URL(raw, window.location.href);
  const hubRequest = raw.startsWith("/")
    && (url.pathname === "/health" || url.pathname.startsWith("/api/"));
  if (!hubRequest) return nativeFetch(input, init);
  return await directFetch(url, init) ?? fallbackFetch(url, input, init);
};

window.__agentHubDirectTransport = {
  available: async () => Boolean(activeDirectSession() ?? await ensureDirectSession()),
  ready: () => Boolean(activeDirectSession()),
  warmup: () => { void ensureDirectSession(); },
};

void ensureDirectSession();
