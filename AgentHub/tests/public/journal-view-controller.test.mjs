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

test("every journal grouping stays on the compact summary", async () => {
  const api = await journalViewApi();
  assert.equal(api.requiresCompleteHistory("date"), false);
  assert.equal(api.requiresCompleteHistory("stream"), false);
  assert.equal(api.requiresCompleteHistory("workspace"), false);
  assert.equal(api.requiresCompleteHistory("week"), false);
  assert.equal(api.requiresCompleteHistory("month"), false);
});

test("virtual journal groups streams by workspace and sorts them by included usage", async () => {
  const api = await journalViewApi();
  const bucket = (overrides) => ({
    date: "06.09.2026",
    dayMs: Date.UTC(2026, 8, 6),
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    workspaceKind: "catalog",
    streamId: "stream-low",
    streamDisplayName: "Low",
    streamOrdinal: 1,
    provider: "codex",
    turnCount: 1,
    credits: 10,
    knownCredits: 1,
    unknownCredits: 0,
    durationSeconds: 20,
    knownDurations: 1,
    unknownDurations: 0,
    latestAt: Date.UTC(2026, 8, 6, 10),
    fileTouches: 2,
    knownFileTouches: 1,
    changedLines: 5,
    knownChangedLines: 1,
    subagentTurns: 0,
    knownSubagentTurns: 1,
    skillNames: ["journal"],
    mcpCallCount: 1,
    mcpTools: ["agent_hub/hub_task_get"],
    mcpFailures: 0,
    knownToolMetricTurns: 1,
    ...overrides,
  });
  const summary = { version: 1, buckets: [
    bucket({}),
    bucket({
      streamId: "stream-high",
      streamDisplayName: "High",
      credits: 30,
      latestAt: Date.UTC(2026, 8, 6, 9),
    }),
    bucket({
      streamId: "stream-claude",
      streamDisplayName: "Claude",
      provider: "claude",
      credits: 100,
      durationSeconds: 50,
      latestAt: Date.UTC(2026, 8, 6, 11),
    }),
  ] };

  const [workspaceScope] = api.virtualJournalScopes(summary, "workspace", {
    includeClaudeUsage: false,
  });
  assert.equal(workspaceScope.label, "Agent HUB");
  assert.equal(workspaceScope.turnCount, 3);
  assert.equal(workspaceScope.durationSeconds, 90);
  assert.equal(workspaceScope.credits, 40);
  assert.equal(workspaceScope.fileTouches, 6);
  assert.equal(workspaceScope.changedLines, 15);
  assert.equal(workspaceScope.skillCount, 1);
  assert.equal(workspaceScope.mcpCallCount, 3);
  assert.deepEqual(
    Array.from(workspaceScope.workspaces[0].streams, (stream) => stream.id),
    ["stream-high", "stream-low", "stream-claude"],
  );

  const [dayScope] = api.virtualJournalScopes(summary, "date", {
    includeClaudeUsage: false,
  });
  assert.equal(dayScope.label, "06.09.2026");
  assert.equal(dayScope.workspaces[0].streams.length, 3);
  assert.equal(dayScope.fromMs, new Date(2026, 8, 6).getTime());
  assert.equal(dayScope.toMs, new Date(2026, 8, 7).getTime());
  assert.deepEqual(Array.from(dayScope.dateKeys), ["06.09.2026"]);
});

test("Claude Work virtual grouping keeps a provider-bounded lazy query", async () => {
  const api = await journalViewApi();
  const [scope] = api.virtualJournalScopes({ version: 1, buckets: [{
    date: "06.09.2026",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    workspaceKind: "catalog",
    streamId: "stream-1",
    streamDisplayName: "Release Manager",
    provider: "claude",
    turnCount: 1,
    credits: 12,
    knownCredits: 1,
    unknownCredits: 0,
    durationSeconds: 15,
    knownDurations: 1,
    unknownDurations: 0,
    latestAt: Date.UTC(2026, 8, 6, 10),
  }] }, "workspace", { groupClaude: true });
  const workspace = scope.workspaces[0];
  assert.equal(workspace.id, "claude-work");
  assert.equal(workspace.queryWorkspaceId, "");
  assert.deepEqual(Array.from(workspace.providers), ["claude"]);
  assert.equal(workspace.streams[0].queryStreamId, "");
  assert.deepEqual(Array.from(workspace.streams[0].providers), ["claude"]);
  const query = api.virtualTurnQuery(scope, workspace, workspace.streams[0]);
  assert.deepEqual({ ...query, dateKeys: Array.from(query.dateKeys) }, {
    workspaceId: "",
    streamId: "",
    provider: "claude",
    fromMs: 0,
    toMs: 0,
    dateKeys: [],
  });
});

