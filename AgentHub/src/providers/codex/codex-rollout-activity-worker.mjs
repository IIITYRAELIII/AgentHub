import { parentPort } from "node:worker_threads";
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
    return readCodexRolloutActivityOnCurrentThread(message.rolloutPath, message.options);
  }
  if (message.operation === "pin-cache") {
    return pinCodexRolloutActivityCache(message.rolloutPath);
  }
  throw new Error(`Unknown Codex rollout activity worker operation: ${message.operation}`);
}

async function respond(message) {
  try {
    parentPort.postMessage({
      requestId: message.requestId,
      ok: true,
      result: await execute(message),
    });
  } catch (error) {
    parentPort.postMessage({
      requestId: message.requestId,
      ok: false,
      error: { message: String(error?.message ?? error) },
    });
  }
}

let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue.then(
    () => respond(message),
    () => respond(message),
  );
});
