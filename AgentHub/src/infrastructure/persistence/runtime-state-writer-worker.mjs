import { parentPort, workerData } from "node:worker_threads";

import { openRuntimeDatabase } from "./runtime-state-store.mjs";

const RETRY_INTERVAL_MS = 25;
const RETRY_TIMEOUT_MS = 5_000;
const database = openRuntimeDatabase(workerData.dataDir);
database.exec("PRAGMA busy_timeout = 0;");

function busyError(error) {
  return /(?:SQLITE_BUSY|database (?:table )?is locked)/iu.test(String(error?.message ?? error));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryBusy(operation) {
  const deadline = Date.now() + RETRY_TIMEOUT_MS;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!busyError(error) || Date.now() >= deadline) throw error;
      await delay(RETRY_INTERVAL_MS);
    }
  }
}

function inTransaction(operation) {
  let active = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    active = true;
    const value = operation();
    database.exec("COMMIT;");
    active = false;
    return value;
  } catch (error) {
    if (active) {
      try {
        database.exec("ROLLBACK;");
      } catch {}
    }
    throw error;
  }
}

async function saveState(content) {
  const now = new Date().toISOString();
  await retryBusy(() => inTransaction(() => {
    database.prepare(`
      INSERT INTO runtime_state (key, value_json, updated_at)
      VALUES ('main', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(content, now);
  }));
}

async function handle(message) {
  if (message.type === "save-state") return saveState(message.payload.content);
  if (message.type === "close") {
    database.close();
    return null;
  }
  throw new Error(`unknown runtime state writer request: ${message.type}`);
}

let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue.then(async () => {
    try {
      const value = await handle(message);
      parentPort.postMessage({ id: message.id, value });
      if (message.type === "close") parentPort.close();
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        error: {
          message: String(error?.message ?? error),
          code: error?.code,
          stack: error?.stack,
        },
      });
      if (message.type === "close") parentPort.close();
    }
  });
});
