import { assertCodexRolloutReadAllowed } from "../../infrastructure/filesystem/test-contour-rollout-policy.mjs";
import { Worker } from "node:worker_threads";

function scanRolloutInWorker(workerData, {
  WorkerImpl = Worker,
  workerUrl = new URL("./codex-historical-backfill-worker.mjs", import.meta.url),
} = {}) {
  const live = workerData.mode === "live";
  return new Promise((resolve, reject) => {
    const worker = new WorkerImpl(workerUrl, {
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message?.ok !== true) {
        reject(new Error(String(message?.error ?? (live ? "Live rollout worker failed" : "Historical rollout worker failed"))));
      } else if (!live) {
        resolve({ turns: message.turns ?? [] });
      } else {
        const result = message.result;
        if (!result?.session || !result?.resumeState || !Array.isArray(result.turns)
          || !Array.isArray(result.attachmentCandidates) || !Number.isSafeInteger(result.nextOffset)
          || result.nextOffset < workerData.startOffset) {
          reject(new Error("Live rollout worker returned an invalid scan result"));
        } else {
          resolve(result);
        }
      }
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled && live) reject(new Error(`Live rollout worker exited with code ${code} without a scan result`));
      else if (!settled && code !== 0) reject(new Error(`Historical rollout worker exited with code ${code}`));
      else if (!settled) resolve({ turns: [] });
    });
  });
}

export function scanCodexHistoricalRolloutInWorker(thread, options = {}) {
  assertCodexRolloutReadAllowed("scanCodexHistoricalRolloutInWorker");
  const transcriptPath = String(thread?.path ?? "").trim();
  const rolloutId = String(thread?.id ?? "").trim();
  if (!transcriptPath) throw new Error("Codex historical rollout path is required");
  return scanRolloutInWorker({ mode: "historical", transcriptPath, rolloutId }, options);
}

export function scanCodexLiveRolloutInWorker(transcriptPath, {
  startOffset = 0,
  maxBytes,
  resumeState = null,
  ...options
} = {}) {
  assertCodexRolloutReadAllowed("scanCodexLiveRolloutInWorker");
  const pathname = String(transcriptPath ?? "").trim();
  if (!pathname) throw new Error("Codex live rollout path is required");
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) throw new Error("Codex live rollout startOffset must be a nonnegative safe integer");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Codex live rollout maxBytes must be a positive safe integer");
  return scanRolloutInWorker({ mode: "live", transcriptPath: pathname, startOffset, maxBytes, resumeState }, options);
}