test("temporal queries keep exact visible dates in positive and negative UTC offsets", {
  concurrency: false,
}, async () => {
  const previous = process.env.TZ;
  try {
    for (const [timeZone, expectedStart] of [
      ["Asia/Yekaterinburg", "2026-09-05T19:00:00.000Z"],
      ["America/New_York", "2026-09-06T04:00:00.000Z"],
    ]) {
      process.env.TZ = timeZone;
      const api = await journalViewApi();
      const summary = { version: 1, buckets: [{
        date: "09.09.2026",
        workspaceId: "workspace-1",
        workspaceName: "Agent HUB",
        workspaceKind: "catalog",
        streamId: "stream-1",
        streamDisplayName: "Log",
        provider: "codex",
        turnCount: 1,
        credits: 1,
        knownCredits: 1,
        durationSeconds: 1,
        knownDurations: 1,
      }] };
      const [day] = api.virtualJournalScopes({
        ...summary,
        buckets: [{ ...summary.buckets[0], date: "06.09.2026" }],
      }, "date");
      const [week] = api.virtualJournalScopes(summary, "week");
      const [month] = api.virtualJournalScopes(summary, "month");
      assert.equal(new Date(day.fromMs).toISOString(), expectedStart, timeZone);
      assert.deepEqual(Array.from(day.dateKeys), ["06.09.2026"], timeZone);
      assert.deepEqual(Array.from(week.dateKeys), [
        "07.09.2026", "08.09.2026", "09.09.2026", "10.09.2026",
        "11.09.2026", "12.09.2026", "13.09.2026",
      ], timeZone);
      assert.equal(month.dateKeys.length, 30, timeZone);
      assert.equal(month.dateKeys[0], "01.09.2026", timeZone);
      assert.equal(month.dateKeys.at(-1), "30.09.2026", timeZone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("aggregate journal hydration bounds fetch and DOM work and can be superseded", async () => {
  const api = await journalViewApi();
  const entries = Array.from({ length: 7 }, (_, index) => ({ date: `day-${index}` }));
  const cache = new Map([["day-0", "cached-0"]]);
  const materialized = [];
  let activeFetches = 0;
  let maxFetches = 0;
  let yields = 0;
  const completed = await api.hydrateLazyDays(entries, {
    dateFor: (entry) => entry.date,
    cachedHtml: (date) => cache.get(date),
    fetchHtml: async (date) => {
      activeFetches += 1;
      maxFetches = Math.max(maxFetches, activeFetches);
      await Promise.resolve();
      activeFetches -= 1;
      return `html-${date}`;
    },
    rememberHtml: (date, html) => cache.set(date, html),
    materialize: (entry, html) => materialized.push(`${entry.date}:${html}`),
    yieldControl: async () => { yields += 1; },
    batchSize: 2,
  });

  assert.equal(completed, true);
  assert.equal(maxFetches, 2);
  assert.equal(yields, 3);
  assert.equal(materialized.length, 7);
  assert.equal(materialized[0], "day-0:cached-0");

  const superseded = [];
  let current = true;
  const result = await api.hydrateLazyDays(entries, {
    dateFor: (entry) => entry.date,
    cachedHtml: (date) => cache.get(date),
    fetchHtml: async () => "unused",
    rememberHtml: () => {},
    materialize: (entry) => superseded.push(entry.date),
    yieldControl: async () => { current = false; },
    isCurrent: () => current,
    batchSize: 2,
  });
  assert.equal(result, false);
  assert.deepEqual(superseded, ["day-0", "day-1"]);
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

test("journal duration keeps totals longer than a day in hours", async () => {
  const api = await journalViewApi();
  assert.equal(api.formatDurationHours(106_511), "29 ч 35 мин 11 с");
  assert.equal(api.formatDurationHours(3_600), "1 ч");
  assert.equal(api.formatDurationHours(0), "0 с");
});

test("journal turn identity keeps root and child Threads with the same turn id distinct", async () => {
  const api = await journalViewApi();
  const root = api.turnIdentity({
    workLogTurnProvider: "codex",
    workLogTurnThreadId: "thread-root",
    workLogTurnId: "shared-turn",
  });
  const child = api.turnIdentity({
    workLogTurnProvider: "codex",
    workLogTurnThreadId: "thread-child",
    workLogTurnId: "shared-turn",
  });
  assert.notEqual(root, child);
  assert.equal(root, "codex\u001fthread-root\u001fshared-turn");
  assert.equal(api.turnIdentity({ workLogTurnId: "shared-turn" }, {
    provider: "codex",
    threadId: "thread-root",
  }), root);
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
    { credits: 10, quotaUnits: 12, durationSeconds: 60, turnCount: 2,
      unknownCredits: 1, unknownQuotaUnits: 0, uncalibratedCount: 1, unknownDurations: 2 },
    { credits: 5, quotaUnits: 3, durationSeconds: 30, turnCount: 1,
      unknownCredits: 0, unknownQuotaUnits: 0, uncalibratedCount: 0, unknownDurations: 4 },
  ]);
  assert.deepEqual(
    { ...summary },
    {
      count: 2,
      credits: 15,
      knownCredits: 2,
      quotaUnits: 15,
      knownQuotaUnits: 2,
      unknownQuotaUnits: 0,
      uncalibratedCount: 1,
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

test("forced journal refresh waits for the queued fresh projection", async () => {
  const api = await journalViewApi();
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const calls = [];
  const refresh = api.createQueuedJournalRefresh(async (options) => {
    calls.push({ ...options });
    if (calls.length === 1) await firstGate;
    if (calls.length === 2) await secondGate;
    return calls.length;
  });

  const first = refresh.refresh();
  const forced = refresh.refresh({ force: true });
  let forcedResolved = false;
  void forced.then(() => { forcedResolved = true; });

  await Promise.resolve();
  assert.equal(calls.length, 1);
  releaseFirst();
  await first;
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(forcedResolved, false);

  releaseSecond();
  assert.equal(await forced, 2);
  assert.deepEqual(calls, [
    { force: false, announce: false },
    { force: true, announce: false },
  ]);
});
