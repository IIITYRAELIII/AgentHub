import { observeRuntimeWorkerMemory } from "../../application/runtime-worker-memory.mjs";
import { Worker } from "node:worker_threads";

const workerUrl = new URL("./codex-rollout-activity-worker.mjs", import.meta.url);
function createRolloutWorkerClient(admission = false) {
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
    const activeWorker = new Worker(workerUrl, { workerData: { admission } });
    observeRuntimeWorkerMemory("rollout", activeWorker);
    activeWorker.unref();
    activeWorker.on("message", (message) => {
      const requestId = Number(message?.requestId);
      if (message?.ok) {
        settlePending(requestId, (request, result) => {
          try { request.timing?.(message.timing, "succeeded"); } catch { /* Diagnostics only. */ }
          request.resolve(result);
        },
            admission ? { activity: message.result, timing: message.timing } : message.result);
      } else {
        settlePending(
          requestId,
          (request, error) => {
            try { request.timing?.(message.timing, "failed"); } catch { /* Diagnostics only. */ }
            request.reject(error);
          },
          Object.assign(new Error(message?.error?.message || "Codex rollout activity worker failed"), {
            ...(message?.timing ? { timing: message.timing } : {}),
          }),
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

  function requestWorker(operation, payload, timing) {
    const activeWorker = ensureWorker();
    const requestId = ++nextRequestId;
    activeWorker.ref();
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, timing });
      try {
        activeWorker.postMessage({
          requestId, operation, ...payload,
          ...(admission || timing ? { sentAt: performance.timeOrigin + performance.now() } : {}),
        });
      } catch (error) {
        settlePending(requestId, (request, reason) => request.reject(reason), error);
      }
    });
  }
  return requestWorker;
}

const requestWorker = createRolloutWorkerClient();
const requestAdmissionWorker = createRolloutWorkerClient(true);
// Interactive exact reads cannot wait behind background rollout scans or page browsing.
const requestExactTraceWorker = createRolloutWorkerClient();

const MAX_ADMISSION_READS = 8;
const admissionReads = new Map();

export function readCodexAdmissionActivityInWorker(rolloutPath, pathKey) {
  const active = admissionReads.get(pathKey);
  if (active) return active;
  if (admissionReads.size >= MAX_ADMISSION_READS) {
    return Promise.reject(Object.assign(new Error("Codex activity readers are busy"), {
      code: "ERR_DEFERRED_ACTIVITY_BACKPRESSURE",
    }));
  }
  const pending = requestAdmissionWorker("read", { rolloutPath });
  admissionReads.set(pathKey, pending);
  const clear = () => {
    if (admissionReads.get(pathKey) === pending) admissionReads.delete(pathKey);
  };
  pending.then(clear, clear);
  return pending;
}

export function readCodexRolloutActivityInWorker(rolloutPath, options = {}) {
  return requestWorker("read", { rolloutPath, options });
}

export function pinCodexRolloutActivityCacheInWorker(rolloutPath) {
  return requestWorker("pin-cache", { rolloutPath });
}

export function recoverCodexRolloutSubagents(rolloutPath, candidates) {
  return requestWorker("recover-subagents", { rolloutPath, candidates });
}

export function readCodexTracePageInWorker(rolloutPath, options, timing) {
  const request = options?.groupId ? requestExactTraceWorker : requestWorker;
  return request("trace-page", { rolloutPath, options }, timing);
}
