import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildWorkerAssets } from "./build-assets.mjs";
import { deployWorker } from "./deploy-worker.mjs";
import { verifyThemeDeployment } from "./verify-deployment.mjs";
import { withPublicationLock } from "../src/infrastructure/process/publication-lock.mjs";
import {
  assertCleanPublicationTree,
  assertCurrentPublicationRevision,
} from "../src/infrastructure/persistence/publication-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(root, "..");

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
  readConfig = async () => JSON.parse(await readFile(
    path.join(import.meta.dirname, "wrangler.jsonc"),
    "utf8",
  )),
} = {}) {
  return exclusive(async () => {
    await before();
    await build();
    await deploy();
    return verify({ baseUrl: workerRouteBaseUrl(await readConfig()) });
  });
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedFile === import.meta.url) {
  await publishWorker({
    before: async () => {
      await assertCleanPublicationTree({ cwd: repositoryRoot });
      await assertCurrentPublicationRevision({ cwd: repositoryRoot });
    },
  });
}
