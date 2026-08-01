import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RateLimitHistoryStore, readRateLimitHistory } from "./rate-limit-history.mjs";
import {
  applyRateLimitRolloutBackfill,
  buildRateLimitRolloutBackfill,
  rateLimitRecordFromRolloutEvent,
} from "./rate-limit-rollout-backfill.mjs";

function event(timestamp, usedPercent, limitId = "codex", limitName = null) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: limitId,
        limit_name: limitName,
        primary: {
          used_percent: usedPercent,
          window_minutes: 10080,
          resets_at: 123,
        },
        secondary: null,
        plan_type: "pro",
      },
    },
  };
}

test("rollout rate-limit events become raw-history records", () => {
  const record = rateLimitRecordFromRolloutEvent(
    event("2026-07-01T00:00:00.000Z", 42),
  );
  assert.equal(record.observedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(record.source, "rollout-backfill");
  assert.equal(record.response.rateLimitsByLimitId.codex.primary.usedPercent, 42);
  assert.equal(record.response.rateLimitsByLimitId.codex.primary.windowDurationMins, 10080);
});

test("rollout backfill refuses the unsafe direct raw/CSV append path", async () => {
  await assert.rejects(
    applyRateLimitRolloutBackfill({ migration: { records: [{ observedAt: "2026-08-02T00:00:00.000Z" }] } }),
    /canonical history store/u,
  );
});

test("rollout backfill samples five-minute intervals, deduplicates and sorts history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limit-backfill-"));
  try {
    const sessions = path.join(root, "sessions");
    const archived = path.join(root, "archived");
    const rawHistoryFile = path.join(root, "data", "rate-limits-raw.jsonl");
    const csvHistoryFile = path.join(root, "data", "rate-limits.csv");
    const databaseFile = path.join(root, "data", "journal.sqlite");
    await mkdir(sessions, { recursive: true });
    await mkdir(archived, { recursive: true });
    await mkdir(path.dirname(rawHistoryFile), { recursive: true });
    await writeFile(path.join(sessions, "one.jsonl"), [
      event("2026-07-01T00:01:00.000Z", 10),
      event("2026-07-01T00:04:00.000Z", 11),
      event("2026-07-01T00:06:00.000Z", 12),
    ].map(JSON.stringify).join("\n"), "utf8");
    await writeFile(path.join(archived, "spark.jsonl"), `${JSON.stringify(
      event("2026-07-01T00:07:00.000Z", 3, "codex_bengalfox", "GPT-5.3-Codex-Spark"),
    )}\n`, "utf8");
    await writeFile(rawHistoryFile, `${JSON.stringify({
      observedAt: "2026-07-01T00:02:00.000Z",
      provider: "codex",
      response: {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 10 },
          },
        },
      },
    })}\n`, "utf8");

    const migration = await buildRateLimitRolloutBackfill({
      rolloutRoots: [sessions, archived],
      rawHistoryFile,
    });
    assert.equal(migration.report.scannedFiles, 2);
    assert.equal(migration.report.parsedEvents, 4);
    assert.equal(migration.report.sampledSnapshots, 3);
    assert.equal(migration.report.importedSnapshots, 2);
    assert.deepEqual(migration.report.limitIds, ["codex", "codex_bengalfox"]);

    const store = new RateLimitHistoryStore({ databaseFile, rawFile: rawHistoryFile, csvFile: csvHistoryFile });
    const applied = await applyRateLimitRolloutBackfill({ migration, rawHistoryFile, csvHistoryFile, store });
    await store.rebuildCompatibilityExports();
    await store.close();
    assert.deepEqual(applied, { rawRecords: 2, csvRows: 2 });
    const history = await readRateLimitHistory(rawHistoryFile, {
      range: "all",
      nowMs: Date.parse("2026-07-02T00:00:00.000Z"),
    });
    assert.deepEqual(
      history.series.find((series) => series.id === "codex:primary").points
        .map((point) => point.usedPercent),
      [10, 12],
    );
    assert.match(await readFile(csvHistoryFile, "utf8"), /codex_bengalfox/u);

    const second = await buildRateLimitRolloutBackfill({
      rolloutRoots: [sessions, archived],
      rawHistoryFile,
    });
    assert.equal(second.report.importedSnapshots, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
