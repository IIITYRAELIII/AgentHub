import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRateLimitRows,
  appendRawRateLimitSnapshot,
  claudeRateLimitRows,
  codexRateLimitRows,
  rateLimitResetCreditSummary,
  readRateLimitHistory,
} from "./rate-limit-history.mjs";

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
      codex: { limitId: "codex", primary: { usedPercent: 48 } },
    },
    rateLimitResetCredits: { availableCount: 1 },
  }, "2026-07-30T11:50:00.000Z");
  await appendRawRateLimitSnapshot(target, {
    limits: [
      { kind: "session", model: null, usedPercent: 17 },
      { kind: "week (all models)", model: null, usedPercent: 31 },
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
