"use strict";

const vscode = window.acquireVsCodeApi();
window.__agentHubVscode = vscode;
const nativeFetch = window.fetch.bind(window);
const pending = new Map();
let sequence = 0;

/* Retained VS Code WebViews can return from a hidden editor tab with their
   infinite CSS animations left paused by Electron. Resume only animations
   that already exist and are meant to repeat forever; reduced-motion rules
   remove those animations entirely, so the accessibility preference remains
   authoritative. */
function resumeWebviewMotion() {
  if (document.hidden) return;
  for (const animation of document.getAnimations?.() ?? []) {
    const iterations = animation.effect?.getTiming?.().iterations;
    if (iterations !== Infinity || animation.playState === "running") continue;
    try {
      animation.play();
    } catch {
      // A detached effect disappears on the next render; it needs no recovery.
    }
  }
}

window.addEventListener("focus", resumeWebviewMotion);
window.addEventListener("pageshow", resumeWebviewMotion);
document.addEventListener("visibilitychange", resumeWebviewMotion);

window.addEventListener("message", (event) => {
  const message = event.data;
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

window.fetch = function agentHubFetch(input, init = {}) {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
    window.location.href,
  );
  // журнал и сводка лимитов идут через расширение: в webview нет HTTP-сервера
  if (!url.pathname.startsWith("/api/journal") && url.pathname !== "/api/rate-limits") {
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
    });
  });
};
