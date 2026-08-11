import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { withPublicationLock } from "../src/infrastructure/process/publication-lock.mjs";

const root = path.resolve(import.meta.dirname, "..");

function runWrangler() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, "wrangler-runner.mjs"),
      "deploy",
      "--config",
      path.join("cloudflare-worker", "wrangler.jsonc"),
    ], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(Number(code)));
  });
}

export async function deployWorker({
  attempts = 3,
  run = runWrangler,
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let code = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    code = await run();
    if (code === 0) return;
    if (attempt < attempts) {
      console.warn(`Cloudflare deploy failed; retrying (${attempt}/${attempts - 1})...`);
      await pause(1_000 * attempt);
    }
  }
  throw new Error(`Cloudflare deploy failed after ${attempts} attempts (exit code ${code})`);
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedFile === import.meta.url) await withPublicationLock(() => deployWorker());
