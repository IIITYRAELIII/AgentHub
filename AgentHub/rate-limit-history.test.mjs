import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRateLimitRows,
  appendRawRateLimitSnapshot,
  claudeRateLimitRows,
  codexRateLimitRows,
  RateLimitHistoryStore,
  rateLimitResetCreditSummary,
  readRateLimitHistory,
} from "./rate-limit-history.mjs";

test("Agent Hub persists Codex and Claude limit snapshots every five minutes", async () => {
  const source = await readFile(new URL("./agent-hub-server.mjs", import.meta.url), "utf8");
  const telemetrySource = await readFile(
    new URL("./src/application/rate-limit-telemetry-service.mjs", import.meta.url),
    "utf8",
  );
  const desktopSystemSource = await readFile(
    new URL("./src/interfaces/desktop/desktop-system-service.mjs", import.meta.url),
    "utf8",
  );
  const processCaptureSource = await readFile(new URL("./process-capture.mjs", import.meta.url), "utf8");
  assert.match(source, /new RateLimitTelemetryService\(/u);
  assert.match(source, /new RateLimitHistoryStore\(/u);
  assert.match(telemetrySource, /intervalMs = 5 \* 60_000/u);
  assert.match(telemetrySource, /this\.historyStore\.record\(result, observedAt\)/u);
  assert.match(telemetrySource, /parseClaudeLimits\(await this\.readClaude\(\)\)/u);
  assert.match(telemetrySource, /this\.historyStore\.record\(\{ limits \}, observedAt, "claude"\)/u);
  assert.match(source, /readRateLimitHistory: \(params\) => rateLimitHistoryStore\.read\(params\)/u);
  assert.match(desktopSystemSource, /return this\.readRateLimitHistory\(\{/u);
  assert.match(source, /rateLimitTelemetry\.schedule\(1_000\)/u);
  assert.match(telemetrySource, /"--safe-mode", "--no-session-persistence"/u);
  assert.match(source, /stopProcess: \(worker\) => stopProcessTree\(worker\.pid\)/u);
  assert.match(
    processCaptureSource,
    /Promise\.resolve\(stopProcess\(worker\)\)[\s\S]*?\.finally\(\(\) => finish\(\{ code: null, error: timeoutError \}\)\)/u,
  );
});

test("all-time SQLite history samples before JSON parsing and preserves first and last", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-sampled-read-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
  const store = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    for (let index = 0; index < 180; index += 1) {
      await store.record({
        rateLimitsByLimitId: {
          codex: { limitId: "codex", primary: { usedPercent: index } },
        },
        rateLimitResetCredits: {
          credits: [{
            status: "available",
            expiresAt: (startedAt + (index + 1) * 3_600_000) / 1_000,
          }],
        },
      }, new Date(startedAt + index * 60_000).toISOString());
    }

    const originalParse = JSON.parse;
    let parsedSnapshots = 0;
    JSON.parse = (...args) => {
      parsedSnapshots += 1;
      return originalParse(...args);
    };
    let history;
    try {
      history = await store.read({
        range: "all",
        nowMs: startedAt + 180 * 60_000,
        maxPointsPerSeries: 50,
      });
    } finally {
      JSON.parse = originalParse;
    }

    const primary = history.series.find((series) => series.id === "codex:primary");
    assert.equal(primary.points.length, 50);
    assert.equal(primary.points[0].usedPercent, 0);
    assert.equal(primary.points.at(-1).usedPercent, 179);
    assert.ok(parsedSnapshots <= 51, `parsed ${parsedSnapshots} snapshots for a 50-point query`);
    assert.deepEqual(history.resetCredits, {
      availableCount: 1,
      nearestExpiresAt: new Date(startedAt + 180 * 3_600_000).toISOString(),
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite rate-limit store keeps full snapshots and serves a bounded recent range", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-store-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  const nowMs = Date.parse("2026-08-02T12:00:00.000Z");
  const store = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    for (let hour = 72; hour >= 0; hour -= 1) {
      await store.record({
        rateLimitsByLimitId: {
          codex: { limitId: "codex", primary: { usedPercent: hour }, },
        },
        futureResponseField: { hour },
      }, new Date(nowMs - hour * 3_600_000).toISOString());
    }
    const history = await store.read({ range: "6h", nowMs, maxPointsPerSeries: 100 });
    assert.deepEqual(
      history.series[0].points.map((point) => point.usedPercent),
      [6, 5, 4, 3, 2, 1, 0],
    );
    await store.rebuildCompatibilityExports();
    const raw = (await readFile(rawFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(raw.length, 73);
    assert.deepEqual(raw.at(-1).response.futureResponseField, { hour: 0 });
    // Once the raw export has been migrated, a recent request reads indexed
    // SQLite rows rather than parsing the complete append-only JSONL prefix.
    await writeFile(rawFile, "not valid JSON\n".repeat(10_000), "utf8");
    const indexed = await store.read({ range: "6h", nowMs, maxPointsPerSeries: 100 });
    assert.equal(indexed.series[0].points.length, 7);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy raw history migrates same-time snapshots without dropping full responses", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-migrate-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  const observedAt = "2026-08-02T12:00:00.000Z";
  await writeFile(rawFile, [
    { observedAt, provider: "codex", response: { rateLimits: { limitId: "codex", primary: { usedPercent: 10 } }, extra: "first" } },
    { observedAt, provider: "codex", response: { rateLimits: { limitId: "spark", primary: { usedPercent: 20 } }, extra: "second" } },
  ].map(JSON.stringify).join("\n") + "\n", "utf8");
  const store = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    const history = await store.read({ range: "all", nowMs: Date.parse("2026-08-03T00:00:00.000Z") });
    assert.equal(history.series.length, 2);
    const restored = (await readFile(rawFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(restored.map((record) => record.response.extra).sort(), ["first", "second"]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart repairs CSV after a crash between raw and CSV exports", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-recover-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  let exports = 0;
  const interrupted = new RateLimitHistoryStore({
    databaseFile,
    rawFile,
    csvFile,
    afterRawExport: async () => {
      exports += 1;
      if (exports === 1) throw new Error("simulated crash after raw export");
    },
  });
  try {
    await interrupted.record(
      { rateLimits: { limitId: "codex", primary: { usedPercent: 25 } } },
      "2026-08-02T12:00:00.000Z",
    );
    await assert.rejects(
      interrupted.rebuildCompatibilityExports(),
      /simulated crash/u,
    );
  } finally {
    await interrupted.close();
  }
  const recovered = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    const history = await recovered.read({ range: "all", nowMs: Date.parse("2026-08-03T00:00:00.000Z") });
    assert.equal(history.series[0].points[0].usedPercent, 25);
    assert.match(await readFile(csvFile, "utf8"), /2026-08-02T12:00:00\.000Z/u);
    assert.equal((await readFile(rawFile, "utf8")).trim().split("\n").length, 1);
  } finally {
    await recovered.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime records avoid full compatibility exports until explicitly requested", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-runtime-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  const store = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    await store.record(
      { rateLimits: { limitId: "codex", primary: { usedPercent: 12 } } },
      "2026-08-02T12:00:00.000Z",
    );
    await assert.rejects(readFile(rawFile, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(csvFile, "utf8"), { code: "ENOENT" });
    await store.rebuildCompatibilityExports();
    assert.match(await readFile(rawFile, "utf8"), /2026-08-02T12:00:00\.000Z/u);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retired compatibility exports stay absent after later SQLite writes and restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-retire-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  let store = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    await store.record(
      { rateLimits: { limitId: "codex", primary: { usedPercent: 12 } } },
      "2026-08-02T12:00:00.000Z",
    );
    await store.rebuildCompatibilityExports();
    const retired = await store.retireCompatibilityExports({ now: new Date("2026-08-02T13:00:00Z") });
    assert.equal(retired.removed.length, 2);
    await store.record(
      { rateLimits: { limitId: "codex", primary: { usedPercent: 13 } } },
      "2026-08-02T13:00:00.000Z",
    );
    await store.close();
    store = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
    const history = await store.read({ range: "all", nowMs: Date.parse("2026-08-03T00:00:00Z") });
    assert.equal(history.series[0].points.length, 2);
    await assert.rejects(readFile(rawFile, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(csvFile, "utf8"), { code: "ENOENT" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing a rate-limit store waits for an accepted write", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-close-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  const store = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  const pending = store.record(
    { rateLimits: { limitId: "codex", primary: { usedPercent: 51 } } },
    "2026-08-02T12:00:00.000Z",
  );
  await Promise.all([pending, store.close()]);
  const reopened = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    const history = await reopened.read({ range: "all", nowMs: Date.parse("2026-08-03T00:00:00.000Z") });
    assert.equal(history.series[0].points[0].usedPercent, 51);
  } finally {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite busy during migration is retried instead of dropping the poll", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-busy-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  const originalExec = DatabaseSync.prototype.exec;
  let failOnce = true;
  DatabaseSync.prototype.exec = function patchedExec(sql) {
    if (failOnce && sql === "BEGIN IMMEDIATE") {
      failOnce = false;
      throw new Error("SQLITE_BUSY: simulated competing writer");
    }
    return originalExec.call(this, sql);
  };
  const store = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    const result = await store.record(
      { rateLimits: { limitId: "codex", primary: { usedPercent: 9 } } },
      "2026-08-02T12:00:00.000Z",
    );
    assert.equal(result.recorded, true);
    assert.equal(failOnce, false);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate stores converge raw and CSV after concurrent poll and backfill writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-concurrent-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const rawFile = path.join(directory, "rate-limits-raw.jsonl");
  const csvFile = path.join(directory, "rate-limits.csv");
  const poll = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  const backfill = new RateLimitHistoryStore({ databaseFile, rawFile, csvFile });
  try {
    await Promise.all([
      poll.record({ rateLimits: { limitId: "codex", primary: { usedPercent: 33 } } }, "2026-08-02T12:00:00.000Z"),
      backfill.record({ rateLimits: { limitId: "spark", primary: { usedPercent: 7 } } }, "2026-08-02T12:05:00.000Z"),
    ]);
    await poll.rebuildCompatibilityExports();
    const raw = (await readFile(rawFile, "utf8")).trim().split("\n").map(JSON.parse);
    const csv = await readFile(csvFile, "utf8");
    assert.equal(raw.length, 2);
    assert.match(csv, /,codex,/u);
    assert.match(csv, /,spark,/u);
  } finally {
    await poll.close();
    await backfill.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex limit snapshots become primary and secondary history rows", () => {
  const rows = codexRateLimitRows({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 25, resetsAt: 123 },
        secondary: { usedPercent: 60, resetsAt: 456 },
      },
    },
  }, "2026-07-29T00:00:00.000Z");

  assert.deepEqual(rows, [
    {
      observedAt: "2026-07-29T00:00:00.000Z",
      provider: "codex",
      limitId: "codex",
      limitName: "Codex",
      window: "primary",
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: 123,
      reachedType: "",
    },
    {
      observedAt: "2026-07-29T00:00:00.000Z",
      provider: "codex",
      limitId: "codex",
      limitName: "Codex",
      window: "secondary",
      usedPercent: 60,
      remainingPercent: 40,
      resetsAt: 456,
      reachedType: "",
    },
  ]);
});

test("Claude limit snapshots become session, weekly, and model history rows", () => {
  const limits = [
    { kind: "session", model: null, usedPercent: 12, resetsText: "Jul 30, 8:00pm" },
    { kind: "week (all models)", model: null, usedPercent: 34, resetsText: "Aug 3, 1:00am" },
    { kind: "week (Fable)", model: "Fable", usedPercent: 5, resetsText: null },
  ];
  assert.deepEqual(
    claudeRateLimitRows(limits, "2026-07-30T12:00:00.000Z")
      .map(({ provider, limitId, limitName, window, usedPercent }) => ({
        provider, limitId, limitName, window, usedPercent,
      })),
    [
      {
        provider: "claude",
        limitId: "claude:session",
        limitName: "CLAUDE",
        window: "session",
        usedPercent: 12,
      },
      {
        provider: "claude",
        limitId: "claude:week",
        limitName: "CLAUDE",
        window: "week",
        usedPercent: 34,
      },
      {
        provider: "claude",
        limitId: "claude:model:fable",
        limitName: "CLAUDE",
        window: "Fable",
        usedPercent: 5,
      },
    ],
  );
});

test("limit history writes one CSV header and appends later samples", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-"));
  const target = path.join(directory, "rate-limits.csv");
  const sample = [{
    observedAt: "2026-07-29T00:00:00.000Z",
    provider: "codex",
    limitId: "codex",
    limitName: "Codex, Team",
    window: "primary",
    usedPercent: 25,
    remainingPercent: 75,
    resetsAt: 123,
    reachedType: "",
  }];

  await appendRateLimitRows(target, sample);
  await appendRateLimitRows(target, sample);
  const text = await readFile(target, "utf8");
  assert.equal(text.match(/^observedAt,/gmu)?.length, 1);
  assert.equal(text.match(/2026-07-29T00:00:00\.000Z/gmu)?.length, 2);
  assert.match(text, /"Codex, Team"/u);
});

test("raw limit history preserves the complete response as JSONL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-raw-"));
  const target = path.join(directory, "rate-limits-raw.jsonl");
  const response = {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 25, resetsAt: 123, futureField: "preserved" },
      },
    },
    rateLimitResetCredits: { availableCount: 7 },
    unknownTopLevelField: { nested: true },
  };

  await appendRawRateLimitSnapshot(target, response, "2026-07-29T00:00:00.000Z");
  await appendRawRateLimitSnapshot(target, response, "2026-07-29T00:05:00.000Z");

  const lines = (await readFile(target, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    observedAt: "2026-07-29T00:00:00.000Z",
    provider: "codex",
    response,
  });
  assert.equal(lines[1].observedAt, "2026-07-29T00:05:00.000Z");
});

test("reset credit summary uses the nearest available expiration", () => {
  const nowMs = Date.parse("2026-07-29T00:00:00.000Z");
  assert.deepEqual(rateLimitResetCreditSummary({
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { status: "available", expiresAt: (nowMs + 48 * 3600_000) / 1000 },
        { status: "used", expiresAt: (nowMs + 1 * 3600_000) / 1000 },
        { status: "available", expiresAt: (nowMs + 24 * 3600_000) / 1000 },
      ],
    },
  }, nowMs), {
    availableCount: 2,
    nearestExpiresAt: "2026-07-30T00:00:00.000Z",
  });
});

test("rate limit history filters ranges and returns chart-safe series", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limit-chart-"));
  const target = path.join(directory, "rate-limits-raw.jsonl");
  const nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  for (const [hoursAgo, usedPercent] of [[30, 10], [12, 25], [1, 40]]) {
    await appendRawRateLimitSnapshot(target, {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent },
        },
        spark: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 0 },
        },
      },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{ status: "available", expiresAt: (nowMs + 24 * 3600_000) / 1000 }],
      },
    }, new Date(nowMs - hoursAgo * 3600_000).toISOString());
  }

  const history = await readRateLimitHistory(target, {
    range: "24h",
    nowMs,
    maxPointsPerSeries: 100,
  });
  assert.equal(history.range, "24h");
  assert.equal(history.series.length, 2);
  assert.deepEqual(
    history.series.find((item) => item.id === "codex:primary").points
      .map((point) => point.usedPercent),
    [25, 40],
  );
  assert.equal(history.series.find((item) => item.name === "Spark").points.length, 2);
  assert.deepEqual(history.resetCredits, {
    availableCount: 1,
    nearestExpiresAt: "2026-07-31T00:00:00.000Z",
  });
});

