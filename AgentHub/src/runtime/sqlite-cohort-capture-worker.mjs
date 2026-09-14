import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureSqliteCohort } from "./sqlite-cohort-snapshot.mjs";

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error("Capture supervisor disconnected"));
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

// Dependency injection is used only by isolated worker fixtures. Production
// invocation receives serializable source/output paths, never executable hooks.
export function serveCaptureWorker(capture = captureSqliteCohort) {
  if (!process.send) throw new Error("SQLite capture worker requires an IPC supervisor");
  process.once("disconnect", () => process.exit(75));
  process.once("message", async (message) => {
    if (message?.type !== "capture" || !message.options) process.exit(64);
    try {
      const result = await capture({
        sourceDataDirectory: message.options.sourceDataDirectory,
        outputDirectory: message.options.outputDirectory,
        attempts: message.options.attempts,
        includeQueueFiles: message.options.includeQueueFiles === true,
        onProgress: (progress) => send({ type: "progress", progress }),
      });
      await send({ type: "result", result });
      process.exit(0);
    } catch (error) {
      await send({ type: "failure", error: { message: error.message, manifestFile: error.manifestFile ?? null } }).catch(() => {});
      process.exit(1);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serveCaptureWorker();
