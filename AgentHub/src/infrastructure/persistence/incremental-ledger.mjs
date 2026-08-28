import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

export async function applyLedgerDelta(ledger, deltaFile) {
  const value = ledger && typeof ledger === "object" ? ledger : {};
  value.turns = value.turns && typeof value.turns === "object" ? value.turns : {};
  const raw = await readFile(deltaFile, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  let applied = 0;
  let invalid = 0;
  for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      const key = String(event?.key ?? "");
      if (!key) throw new Error("missing key");
      if (event.op === "upsert" && event.record && typeof event.record === "object") {
        value.turns[key] = event.record;
      } else if (event.op === "delete") {
        delete value.turns[key];
      } else {
        throw new Error("unsupported operation");
      }
      applied += 1;
    } catch {
      invalid += 1;
    }
  }
  return { value, applied, invalid };
}

export function ledgerRecordFingerprint(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("base64url");
}

export function ledgerRecordSnapshot(turns = {}) {
  return new Map(Object.entries(turns).map(([key, record]) => [key, ledgerRecordFingerprint(record)]));
}

export function ledgerRecordChanges(turns = {}, previous = new Map()) {
  const next = ledgerRecordSnapshot(turns);
  const events = [];
  for (const [key, record] of Object.entries(turns)) {
    const serialized = next.get(key);
    if (previous.get(key) !== serialized) events.push({ op: "upsert", key, record });
  }
  for (const key of previous.keys()) {
    if (!next.has(key)) events.push({ op: "delete", key });
  }
  return { events, snapshot: next };
}

export async function appendLedgerEvents(deltaFile, events) {
  if (!events.length) return 0;
  const body = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await appendFile(deltaFile, body, { encoding: "utf8", mode: 0o600 });
  return Buffer.byteLength(body, "utf8");
}