test("rate limit history combines Codex and Claude series without losing Codex credits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-provider-limits-"));
  const target = path.join(directory, "rate-limits-raw.jsonl");
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  await appendRawRateLimitSnapshot(target, {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 48, resetsAt: Date.parse("2026-07-31T12:00:00.000Z") / 1000 },
      },
    },
    rateLimitResetCredits: { availableCount: 1 },
  }, "2026-07-30T11:50:00.000Z");
  await appendRawRateLimitSnapshot(target, {
    limits: [
      { kind: "session", model: null, usedPercent: 17, resetsText: "Jul 30, 8:00pm" },
      { kind: "week (all models)", model: null, usedPercent: 31, resetsText: "Aug 3, 1:00am" },
    ],
  }, "2026-07-30T11:55:00.000Z", "claude");

  const history = await readRateLimitHistory(target, { range: "24h", nowMs });
  assert.deepEqual(
    history.series.map(({ id, name, window, points }) => ({
      id, name, window, usedPercent: points.at(-1).usedPercent,
    })),
    [
      { id: "codex:primary", name: "CODEX", window: "primary", usedPercent: 48 },
      { id: "claude:session", name: "CLAUDE", window: "session", usedPercent: 17 },
      { id: "claude:week", name: "CLAUDE", window: "week", usedPercent: 31 },
    ],
  );
  assert.equal(
    history.series.find((item) => item.id === "codex:primary").points.at(-1).resetsAt,
    "2026-07-31T12:00:00.000Z",
  );
  assert.equal(
    history.series.find((item) => item.id === "claude:week").points.at(-1).resetsText,
    "Aug 3, 1:00am",
  );
  assert.equal(history.resetCredits.availableCount, 1);
});

test("missing rate limit history returns an empty payload", async () => {
  const history = await readRateLimitHistory(
    path.join(os.tmpdir(), `missing-limit-history-${Date.now()}.jsonl`),
    { range: "all", nowMs: Date.parse("2026-07-30T00:00:00.000Z") },
  );
  assert.deepEqual(history.series, []);
  assert.equal(history.from, null);
});
