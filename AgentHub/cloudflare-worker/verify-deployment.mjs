// Independent Worker tool from the explicitly pinned build package.
import { readReleaseToolPackage } from "../src/infrastructure/process/release-tool-package.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sourceRoot = path.resolve(import.meta.dirname, "..");
const tool = await readReleaseToolPackage();
const { createWorkerVerificationTools } = await tool.module("src/worker/verify-deployment.mjs");
export const { WorkerDeploymentNotConvergedError, workerVerificationCheckpointFile, workerVerificationCheckpointStore, fetchWithCurl, measureImmediateControlDrain, fetchWithTransportRace, changedBackgrounds, verifyThemeDeployment, WORKER_VERIFY_REQUEST_TIMEOUT_MS } = createWorkerVerificationTools({ sourceRoot });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { workerCommand } = await tool.module("src/development-commands.mjs");
  await workerCommand({ sourceRoot, action: "verify-deployment" });
}
