import { appendFile } from "node:fs/promises";
import process from "node:process";

import {
  beginTestContourOperation,
  transitionTestContourOperation,
} from "../../src/runtime/test-contour-operation-state.mjs";
import { withTestContourOperationLock } from "../../src/runtime/test-contour-manager.mjs";

const [root, label, headCommit, eventFile] = process.argv.slice(2);
if (!root || !label || !headCommit || !eventFile || typeof process.send !== "function") {
  throw new Error("root, label, headCommit, eventFile and IPC are required");
}

const waitForRelease = () => new Promise((resolve) => {
  const receive = (message) => {
    if (message?.type !== "release") return;
    process.off("message", receive);
    resolve();
  };
  process.on("message", receive);
});

process.send({ type: "waiting", label, pid: process.pid });
await withTestContourOperationLock(root, async () => {
  const operation = await beginTestContourOperation(root, {
    source: { branch: "dev", headCommit, sourceRoot: process.cwd() },
    target: { root, contourId: "fixture-contour", port: 8877, model: "fake-codex" },
  });
  await appendFile(eventFile, `${label}:enter:${operation.operationId}\n`, "utf8");
  const release = waitForRelease();
  process.send({ type: "acquired", label, operationId: operation.operationId, pid: process.pid });
  await release;
  const ready = await transitionTestContourOperation(root, {
    operationId: operation.operationId,
    ownerToken: operation.ownerToken,
    phase: "ready",
    status: "ready",
    patch: { releaseId: `release-${label}` },
  });
  await appendFile(eventFile, `${label}:exit:${ready.operationId}\n`, "utf8");
});
process.send({ type: "done", label });
