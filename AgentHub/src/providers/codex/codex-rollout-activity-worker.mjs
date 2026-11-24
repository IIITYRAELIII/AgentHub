import { parentPort, workerData } from "node:worker_threads";
import { readCodexTracePage } from "./codex-trace-page.mjs";
import { recoverCodexRolloutSubagentsOnCurrentThread } from "./codex-rollout-subagent-recovery.mjs";

import {
  pinCodexRolloutActivityCache,
  readCodexRolloutActivityOnCurrentThread,
} from "./codex-rollout-activity.mjs";

async function execute(message) {
  if (message.operation === "trace-page") return readCodexTracePage(message.rolloutPath, message.options);
  if (message.operation === "recover-subagents") {
    return recoverCodexRolloutSubagentsOnCurrentThread(message.rolloutPath, message.candidates);
  }
  if (message.operation === "read") {
    const activity = await readCodexRolloutActivityOnCurrentThread(message.rolloutPath, {
      ...message.options,
      activityOnly: workerData?.admission === true,
    });
    if (!workerData?.admission) return activity;
    const {
      running, activeTurnIds, activeVscodeTurnIds, lastActivityAtMs, sourceUnavailable, scanBytes,
    } = activity;
    return { running, activeTurnIds, activeVscodeTurnIds, lastActivityAtMs, sourceUnavailable, scanBytes };
  }
  if (message.operation === "pin-cache") {
    return pinCodexRolloutActivityCache(message.rolloutPath);
  }
  throw new Error(`Unknown Codex rollout activity worker operation: ${message.operation}`);
}

async function respond(message) {
  const startedAt = performance.timeOrigin + performance.now();
  const timing = () => Number.isFinite(message.sentAt) ? {
    queueWaitMs: Math.max(0, startedAt - message.sentAt),
    readMs: performance.timeOrigin + performance.now() - startedAt,
  } : null;
  try {
    const result = await execute(message);
    parentPort.postMessage({
      requestId: message.requestId,
      ok: true,
      result,
      timing: timing(),
    });
  } catch (error) {
    parentPort.postMessage({
      requestId: message.requestId,
      ok: false,
      timing: timing(),
      error: { message: String(error?.message ?? error) },
    });
  }
}

let queue = Promise.resolve();
parentPort.on("message", (message) => {
  if (workerData?.admission) {
    // The caller coalesces same-path requests. Independent files can overlap.
    void respond(message);
    return;
  }
  queue = queue.then(() => respond(message), () => respond(message));
});
