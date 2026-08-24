import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeUsageSyncIdentity } from "../../domain/usage-sync-identity.mjs";
import { WorkLogUsageSyncStore } from "./work-log-usage-sync-store.mjs";

async function readIdentity(file) {
  try {
    return normalizeUsageSyncIdentity(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function synchronizedEventsExist(databaseFile) {
  try {
    await access(databaseFile);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const table = database.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'usage_sync_events'
    `).get();
    return Boolean(table && database.prepare("SELECT 1 AS present FROM usage_sync_events LIMIT 1").get());
  } finally {
    database.close();
  }
}

export async function openWorkLogProjectionSync({ databaseFile } = {}) {
  if (!databaseFile) throw new TypeError("SQLite journal database is required");
  const dataDirectory = path.dirname(path.resolve(databaseFile));
  const identity = await readIdentity(path.join(dataDirectory, "usage-sync-identity.json"));
  if (!identity) {
    if (await synchronizedEventsExist(databaseFile)) {
      throw new Error("Usage sync identity is required to project synchronized journal events");
    }
    return {
      usageSyncStore: null,
      usageSyncDeviceId: "",
      close: async () => {},
    };
  }
  const usageSyncStore = new WorkLogUsageSyncStore({
    databaseFile,
    deviceId: identity.deviceId,
  });
  return {
    usageSyncStore,
    usageSyncDeviceId: identity.deviceId,
    close: () => usageSyncStore.close(),
  };
}
