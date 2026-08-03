import { Worker } from "node:worker_threads";

export function scanCodexHistoricalRolloutInWorker(thread, {
  WorkerImpl = Worker,
  workerUrl = new URL("./codex-historical-backfill-worker.mjs", import.meta.url),
} = {}) {
  const transcriptPath = String(thread?.path ?? "").trim();
  const rolloutId = String(thread?.id ?? "").trim();
  if (!transcriptPath) throw new Error("Codex historical rollout path is required");

  return new Promise((resolve, reject) => {
    const worker = new WorkerImpl(workerUrl, {
      workerData: { transcriptPath, rolloutId },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message?.ok === true) resolve({ turns: message.turns ?? [] });
      else reject(new Error(String(message?.error ?? "Historical rollout worker failed")));
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`Historical rollout worker exited with code ${code}`));
      else if (!settled) resolve({ turns: [] });
    });
  });
}
