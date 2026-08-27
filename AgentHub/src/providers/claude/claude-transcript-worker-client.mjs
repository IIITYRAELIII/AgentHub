import { Worker } from "node:worker_threads";

const workerUrl = new URL("./claude-transcript-worker.mjs", import.meta.url);
const inFlight = new Map();
let workerQueue = Promise.resolve();

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: payload });
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.once("message", (message) => {
      if (message?.ok) settle(resolve, message.result);
      else settle(reject, new Error(message?.error?.message || "Claude transcript worker failed"));
    });
    worker.once("error", (error) => settle(reject, error));
    worker.once("exit", (code) => {
      if (code !== 0) settle(reject, new Error(`Claude transcript worker exited with code ${code}`));
    });
  });
}

function scheduleWorker(key, payload) {
  const active = inFlight.get(key);
  if (active) return active;
  const scheduled = workerQueue.then(
    () => runWorker(payload),
    () => runWorker(payload),
  );
  workerQueue = scheduled.catch(() => {});
  inFlight.set(key, scheduled);
  scheduled.finally(() => {
    if (inFlight.get(key) === scheduled) inFlight.delete(key);
  }).catch(() => {});
  return scheduled;
}

export function compactClaudeTranscriptHistoryRange(transcriptPath, {
  start = 0,
  endExclusive,
} = {}) {
  const normalizedEnd = Number(endExclusive);
  const key = `compact:${transcriptPath}:${start}:${normalizedEnd}`;
  return scheduleWorker(key, {
    operation: "compact-history-range",
    transcriptPath,
    start,
    endExclusive: normalizedEnd,
  });
}

export function scanClaudeHistoricalTranscriptInWorker(transcriptPath) {
  return scheduleWorker(`historical:${transcriptPath}`, {
    operation: "historical-scan",
    transcriptPath,
  });
}
