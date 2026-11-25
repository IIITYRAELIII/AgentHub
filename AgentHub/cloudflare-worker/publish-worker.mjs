// Independent Worker tool from the explicitly pinned build package.
import { readReleaseToolPackage } from "../src/infrastructure/process/release-tool-package.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sourceRoot = path.resolve(import.meta.dirname, "..");
const tool = await readReleaseToolPackage();
const { createWorkerPublicationTools } = await tool.module("src/worker/publish-worker.mjs");
export const { WORKER_VERIFY_CONVERGENCE_TIMEOUT_MS, WORKER_VERIFY_CONVERGENCE_ATTEMPTS, verifyWorkerConvergence, workerRouteBaseUrl, publishWorker, deployWorkerRelease, verifyWorkerRelease } = createWorkerPublicationTools({ sourceRoot });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { workerCommand } = await tool.module("src/development-commands.mjs");
  await workerCommand({ sourceRoot, action: process.argv[2] ?? "all" });
}
