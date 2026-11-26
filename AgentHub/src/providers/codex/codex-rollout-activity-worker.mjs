import { parentPort, workerData } from "node:worker_threads";
import { stat } from "node:fs/promises";
import { plainCodexAdmissionPath, readCodexArchiveAdmission } from "./codex-rollout-archive-admission.mjs";
import { readCodexTracePage } from "./codex-trace-page.mjs";
import { readCodexVisualization } from "./codex-visualization.mjs";
import { recoverCodexRolloutSubagentsOnCurrentThread } from "./codex-rollout-subagent-recovery.mjs";

import {
  pinCodexRolloutActivityCache,
  readCodexRolloutActivityOnCurrentThread,
} from "./codex-rollout-activity.mjs";

async function execute(message) {
  if (message.operation === "trace-page") return readCodexTracePage(message.rolloutPath, message.options);
  if (message.operation === "visualization") return readCodexVisualization(message.rolloutPath, message.options);
  if (message.operation === "recover-subagents") {
    return recoverCodexRolloutSubagentsOnCurrentThread(message.rolloutPath, message.candidates);
  }
  if (message.operation === "read") {
    if (!workerData?.admission) return readCodexRolloutActivityOnCurrentThread(message.rolloutPath, message.options);
    const rolloutPath = plainCodexAdmissionPath(message.rolloutPath);
    const readPlain = async () => {
      const activity = await readCodexRolloutActivityOnCurrentThread(rolloutPath, { activityOnly: true });
      const { running, activeTurnIds, activeVscodeTurnIds, lastActivityAtMs, sourceUnavailable, scanBytes } = activity;
      return { sourceKind: "plain", rolloutPath, running, activeTurnIds, activeVscodeTurnIds, lastActivityAtMs, sourceUnavailable, scanBytes };
    };
    const plain = await readPlain();
    if (!plain.sourceUnavailable || !message.threadId || !/\.jsonl$/iu.test(rolloutPath)) return plain;
    // An existing empty plain file may belong to a writer. Only absence permits a companion lookup.
    const plainExists = async () => stat(rolloutPath).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (await plainExists()) return plain;
    const archived = await readCodexArchiveAdmission(rolloutPath, message.threadId, message.deadlineAt);
    return await plainExists() ? readPlain() : archived;
  }
  if (message.operation === "pin-cache") {
    return pinCodexRolloutActivityCache(message.rolloutPath);
  }
  throw new Error(`Unknown Codex rollout activity worker operation: ${message.operation}`);
}

async function respond(message) {
  const startedAt = performance.timeOrigin + performance.now();
  const timing = () => {
    if (!Number.isFinite(message.sentAt)) return null;
    const finishedAt = performance.timeOrigin + performance.now();
    return {
      queueWaitMs: Math.max(0, startedAt - message.sentAt),
      readMs: finishedAt - startedAt,
      ...(message.operation === "trace-page" && message.options?.groupId ? { finishedAt } : {}),
    };
  };
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
      error: { message: String(error?.message ?? error), code: error?.code },
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
