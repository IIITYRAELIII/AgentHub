import process from "node:process";

import { holdManualTestContourLock } from "../../src/runtime/test-contour-manual-lock.mjs";

const [
  root, owner, requestId, operationId, headCommit, releaseId,
  ownerRuntimeDataDir, ownerProvider, ownerThreadId, ownerTurnId,
] = process.argv.slice(2);
if (!root || !owner || !requestId || !operationId || !headCommit || !releaseId
    || !ownerRuntimeDataDir || !ownerProvider || !ownerThreadId || !ownerTurnId
    || typeof process.send !== "function") {
  throw new Error("root, owner, request, version, owner lifecycle and IPC are required");
}

const controller = new AbortController();
process.on("message", (message) => {
  if (message?.type === "cancel") controller.abort(new Error("fixture-cancelled"));
});

try {
  const result = await holdManualTestContourLock({
    root,
    owner,
    requestId,
    ownerProvider,
    ownerThreadId,
    ownerTurnId,
    ownerRuntimeDataDir,
    expectedOperationId: operationId,
    expectedHeadCommit: headCommit,
    expectedReleaseId: releaseId,
    signal: controller.signal,
    readStatus: async () => ({
      running: true,
      status: "ready",
      planned: false,
      state: {
        operationId,
        releaseId,
        source: { headCommit },
      },
      readback: { outcome: "exact" },
    }),
    onAcquired: (acquired) => process.send({ type: "acquired", acquired }),
  });
  process.send({ type: "released", result });
} catch (error) {
  process.send({ type: "failed", message: error.message });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
