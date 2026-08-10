import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function journalViewApi() {
  const source = await readFile(
    new URL("../../assets/mini-app/journal-view-controller.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { Date, Intl, Set, String, window });
  return window.AgentHubJournalView;
}

test("journal grouping keeps legacy values and defaults new state to workspaces", async () => {
  const api = await journalViewApi();
  assert.equal(api.normalizeGrouping("task"), "task");
  assert.equal(api.normalizeGrouping("date"), "date");
  assert.equal(api.normalizeGrouping("unknown"), "task");
  assert.equal(api.groupingLabel("task"), "Воркспейсы");
  assert.equal(api.primaryColumn("month"), "Месяц");
});

test("day grouping keeps historical days lazy while aggregate views require them", async () => {
  const api = await journalViewApi();
  assert.equal(api.requiresCompleteHistory("date"), false);
  assert.equal(api.requiresCompleteHistory("task"), true);
  assert.equal(api.requiresCompleteHistory("week"), true);
  assert.equal(api.requiresCompleteHistory("month"), true);
});

test("journal header counts current catalog streams instead of historical tasks", async () => {
  const api = await journalViewApi();
  assert.equal(api.streamCount([
    { id: "one", streams: [{ id: "a" }, { id: "b" }] },
    { id: "two", streams: [{ id: "c" }] },
  ]), 3);
  assert.equal(api.streamCount(null), 0);
});

test("journal periods use Monday weeks and calendar months", async () => {
  const api = await journalViewApi();
  assert.deepEqual(
    { ...api.periodIdentity("10.08.2026", "week") },
    { key: "2026-08-10", sort: Date.UTC(2026, 7, 10), label: "10.08.2026 — 16.08.2026" },
  );
  assert.deepEqual(
    { ...api.periodIdentity("31.08.2026", "month") },
    { key: "2026-08", sort: Date.UTC(2026, 7, 1), label: "август 2026 г." },
  );
});

test("journal summary counts only missing-credit gaps", async () => {
  const api = await journalViewApi();
  const summary = api.summarizeGroups([
    { credits: 10, durationSeconds: 60, turnCount: 2, unknownCredits: 1, unknownDurations: 2 },
    { credits: 5, durationSeconds: 30, turnCount: 1, unknownCredits: 0, unknownDurations: 4 },
  ]);
  assert.deepEqual(
    { ...summary },
    {
      count: 2,
      credits: 15,
      knownCredits: 2,
      durationSeconds: 90,
      knownDurations: 2,
      gaps: 1,
      turns: 3,
    },
  );
});

test("journal summary keeps unknown totals distinct from zero", async () => {
  const api = await journalViewApi();
  const summary = api.summarizeGroups([
    { credits: null, durationSeconds: null, turnCount: 1, unknownCredits: 1 },
  ]);
  assert.equal(summary.credits, 0);
  assert.equal(summary.knownCredits, 0);
  assert.equal(summary.knownDurations, 0);
  assert.equal(summary.gaps, 1);
});

test("journal profile compares items only within one provider", async () => {
  const api = await journalViewApi();
  const codex = { provider: "codex", title: "Codex" };
  const claude = { provider: "claude", title: "Claude" };
  assert.deepEqual(Array.from(api.profileCohort([codex, claude], "codex")), [codex]);
  assert.deepEqual(Array.from(api.profileCohort(null, "codex")), []);
});
