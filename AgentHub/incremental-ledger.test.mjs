import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendLedgerEvents,
  applyLedgerDelta,
  ledgerRecordChanges,
  ledgerRecordSnapshot,
} from "./incremental-ledger.mjs";

test("ledger delta persists only changed records and deletions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-ledger-delta-"));
  const deltaFile = path.join(root, "usage.delta.jsonl");
  try {
    const original = { one: { value: 1 }, two: { value: 2 } };
    const previous = ledgerRecordSnapshot(original);
    const next = { one: { value: 3 }, three: { value: 4 } };
    const changes = ledgerRecordChanges(next, previous);
    assert.deepEqual(changes.events.map((event) => `${event.op}:${event.key}`).sort(), [
      "delete:two",
      "upsert:one",
      "upsert:three",
    ]);
    const bytes = await appendLedgerEvents(deltaFile, changes.events);
    assert.equal(bytes, Buffer.byteLength(await readFile(deltaFile, "utf8"), "utf8"));
    const applied = await applyLedgerDelta({ version: 7, turns: structuredClone(original) }, deltaFile);
    assert.deepEqual(applied.value.turns, next);
    assert.equal(applied.invalid, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
