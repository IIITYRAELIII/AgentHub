import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import { RateLimitHistoryStore } from "../../../src/infrastructure/persistence/rate-limit-history.mjs";
import { applyWorkLogAccountBackfill } from "../../../src/infrastructure/persistence/work-log-account-backfill.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-work-log-account-backfill-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const limits = new RateLimitHistoryStore({
    databaseFile,
    rawFile: path.join(directory, "rate-limits-raw.jsonl"),
    csvFile: path.join(directory, "rate-limits.csv"),
  });
  try {
    await journal.replaceLedger({
      version: 8,
      turns: {
        "codex\0thread-a\0turn-1": {
          provider: "codex",
          threadId: "thread-a",
          turnId: "turn-1",
          completedAt: "2026-08-01T00:05:00.000Z",
          status: "completed",
        },
        "codex\0thread-a\0turn-2": {
          provider: "codex",
          threadId: "thread-a",
          turnId: "turn-2",
          completedAt: "2026-08-01T01:05:00.000Z",
          status: "completed",
          accountKey: "chatgpt:exact",
          accountAttribution: "exact",
        },
        "claude\0thread-b\0turn-1": {
          provider: "claude",
          threadId: "thread-b",
          turnId: "turn-1",
          completedAt: "2026-08-01T00:10:00.000Z",
          status: "completed",
        },
      },
    });
    await limits.recordAccountEvent(
      { type: "chatgpt", email: "owner@example.com", planType: "plus" },
      "2026-08-01T00:00:00.000Z",
      "test",
    );
  } finally {
    await limits.close();
    journal.close();
  }
  return { directory, databaseFile };
}

function records(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return Object.fromEntries(database.prepare(`
      SELECT provider || char(0) || thread_id || char(0) || turn_id AS key, record_json
      FROM journal_records ORDER BY provider, thread_id, turn_id
    `).all().map((row) => [row.key, JSON.parse(row.record_json)]));
  } finally {
    database.close();
  }
}

test("work-log account backfill infers Codex account from rate-limit account timeline", async () => {
  const state = await fixture();
  try {
    const result = await applyWorkLogAccountBackfill({
      databaseFile: state.databaseFile,
      backupRoot: path.join(state.directory, "migrations"),
      now: new Date("2026-08-01T02:00:00.000Z"),
    });
    assert.equal(result.applied, true);
    assert.equal(result.updated, 2);
    assert.equal(result.inferredAssigned, 1);
    assert.equal(result.exactPreserved, 1);
    const after = records(state.databaseFile);
    assert.match(after["codex\0thread-a\0turn-1"].accountKey, /^chatgpt:/u);
    assert.equal(after["codex\0thread-a\0turn-1"].accountAttribution, "inferred");
    assert.equal(after["codex\0thread-a\0turn-1"].observedAt, "2026-08-01T02:00:00.000Z");
    assert.equal(after["codex\0thread-a\0turn-2"].accountKey, "chatgpt:exact");
    assert.equal(after["codex\0thread-a\0turn-2"].accountAttribution, "exact");
    assert.notEqual(after["codex\0thread-a\0turn-2"].observedAt, "2026-08-01T02:00:00.000Z");
    assert.equal(after["claude\0thread-b\0turn-1"].accountKey, "");
    assert.equal(after["claude\0thread-b\0turn-1"].accountAttribution, "inferred");
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("work-log account backfill attaches the current Claude account when available", async () => {
  const state = await fixture();
  try {
    const result = await applyWorkLogAccountBackfill({
      databaseFile: state.databaseFile,
      backupRoot: path.join(state.directory, "migrations"),
      providerAccounts: [{
        provider: "claude",
        key: "anthropic:account-1",
        label: "owner@anthropic.example",
        type: "oauth",
        planType: "pro",
      }],
      now: new Date("2026-08-01T02:00:00.000Z"),
    });

    assert.equal(result.applied, true);
    assert.equal(result.inferredAssigned, 2);
    const after = records(state.databaseFile);
    assert.equal(after["claude\0thread-b\0turn-1"].accountKey, "anthropic:account-1");
    assert.equal(after["claude\0thread-b\0turn-1"].accountLabel, "owner@anthropic.example");
    assert.equal(after["claude\0thread-b\0turn-1"].accountType, "oauth");
    assert.equal(after["claude\0thread-b\0turn-1"].accountPlan, "pro");
    assert.equal(after["claude\0thread-b\0turn-1"].accountAttribution, "inferred");
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
