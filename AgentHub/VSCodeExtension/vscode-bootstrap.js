"use strict";

const vscode = window.acquireVsCodeApi();
window.__agentHubVscode = vscode;
const nativeFetch = window.fetch.bind(window);
const pending = new Map();
let sequence = 0;

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "agenthub:http-result") return;
  const request = pending.get(String(message.id ?? ""));
  if (!request) return;
  pending.delete(String(message.id));
  window.clearTimeout(request.timer);
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
  if (!url.pathname.startsWith("/api/journal")) return nativeFetch(input, init);
  const id = `http-${Date.now()}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("Журнал в VS Code не ответил вовремя"));
    }, 15_000);
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
