import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  mergeUsageSyncEvents,
  usageSyncSnapshotFromLedger,
  USAGE_SYNC_SNAPSHOT_VERSION,
} from "../../domain/work-log-usage-sync.mjs";
import { writeTextAtomic } from "./state-store.mjs";

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function snapshot(events, {
  deviceId = "",
  updatedAt = new Date().toISOString(),
} = {}) {
  return {
    version: USAGE_SYNC_SNAPSHOT_VERSION,
    deviceId: String(deviceId ?? "").trim(),
    updatedAt,
    events: mergeUsageSyncEvents(events),
  };
}

export class WorkLogUsageSyncStore {
  #file;
  #deviceId;
  #tail = Promise.resolve();

  constructor({ file, deviceId = "" } = {}) {
    if (!file) throw new TypeError("WorkLogUsageSyncStore requires a file");
    this.#file = path.resolve(file);
    this.#deviceId = String(deviceId ?? "").trim();
  }

  get file() {
    return this.#file;
  }

  async #read() {
    const current = await readJson(this.#file);
    return snapshot(current?.events ?? [], {
      deviceId: current?.deviceId ?? this.#deviceId,
      updatedAt: current?.updatedAt,
    });
  }

  async #write(value) {
    await mkdir(path.dirname(this.#file), { recursive: true });
    await writeTextAtomic(this.#file, `${JSON.stringify(value, null, 2)}\n`);
  }

  #enqueue(operation) {
    const next = this.#tail.catch(() => {}).then(operation);
    this.#tail = next;
    return next;
  }

  events() {
    return this.#enqueue(async () => (await this.#read()).events);
  }

  importSnapshot(remoteSnapshot) {
    return this.#enqueue(async () => {
      const current = await this.#read();
      const mergedEvents = mergeUsageSyncEvents(current.events, remoteSnapshot);
      const merged = snapshot(mergedEvents, {
        deviceId: current.deviceId || this.#deviceId,
      });
      await this.#write(merged);
      return {
        imported: true,
        before: current.events.length,
        after: merged.events.length,
        added: Math.max(0, merged.events.length - current.events.length),
        file: this.#file,
      };
    });
  }

  replaceEvents(events) {
    return this.#enqueue(async () => {
      const next = snapshot(events, { deviceId: this.#deviceId });
      await this.#write(next);
      return { replaced: next.events.length, file: this.#file };
    });
  }

  exportSnapshot(turns = {}, { exportedAt = new Date().toISOString() } = {}) {
    return usageSyncSnapshotFromLedger(turns, {
      deviceId: this.#deviceId,
      exportedAt,
    });
  }
}
