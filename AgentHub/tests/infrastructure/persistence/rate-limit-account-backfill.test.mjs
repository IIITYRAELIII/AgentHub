import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  applyTeamRateLimitAccountBackfill,
} from "../../../src/infrastructure/persistence/rate-limit-account-backfill.mjs";
import { FIRST_ACCOUNT_BOUNDARY, SECOND_ACCOUNT_BOUNDARY, policy } from "../../helpers/legacy-account-policy.mjs";
import { RateLimitHistoryStore } from "../../../src/infrastructure/persistence/rate-limit-history.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-team-account-backfill-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const store = new RateLimitHistoryStore({
    databaseFile,
    rawFile: path.join(directory, "rate-limits-raw.jsonl"),
    csvFile: path.join(directory, "rate-limits.csv"),
  });
  const response = { rateLimits: { limitId: "codex", primary: { usedPercent: 20 } } };
  await store.record(response, "2026-07-01T00:00:00.000Z", "codex");
  await store.record(response, "2026-07-20T00:00:00.000Z", "codex");
  await store.record(response, "2026-08-08T00:00:00.000Z", "codex");
  await store.close();
  return { directory, databaseFile };
}

async function labels(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database.prepare(`
      SELECT observed_at, account_label, account_plan, rows_json
      FROM rate_limit_snapshots ORDER BY observed_ms
    `).all().map((row) => ({
      observedAt: row.observed_at,
      label: row.account_label,
      plan: row.account_plan,
      rowLabel: JSON.parse(row.rows_json)[0].accountLabel,
    }));
  } finally {
    database.close();
  }
}

test("missing explicit legacy policy preserves every database byte and creates no migration", async t => {
  const state = await fixture();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const before = await readFile(state.databaseFile);
  assert.deepEqual(await applyTeamRateLimitAccountBackfill({ databaseFile: state.databaseFile, participant: "alpha" }),
    { applied: false, reason: "not-configured", participant: "alpha" });
  assert.deepEqual(await readFile(state.databaseFile), before);
});

test("team account backfill keeps named exceptions on the second account after August boundary", async () => {
  const state = await fixture();
  try {
    const result = await applyTeamRateLimitAccountBackfill({
      policy,
      databaseFile: state.databaseFile,
      participant: "Alpha",
      backupRoot: path.join(state.directory, "migrations"),
      now: new Date("2026-08-08T01:00:00.000Z"),
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.boundaries, [FIRST_ACCOUNT_BOUNDARY, SECOND_ACCOUNT_BOUNDARY]);
    assert.deepEqual(await labels(state.databaseFile), [
      { observedAt: "2026-07-01T00:00:00.000Z", label: "one@example.invalid", plan: "plus", rowLabel: "one@example.invalid" },
      { observedAt: "2026-07-20T00:00:00.000Z", label: "two@example.invalid", plan: "pro", rowLabel: "two@example.invalid" },
      { observedAt: "2026-08-08T00:00:00.000Z", label: "two@example.invalid", plan: "pro", rowLabel: "two@example.invalid" },
    ]);
    const repeated = await applyTeamRateLimitAccountBackfill({
      policy,
      databaseFile: state.databaseFile,
      participant: "alpha",
      backupRoot: path.join(state.directory, "migrations"),
    });
    assert.equal(repeated.reason, "already-applied");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("team account backfill also keeps Bravo on the second account", async () => {
  const state = await fixture();
  try {
    const result = await applyTeamRateLimitAccountBackfill({
      policy,
      databaseFile: state.databaseFile,
      participant: "Bravo",
      backupRoot: path.join(state.directory, "migrations"),
    });
    assert.equal(result.applied, true);
    assert.equal((await labels(state.databaseFile)).at(-1).label, "two@example.invalid");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("team account backfill maps Third participants to the Third account after August boundary", async () => {
  const state = await fixture();
  try {
    const result = await applyTeamRateLimitAccountBackfill({
      policy,
      databaseFile: state.databaseFile,
      participant: "Charlie",
      backupRoot: path.join(state.directory, "migrations"),
    });
    assert.equal(result.applied, true);
    assert.deepEqual((await labels(state.databaseFile)).map((row) => row.label), [
      "one@example.invalid",
      "two@example.invalid",
      "three@example.invalid",
    ]);
    assert.equal((await labels(state.databaseFile)).at(-1).plan, "pro");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("team account backfill maps Delta to the fourth account after August boundary", async () => {
  const state = await fixture();
  try {
    const result = await applyTeamRateLimitAccountBackfill({
      policy,
      databaseFile: state.databaseFile,
      participant: "delta",
      backupRoot: path.join(state.directory, "migrations"),
    });
    assert.equal(result.applied, true);
    assert.deepEqual((await labels(state.databaseFile)).map((row) => row.label), [
      "one@example.invalid",
      "two@example.invalid",
      "four@example.invalid",
    ]);
    assert.equal((await labels(state.databaseFile)).at(-1).plan, "pro");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("team account backfill maps Echo to the fourth account after August boundary", async () => {
  const state = await fixture();
  try {
    const result = await applyTeamRateLimitAccountBackfill({
      policy,
      databaseFile: state.databaseFile,
      participant: "Echo",
      backupRoot: path.join(state.directory, "migrations"),
    });
    assert.equal(result.applied, true);
    assert.deepEqual((await labels(state.databaseFile)).map((row) => row.label), [
      "one@example.invalid",
      "two@example.invalid",
      "four@example.invalid",
    ]);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("team account backfill returns every other participant to the first account", async () => {
  const state = await fixture();
  try {
    const result = await applyTeamRateLimitAccountBackfill({
      policy,
      databaseFile: state.databaseFile,
      participant: "OtherTeamMember",
      backupRoot: path.join(state.directory, "migrations"),
    });
    assert.equal(result.applied, true);
    assert.deepEqual((await labels(state.databaseFile)).map((row) => row.label), [
      "one@example.invalid",
      "two@example.invalid",
      "one@example.invalid",
    ]);
    const store = new RateLimitHistoryStore({
      databaseFile: state.databaseFile,
      rawFile: path.join(state.directory, "rate-limits-raw.jsonl"),
      csvFile: path.join(state.directory, "rate-limits.csv"),
    });
    const history = await store.read({
      range: "all",
      nowMs: Date.parse("2026-08-08T01:00:00.000Z"),
    });
    await store.close();
    const accounts = new Map(history.accounts.map((account) => [account.key, account.label]));
    assert.deepEqual(history.accountActivity.map((entry) => ({
      account: accounts.get(entry.accountKey),
      intervals: entry.intervals,
    })), [
      {
        account: "one@example.invalid",
        intervals: [
          { from: "2026-07-01T00:00:00.000Z", to: FIRST_ACCOUNT_BOUNDARY },
          { from: SECOND_ACCOUNT_BOUNDARY, to: "2026-08-08T01:00:00.000Z" },
        ],
      },
      {
        account: "two@example.invalid",
        intervals: [{ from: FIRST_ACCOUNT_BOUNDARY, to: SECOND_ACCOUNT_BOUNDARY }],
      },
    ]);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});
