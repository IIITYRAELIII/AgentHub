import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendRateLimitRows, codexRateLimitRows } from "./rate-limit-history.mjs";

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
