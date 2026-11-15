import { parentPort, workerData, threadId } from "node:worker_threads";
import { inspectSqliteFileSync } from "../infrastructure/persistence/shared-sqlite-inspection.mjs";

try {
  const result = inspectSqliteFileSync(workerData.databaseFile);
  result.measurements.workerThreadId = threadId;
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: { message: String(error.message), code: error.code } });
} finally {
  parentPort.close();
}
