import { fileURLToPath } from "node:url";
import path from "node:path";

import { callDesktopControl } from "./desktop-control.mjs";
import { withPublicationLock } from "./src/infrastructure/process/publication-lock.mjs";

export async function requestSafeRestart({
  restart = callDesktopControl,
  log = console.log,
  exclusive = withPublicationLock,
} = {}) {
  return exclusive(async () => {
    const result = await restart("restart-server");
    log(result?.message ?? "Safe Agent Hub restart requested");
    return result;
  });
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  requestSafeRestart().catch((error) => {
    console.error(`Cannot request safe Agent Hub restart: ${error.message}`);
    process.exitCode = 1;
  });
}
