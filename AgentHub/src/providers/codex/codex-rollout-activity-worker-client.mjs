import { Worker } from "node:worker_threads";

const workerUrl = new URL("./codex-rollout-activity-worker.mjs", import.meta.url);
const pending = new Map();
let nextRequestId = 0;
let worker = null;

function settlePending(requestId, callback, value) {
  const request = pending.get(requestId);
  if (!request) return;
  pending.delete(requestId);
  callback(request, value);
  if (!pending.size) worker?.unref();
}

function failWorker(activeWorker, error) {
  if (worker !== activeWorker) return;
  worker = null;
  for (const [requestId, request] of pending) {
    pending.delete(requestId);
    request.reject(error);
  }
}

function ensureWorker() {
  if (worker) return worker;
  const activeWorker = new Worker(workerUrl);
  activeWorker.unref();
  activeWorker.on("message", (message) => {
    const requestId = Number(message?.requestId);
    if (message?.ok) {
      settlePending(requestId, (request, result) => request.resolve(result), message.result);
    } else {
      settlePending(
        requestId,
        (request, error) => request.reject(error),
        new Error(message?.error?.message || "Codex rollout activity worker failed"),
      );
    }
  });
  activeWorker.once("error", (error) => failWorker(activeWorker, error));
  activeWorker.once("exit", (code) => {
    if (code !== 0 || pending.size) {
      failWorker(activeWorker, new Error(`Codex rollout activity worker exited with code ${code}`));
    } else if (worker === activeWorker) {
      worker = null;
    }
  });
  worker = activeWorker;
  return activeWorker;
}

function requestWorker(operation, payload) {
  const activeWorker = ensureWorker();
  const requestId = ++nextRequestId;
  activeWorker.ref();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      activeWorker.postMessage({ requestId, operation, ...payload });
    } catch (error) {
      settlePending(requestId, (request, reason) => request.reject(reason), error);
    }
  });
}

export function readCodexRolloutActivityInWorker(rolloutPath, options = {}) {
  return requestWorker("read", { rolloutPath, options });
}

export function pinCodexRolloutActivityCacheInWorker(rolloutPath) {
  return requestWorker("pin-cache", { rolloutPath });
}

