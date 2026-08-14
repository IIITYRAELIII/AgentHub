import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function journalViewApi() {
  const source = await readFile(
    new URL("../../assets/web-app/journal-view-controller.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { Date, Intl, Set, String, window });
  return window.AgentHubJournalView;
}

test("journal grouping exposes stable stream and workspace modes", async () => {
  const api = await journalViewApi();
  assert.equal(api.normalizeGrouping("task"), "workspace");
  assert.equal(api.normalizeGrouping("stream"), "stream");
  assert.equal(api.normalizeGrouping("workspace"), "workspace");
  assert.equal(api.normalizeGrouping("date"), "date");
  assert.equal(api.normalizeGrouping("unknown"), "workspace");
  assert.equal(api.groupingLabel("stream"), "Потоки");
  assert.equal(api.groupingLabel("workspace"), "Воркспейсы");
  assert.equal(api.primaryColumn("month"), "Месяц");
});

test("stream and workspace identities use stable catalog ids", async () => {
  const api = await journalViewApi();
  const row = {
    provider: "codex",
    threadId: "thread-new",
    workspaceId: "workspace-1",
    streamId: "stream-1",
  };
  assert.deepEqual(
    { ...api.groupIdentity(row, "stream") },
    {
      key: "stream\u001fworkspace-1\u001fstream-1",
      provider: "stream",
      threadId: "workspace-1:stream-1",
    },
  );
  assert.deepEqual(
    { ...api.groupIdentity(row, "workspace") },
    { key: "workspace\u001fworkspace-1", provider: "workspace", threadId: "workspace-1" },
  );
});

test("Claude Work grouping remains available in both hierarchy modes", async () => {
  const api = await journalViewApi();
  const row = {
    provider: "claude",
    threadId: "thread-1",
    workspaceId: "workspace-1",
    streamId: "stream-1",
  };
  const expected = { key: "claude\u001fwork", provider: "claude", threadId: "work" };
  assert.deepEqual({ ...api.groupIdentity(row, "stream", true) }, expected);
  assert.deepEqual({ ...api.groupIdentity(row, "workspace", true) }, expected);
});

test("day grouping keeps historical days lazy while aggregate views require them", async () => {
  const api = await journalViewApi();
  assert.equal(api.requiresCompleteHistory("date"), false);
  assert.equal(api.requiresCompleteHistory("stream"), true);
  assert.equal(api.requiresCompleteHistory("workspace"), true);
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

test("grouped turn prefers total credits including subagents", async () => {
  const api = await journalViewApi();
  assert.equal(api.turnDisplayCredits({
    workLogTurnCredits: "194.8",
    workLogTurnTotalCredits: "1258.4",
  }), 1258.4);
  assert.equal(api.turnDisplayCredits({ workLogTurnCredits: "194.8" }), 194.8);
  assert.equal(api.turnDisplayCredits({ workLogTurnTotalCredits: "broken" }), null);
  assert.equal(api.turnDisplayCredits({}), null);
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
