import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

import { buildWorkerAssets } from "./build-assets.mjs";
import { deployWorker } from "./deploy-worker.mjs";
import {
  verifyThemeDeployment,
  workerVerificationCheckpointStore,
} from "./verify-deployment.mjs";
import { withPublicationLock } from "../src/infrastructure/process/publication-lock.mjs";
import {
  assertCleanPublicationTree,
  assertCurrentPublicationRevision,
} from "../src/infrastructure/persistence/publication-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(root, "..");
export const WORKER_VERIFY_CONVERGENCE_TIMEOUT_MS = 60_000;
export const WORKER_VERIFY_CONVERGENCE_ATTEMPTS = 6;

export async function verifyWorkerConvergence(verify, {
  timeoutMs = WORKER_VERIFY_CONVERGENCE_TIMEOUT_MS,
  attempts = WORKER_VERIFY_CONVERGENCE_ATTEMPTS,
  now = Date.now,
  pause = wait,
  log = console.log,
} = {}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let lastError = null;
  let attempted = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    attempted = attempt;
    try {
      return await verify({ indexDeadline: deadline, attempt });
    } catch (error) {
      if (error?.code !== "WORKER_DEPLOYMENT_NOT_CONVERGED") throw error;
      lastError = error;
      const retryRemainingMs = deadline - now();
      if (attempt >= attempts || retryRemainingMs <= 0) break;
      const delayMs = Math.min(1_000 * (2 ** (attempt - 1)), 8_000, retryRemainingMs);
      log(`[Worker verify] published bytes not converged; retry ${attempt + 1}/${attempts} in ${delayMs} ms`);
      await pause(delayMs);
    }
  }
  const elapsedMs = Math.max(0, now() - startedAt);
  const terminal = new Error(
    `Published Worker bytes did not converge after ${elapsedMs} ms: ${lastError?.message ?? "deadline exceeded"}`,
    { cause: lastError ?? undefined },
  );
  terminal.code = "WORKER_DEPLOYMENT_MISMATCH";
  terminal.attempts = attempted;
  terminal.elapsedMs = elapsedMs;
  terminal.details = lastError?.details ?? {};
  throw terminal;
}

export function workerRouteBaseUrl(config) {
  const route = config.routes?.find((item) => typeof item === "string" || item?.pattern);
  const pattern = typeof route === "string" ? route : route?.pattern;
  const host = String(pattern ?? "")
    .replace(/^https?:\/\//iu, "")
    .replace(/\/\*.*$/u, "")
    .replace(/\/$/u, "");
  if (!host) throw new Error("Worker route is missing");
  return `https://${host}/`;
}

export async function publishWorker({
  build = buildWorkerAssets,
  deploy = deployWorker,
  verify = verifyThemeDeployment,
  before = async () => {},
  exclusive = withPublicationLock,
  verificationCheckpoint = workerVerificationCheckpointStore(),
  readConfig = async () => JSON.parse(await readFile(
    path.join(import.meta.dirname, "wrangler.jsonc"),
    "utf8",
  )),
} = {}) {
  return exclusive(async () => {
    await before();
    await build();
    await deploy();
    return verify({
      baseUrl: workerRouteBaseUrl(await readConfig()),
      checkpoint: verificationCheckpoint,
    });
  });
}

export async function deployWorkerRelease({
  build = buildWorkerAssets,
  deploy = deployWorker,
  before = async () => {},
  exclusive = withPublicationLock,
} = {}) {
  return exclusive(async () => {
    await before();
    await build();
    await deploy();
  });
}

export async function verifyWorkerRelease({
  verify = verifyThemeDeployment,
  before = async () => {},
  exclusive = withPublicationLock,
  changedFiles = null,
  verificationCheckpoint = workerVerificationCheckpointStore(),
  converge = verifyWorkerConvergence,
  convergenceTimeoutMs = WORKER_VERIFY_CONVERGENCE_TIMEOUT_MS,
  convergenceAttempts = WORKER_VERIFY_CONVERGENCE_ATTEMPTS,
  now = Date.now,
  pause = wait,
  log = console.log,
  readConfig = async () => JSON.parse(await readFile(
    path.join(import.meta.dirname, "wrangler.jsonc"),
    "utf8",
  )),
} = {}) {
  return exclusive(async () => {
    await before();
    const baseUrl = workerRouteBaseUrl(await readConfig());
    return converge(
      ({ indexDeadline }) => verify({
        baseUrl,
        changedFiles,
        checkpoint: verificationCheckpoint,
        indexDeadline,
        log,
      }),
      {
        timeoutMs: convergenceTimeoutMs,
        attempts: convergenceAttempts,
        now,
        pause,
        log,
      },
    );
  });
}

function changedFilesFromEnvironment(environment = process.env) {
  const source = String(environment.AGENT_HUB_WORKER_CHANGED_FILES ?? "").trim();
  if (!source) return null;
  const files = JSON.parse(source);
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    throw new Error("AGENT_HUB_WORKER_CHANGED_FILES must contain a JSON string array");
  }
  return files;
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedFile === import.meta.url) {
  const action = String(process.argv[2] ?? "all").trim().toLowerCase();
  const before = async () => {
    await assertCleanPublicationTree({ cwd: repositoryRoot });
    await assertCurrentPublicationRevision({ cwd: repositoryRoot });
  };
  if (action === "deploy") await deployWorkerRelease({ before });
  else if (action === "verify") {
    await verifyWorkerRelease({
      before,
      changedFiles: changedFilesFromEnvironment(),
    });
  } else if (action === "all") await publishWorker({ before });
  else throw new Error(`Unknown Worker publication action: ${action}`);
}
