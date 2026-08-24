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

function messageIntakeRows(value) {
  const receipts = new Map((Array.isArray(value?.desktopMessageReceipts)
    ? value.desktopMessageReceipts
    : []).map((receipt) => [String(receipt?.clientUserMessageId ?? ""), receipt]));
  return [
    ["pending", value?.pendingInputs],
    ["queued", value?.queuedInputs],
  ].flatMap(([destination, items]) => (Array.isArray(items) ? items : [])
    .filter((item) => item?.conflictKind === "message-intake")
    .map((item) => ({
      id: String(item.id),
      destination,
      item,
      receipt: receipts.get(String(item.clientUserMessageId ?? "")) ?? null,
    })));
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
  const value = JSON.parse(content);
  const rows = messageIntakeRows(value);
  const now = new Date().toISOString();
  await retryBusy(() => inTransaction(() => {
    database.prepare(`
      INSERT INTO runtime_state (key, value_json, updated_at)
      VALUES ('main', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(content, now);
    database.prepare("DELETE FROM runtime_deferred_intake").run();
    const insert = database.prepare(`
      INSERT INTO runtime_deferred_intake (
        id, destination, item_json, receipt_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.id,
        row.destination,
        JSON.stringify(row.item),
        row.receipt ? JSON.stringify(row.receipt) : null,
        String(row.item.createdAt ?? now),
        now,
      );
    }
  }));
}

async function saveIntake({ item, destination, receipt }) {
  if (!item?.id) throw new TypeError("deferred input id is required");
  const normalizedDestination = destination === "queued" ? "queued" : "pending";
  const now = new Date().toISOString();
  const itemJson = JSON.stringify(item);
  const receiptJson = receipt ? JSON.stringify(receipt) : null;
  await retryBusy(() => database.prepare(`
    INSERT INTO runtime_deferred_intake (
      id, destination, item_json, receipt_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      destination = excluded.destination,
      item_json = excluded.item_json,
      receipt_json = excluded.receipt_json,
      updated_at = excluded.updated_at
  `).run(
    String(item.id),
    normalizedDestination,
    itemJson,
    receiptJson,
    String(item.createdAt ?? now),
    now,
  ));
}

async function handle(message) {
  if (message.type === "save-state") return saveState(message.payload.content);
  if (message.type === "save-intake") return saveIntake(message.payload);
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
