import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

// Only detached DB/WAL copies enter this boundary. The coordinator retains
// ownership of live paths, both locks, quarantine and readiness.
export function inspectSqliteFileSync(file, {
  databaseFactory = (target, options) => new DatabaseSync(target, options),
} = {}) {
  const measurements = {};
  let database;
  const started = performance.now();
  try {
    database = databaseFactory(file, { readOnly: true });
    measurements.openMs = performance.now() - started;
    const checkStarted = performance.now();
    const rows = database.prepare("PRAGMA quick_check").all();
    measurements.checkMs = performance.now() - checkStarted;
    const failures = rows.flatMap((row) => Object.values(row)).filter((value) => String(value) !== "ok");
    return { healthy: failures.length === 0,
      ...(failures.length ? { corruption: `SQLite quick_check failed: ${failures.join("; ")}` } : {}), measurements };
  } catch (error) {
    if (!/(?:file is not a database|database disk image is malformed|malformed database schema)/iu
      .test(String(error?.message ?? ""))) throw error;
    return { healthy: false, corruption: String(error.message), measurements };
  } finally {
    const closeStarted = performance.now();
    database?.close();
    measurements.closeMs = performance.now() - closeStarted;
  }
}

export function inspectSqliteFileInWorker(databaseFile, {
  WorkerImpl = Worker,
  workerUrl = new URL("../../runtime/shared-sqlite-inspection-worker.mjs", import.meta.url),
} = {}) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerImpl(workerUrl, { workerData: { databaseFile },
      // The checker needs no launcher/test/eval flags (some cannot enter a Worker).
      execArgv: [],
    });
    let reply = null;
    let failure = null;
    worker.once("message", (message) => { reply = message; });
    worker.once("error", (error) => { failure = error; });
    // Await exit, not merely a reply: no handle can outlive copy cleanup/locks.
    worker.once("exit", (code) => {
      if (failure) return reject(failure);
      if (code !== 0 || !reply) return reject(new Error(`SQLite inspection worker exited without a result (${code})`));
      if (reply.error) {
        const error = new Error(reply.error.message);
        if (reply.error.code) error.code = reply.error.code;
        return reject(error);
      }
      if (typeof reply.result?.healthy !== "boolean"
          || (!reply.result.healthy && typeof reply.result.corruption !== "string")) {
        return reject(new Error("SQLite inspection worker returned an invalid result"));
      }
      resolve(reply.result);
    });
  });
}
