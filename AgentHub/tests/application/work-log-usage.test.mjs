import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm as removeFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  applyWorkLogUsage,
  buildWorkLogUsageHistory,
  groupWorkLogUsageByWorkspace,
  normalizeWorkLogId,
  projectWorkLogRateLimits,
  projectWorkLogUsage,
  restoreLegacyOutcomes,
  searchWorkLogRecords,
  workLogTurnKey,
} from "../../src/application/work-log-usage-projection.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";

const openStores = new Set();
function WorkLogUsageStore(options) {
  const store = createWorkLogUsageStore({
    ...options,
    repositoryFactory: (repositoryOptions) => new WorkLogUsageRepository(repositoryOptions),
  });
  openStores.add(store);
  return store;
}
afterEach(async () => {
  await Promise.all([...openStores].map((store) => store.close()));
  openStores.clear();
});

async function rm(...args) {
  await Promise.all([...openStores].map((store) => store.close()));
  openStores.clear();
  return removeFile(...args);
}

async function projectedJournal(store) {
  return String((await store.journalSnapshot())?.html ?? "");
}

async function persistedLedger(store) {
  return store.ledgerSnapshot();
}

const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_WORK_ID = "223e4567-e89b-42d3-a456-426614174000";
const GIGA_WORK_ID = "323e4567-e89b-42d3-a456-426614174001";

test("work-log ids are normalized and validated", () => {
  assert.equal(normalizeWorkLogId(WORK_ID.toUpperCase()), WORK_ID);
  assert.throws(() => normalizeWorkLogId("not-a-guid"), /UUID/);
});

test("local usage history buckets priced ledger turns and reports unpriced ones", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const history = buildWorkLogUsageHistory({
    first: {
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 3.25,
      estimateKind: "model",
    },
    second: {
      completedAt: "2026-07-30T10:20:00.000Z",
      estimatedCredits: 1.75,
      estimateKind: "model",
    },
    unpriced: {
      completedAt: "2026-07-30T11:00:00.000Z",
      usageReported: false,
    },
    old: {
      completedAt: "2026-07-28T11:00:00.000Z",
      estimatedCredits: 99,
      estimateKind: "model",
    },
  }, { range: "6h", now });
  assert.equal(history.range, "6h");
  assert.equal(history.totalCredits, 5);
  assert.equal(history.unpricedCount, 1);
  assert.equal(history.points.length, 25);
  assert.equal(history.points.reduce((sum, point) => sum + point.credits, 0), 5);
});

test("local usage history derives credit intensity from exact turn duration", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const history = buildWorkLogUsageHistory({
    first: {
      startedAt: "2026-07-30T10:00:00.000Z",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 120,
    },
    second: {
      startedAt: "2026-07-30T10:20:00.000Z",
      completedAt: "2026-07-30T10:25:00.000Z",
      estimatedCredits: 40,
    },
    untimed: {
      completedAt: "2026-07-30T11:00:00.000Z",
      estimatedCredits: 1.1,
    },
  }, { range: "6h", now });

  assert.equal(history.totalCredits, 161.1);
  assert.equal(history.totalTimedCredits, 160);
  assert.equal(history.totalDurationSeconds, 900);
  assert.equal(history.untimedCreditCount, 1);
  assert.equal(history.points.reduce((sum, point) => sum + point.timedCredits, 0), 160);
  assert.equal(history.points.reduce((sum, point) => sum + point.durationSeconds, 0), 900);
});

test("local usage history can anchor a turn at its start, middle, or end", () => {
  const turns = {
    one: {
      startedAt: "2026-07-30T10:10:00.000Z",
      completedAt: "2026-07-30T11:10:00.000Z",
      estimatedCredits: 6,
      estimateKind: "model",
    },
  };
  const options = { range: "6h", now: Date.parse("2026-07-30T12:00:00.000Z") };
  const creditedAt = (mode) => buildWorkLogUsageHistory(turns, {
    ...options, turnTimeMode: mode,
  }).points.find((point) => point.credits > 0)?.at;
  assert.equal(creditedAt("start"), "2026-07-30T10:00:00.000Z");
  assert.equal(creditedAt("middle"), "2026-07-30T10:30:00.000Z");
  assert.equal(creditedAt("end"), "2026-07-30T11:00:00.000Z");
});

test("local usage history can exclude Claude from global totals", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const turns = {
    codex: {
      provider: "codex",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 5,
      estimateKind: "model",
    },
    claude: {
      provider: "claude",
      completedAt: "2026-07-30T10:20:00.000Z",
      estimatedCredits: 7,
      estimateKind: "model",
    },
  };
  assert.equal(buildWorkLogUsageHistory(turns, { range: "6h", now }).totalCredits, 12);
  const filtered = buildWorkLogUsageHistory(turns, {
    range: "6h",
    now,
    includeClaudeUsage: false,
  });
  assert.equal(filtered.totalCredits, 5);
  assert.equal(filtered.points.reduce((sum, point) => sum + point.credits, 0), 5);
});

test("local usage history can select one provider for limit-price comparison", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const turns = {
    codex: {
      provider: "codex",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 5,
      estimateKind: "model",
    },
    claude: {
      provider: "claude",
      completedAt: "2026-07-30T10:20:00.000Z",
      estimatedCredits: 7,
      estimateKind: "model",
    },
  };
  const codex = buildWorkLogUsageHistory(turns, { range: "6h", now, provider: "CODEX" });
  assert.equal(codex.provider, "codex");
  assert.equal(codex.totalCredits, 5);
  assert.equal(codex.points.reduce((sum, point) => sum + point.credits, 0), 5);
});

test("local usage history matches turn completion to exact account activity intervals", () => {
  const turns = Object.fromEntries([
    ["before", "2026-07-30T10:09:59.999Z", 1],
    ["at-start", "2026-07-30T10:10:00.000Z", 2],
    ["inside", "2026-07-30T10:19:59.999Z", 3],
    ["at-end", "2026-07-30T10:20:00.000Z", 4],
    ["second", "2026-07-30T11:05:00.000Z", 5],
  ].map(([key, completedAt, estimatedCredits]) => [key, {
    provider: "codex",
    completedAt,
    estimatedCredits,
    estimateKind: "model",
  }]));
  const history = buildWorkLogUsageHistory(turns, {
    range: "6h",
    now: Date.parse("2026-07-30T12:00:00.000Z"),
    provider: "codex",
    activeIntervals: [
      { from: "2026-07-30T10:10:00.000Z", to: "2026-07-30T10:20:00.000Z" },
      { from: "2026-07-30T11:00:00.000Z", to: "2026-07-30T11:10:00.000Z" },
    ],
  });
  assert.equal(history.totalCredits, 10);
  assert.equal(history.points.reduce((sum, point) => sum + point.credits, 0), 10);
  assert.equal(buildWorkLogUsageHistory(turns, {
    range: "6h",
    now: Date.parse("2026-07-30T12:00:00.000Z"),
    activeIntervals: [],
  }).totalCredits, 0);
});

test("workspace usage aggregates sequential Threads and retains Stream detail", () => {
  const resolver = ({ provider, threadId }) => ({
    workspaceId: "workspace-hub",
    workspaceName: "Agent HUB",
    workspaceKind: "user",
    streamId: threadId === "thread-themes" ? "stream-themes" : "stream-main",
    streamOrdinal: threadId === "thread-themes" ? 2 : 1,
    streamName: threadId === "thread-themes" ? "Themes" : null,
    streamDisplayName: threadId === "thread-themes" ? "Themes" : "Stream 1",
    provider,
  });
  const turns = {
    first: { provider: "codex", threadId: "thread-main", turnId: "turn-1",
      completedAt: "2026-07-30T10:00:00.000Z", estimatedCredits: 2 },
    continuation: { provider: "codex", threadId: "thread-main-next", turnId: "turn-2",
      completedAt: "2026-07-30T10:10:00.000Z", estimatedCredits: 3 },
    themes: { provider: "codex", threadId: "thread-themes", turnId: "turn-3",
      completedAt: "2026-07-30T10:20:00.000Z", estimatedCredits: 5 },
  };
  const grouped = groupWorkLogUsageByWorkspace(turns, { workspaceResolver: resolver });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].name, "Agent HUB");
  assert.equal(grouped[0].credits, 10);
  assert.equal(grouped[0].streams.length, 2);
  assert.equal(grouped[0].streams.find((stream) => stream.id === "stream-main").credits, 5);
  const history = buildWorkLogUsageHistory(turns, {
    range: "6h",
    now: Date.parse("2026-07-30T12:00:00.000Z"),
    workspaceResolver: resolver,
    streamId: "stream-main",
  });
  assert.equal(history.totalCredits, 5);
});

test("journal projection groups all Stream turns under one expandable Workspace", () => {
  const resolver = ({ threadId }) => ({
    workspaceId: "workspace-hub",
    workspaceName: "Agent HUB",
    workspaceKind: "user",
    streamId: threadId === "thread-themes" ? "stream-themes" : "stream-main",
    streamOrdinal: threadId === "thread-themes" ? 2 : 1,
    streamName: threadId === "thread-themes" ? "Themes" : null,
    streamDisplayName: threadId === "thread-themes" ? "Themes" : "Stream 1",
  });
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    main: { provider: "codex", threadId: "thread-main", turnId: "turn-main",
      taskTitle: "Agent HUB 1", title: "Первый", estimatedCredits: 2,
      completedAt: "2026-07-30T10:00:00.000Z" },
    continuation: { provider: "codex", threadId: "thread-main-next", turnId: "turn-main-next",
      taskTitle: "Agent HUB 2", title: "Продолжение", estimatedCredits: 4,
      completedAt: "2026-07-30T10:10:00.000Z" },
    themes: { provider: "codex", threadId: "thread-themes", turnId: "turn-themes",
      taskTitle: "Themes", title: "Второй", estimatedCredits: 3,
      completedAt: "2026-07-30T10:20:00.000Z" },
  }, { workspaceResolver: resolver });
  assert.equal((projected.match(/<details data-work-log-workspace data-work-log-workspace-id="workspace-hub"/gu) ?? []).length, 1);
  assert.equal((projected.match(/<details data-work-log-stream /gu) ?? []).length, 2);
  assert.equal((projected.match(/<div data-work-log-row/gu) ?? []).length, 2);
  assert.ok(projected.includes("data-work-log-workspace-streams"));
  assert.ok(projected.includes("data-work-log-stream-turns"));
  assert.ok(projected.includes("Agent HUB"));
  assert.equal((projected.match(/data-work-log-turn-stream>Stream 1<\/span>/gu) ?? []).length, 2);
  assert.equal((projected.match(/data-work-log-turn-stream>Themes<\/span>/gu) ?? []).length, 1);
  assert.ok(!projected.includes("Codex - Agent HUB 1"));
  assert.ok(!projected.includes("Codex - Agent HUB 2"));
  assert.match(
    projected,
    /data-open-task data-provider="codex" data-thread-id="thread-main-next">Stream 1/u,
  );
  assert.match(
    projected,
    /data-work-log-turn-provider="codex" data-work-log-turn-thread-id="thread-main"[\s\S]*?data-open-turn/u,
  );
  assert.ok(projected.includes('data-usage-credits="9"'));
});

test("journal assigns an unknown root Thread to Experiments instead of a fake group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-workspace-fallback-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const assigned = [];
    let resolution = null;
    const workspaceCatalogStore = {
      resolveThread: ({ threadId }) => (
        resolution?.threadId === threadId ? resolution : null
      ),
      assignUnknownThread: (reference, options) => {
        assigned.push({ reference, options });
        resolution = {
          ...reference,
          workspaceId: "workspace-experiments",
          workspaceName: "Experiments",
          workspaceKind: "system",
          streamId: "stream-experiments",
          streamOrdinal: 1,
          streamName: null,
          streamDisplayName: "Stream 1",
        };
        return resolution;
      },
    };
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
      workspaceCatalogStore,
    });
    await store.recordAutomaticBatchAndProject({
      records: [{
        provider: "codex",
        threadId: "child-thread",
        taskThreadId: "root-thread",
        parentThreadId: "root-thread",
        turnId: "child-turn",
        projectRoot: root,
        taskTitle: "Root task",
        title: "Child result",
        completedAt: "2026-08-08T10:00:00.000Z",
        estimatedCredits: 1,
      }],
      projectRoot: root,
    });

    assert.deepEqual(assigned, [{
      reference: {
        provider: "codex",
        threadId: "root-thread",
        projectRoot: root,
      },
      options: { source: "discovered" },
    }]);
    const projected = await projectedJournal(store);
    assert.match(projected, /<strong>Experiments<\/strong>/u);
    assert.doesNotMatch(projected, /Без воркспейса/u);
    assert.doesNotMatch(projected, /data-thread-id="child-thread">Stream/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal keeps one Stream expandable and owns its total at Workspace level", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    only: {
      provider: "codex",
      threadId: "thread-only",
      turnId: "turn-only",
      taskTitle: "Only task",
      title: "Готово",
      estimatedCredits: 4,
      startedAt: "2026-07-30T09:00:00.000Z",
      completedAt: "2026-07-30T10:00:00.000Z",
    },
  }, {
    workspaceResolver: () => ({
      workspaceId: "workspace-only",
      workspaceName: "Only Workspace",
      workspaceKind: "user",
      streamId: "stream-only",
      streamOrdinal: 1,
      streamName: null,
      streamDisplayName: "",
    }),
  });
  assert.match(projected, /<details data-work-log-workspace[^>]* open>/u);
  assert.match(projected, /<summary data-work-log-workspace-header>/u);
  assert.match(projected, /<details data-work-log-stream[^>]* open>/u);
  assert.match(projected, /<summary data-work-log-stream-summary>/u);
  assert.match(projected, /data-work-log-turn-stream>Stream 1<\/span>/u);
  assert.match(
    projected,
    /data-work-log-workspace-usage>[\s\S]*?data-usage-credits="4"/u,
  );
  const workspaceSummary = projected.match(
    /<summary data-work-log-workspace-header>[\s\S]*?<\/summary>/u,
  )?.[0] ?? "";
  assert.match(workspaceSummary, /data-usage-credits="4"/u);
  assert.doesNotMatch(workspaceSummary, /Итого|data-usage-label/u);
  assert.doesNotMatch(workspaceSummary, /data-work-log-duration/u);
  const collapsedUsage = projected.match(
    /<div data-work-log-collapsed-workspace-usage hidden>[\s\S]*?<\/div>/u,
  )?.[0] ?? "";
  assert.match(collapsedUsage, /data-work-log-collapsed-workspace-usage-details/u);
  assert.match(collapsedUsage, /data-task-usage-breakdown/u);
  assert.match(collapsedUsage, /data-usage-credits="4"/u);
  assert.match(
    collapsedUsage,
    /data-work-log-duration-summary data-work-log-duration-seconds="3600"><span data-work-log-duration-percent>\(100%\)<\/span> <span data-work-log-duration>1 ч 0 мин<\/span><\/span><span data-kilo-usage[^>]*data-usage-credits="4"[^>]*>4 cr<\/span> <span data-usage-percent>\(100%\)<\/span>/u,
  );
  assert.doesNotMatch(collapsedUsage, /Итого|data-usage-label/u);
  assert.match(
    projected,
    /data-work-log-day-duration data-work-log-duration-seconds="3600">· 1 ч 0 мин/u,
  );
});

test("collapsed Workspace totals show elapsed time as a share of the day", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    short: {
      provider: "codex",
      threadId: "thread-short",
      turnId: "turn-short",
      estimatedCredits: 1,
      startedAt: "2026-07-30T09:00:00.000Z",
      completedAt: "2026-07-30T10:00:00.000Z",
    },
    long: {
      provider: "codex",
      threadId: "thread-long",
      turnId: "turn-long",
      estimatedCredits: 3,
      startedAt: "2026-07-30T10:00:00.000Z",
      completedAt: "2026-07-30T13:00:00.000Z",
    },
  }, {
    workspaceResolver: ({ threadId }) => ({
      workspaceId: threadId === "thread-short" ? "workspace-short" : "workspace-long",
      workspaceName: threadId === "thread-short" ? "Short" : "Long",
      workspaceKind: "user",
      streamId: threadId,
      streamOrdinal: 1,
      streamName: null,
      streamDisplayName: "Stream 1",
    }),
  });
  assert.match(
    projected,
    /data-work-log-workspace-id="workspace-short"[\s\S]*?data-work-log-duration-seconds="3600"[\s\S]*?data-work-log-duration-percent>\(25%\)/u,
  );
  assert.match(
    projected,
    /data-work-log-workspace-id="workspace-long"[\s\S]*?data-work-log-duration-seconds="10800"[\s\S]*?data-work-log-duration-percent>\(75%\)/u,
  );
  assert.match(
    projected,
    /data-work-log-day-duration data-work-log-duration-seconds="14400">· 4 ч 0 мин/u,
  );
});

test("seven-day usage matches journal calendar days and includes empty days", () => {
  const now = new Date(2026, 6, 30, 18, 0, 0, 0).getTime();
  const completedAt = (daysAgo, hour) => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const history = buildWorkLogUsageHistory({
    first: { completedAt: completedAt(6, 10), estimatedCredits: 3, estimateKind: "model" },
    second: { completedAt: completedAt(0, 9), estimatedCredits: 4, estimateKind: "model" },
    third: { completedAt: completedAt(0, 17), estimatedCredits: 5, estimateKind: "model" },
  }, { range: "7d", now });
  assert.equal(history.bucket, "day");
  assert.equal(history.points.length, 7);
  assert.deepEqual(history.points.map((point) => point.credits), [3, 0, 0, 0, 0, 0, 9]);
  assert.ok(history.points.every((point) => new Date(point.at).getHours() === 0));
});

test("fifteen-day usage includes today and the fourteen preceding calendar days", () => {
  const now = new Date(2026, 7, 7, 18, 0, 0, 0).getTime();
  const completedAt = (daysAgo) => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(9, 0, 0, 0);
    return date.toISOString();
  };
  const history = buildWorkLogUsageHistory({
    firstIncludedDay: { completedAt: completedAt(14), estimatedCredits: 3, estimateKind: "model" },
    dayBeforeRange: { completedAt: completedAt(15), estimatedCredits: 7, estimateKind: "model" },
    today: { completedAt: completedAt(0), estimatedCredits: 5, estimateKind: "model" },
  }, { range: "15d", now });
  assert.equal(history.range, "15d");
  assert.equal(history.points.length, 15);
  assert.equal(history.totalCredits, 8);
  assert.deepEqual(history.points.map((point) => point.credits), [3, ...Array(13).fill(0), 5]);
});

test("day range covers the whole calendar day and keeps an axis to midnight", () => {
  const now = new Date(2026, 6, 30, 18, 36, 0, 0).getTime();
  const history = buildWorkLogUsageHistory({
    early: {
      completedAt: new Date(2026, 6, 30, 1, 15, 0, 0).toISOString(),
      estimatedCredits: 4,
      estimateKind: "model",
    },
  }, { range: "24h", now });
  assert.equal(new Date(history.from).getHours(), 0);
  assert.equal(new Date(history.axisTo).getHours(), 0);
  assert.equal(Date.parse(history.axisTo) - Date.parse(history.from), 24 * 60 * 60 * 1_000);
  assert.equal(history.totalCredits, 4);
  assert.equal(history.bucketMs, 30 * 60 * 1_000);
});

test("all-time history falls back to calendar days on long spans", () => {
  const now = new Date(2026, 6, 30, 18, 0, 0, 0).getTime();
  const turns = {};
  for (let index = 0; index < 60; index += 1) {
    const at = new Date(now);
    at.setDate(at.getDate() - index);
    at.setHours(9, 30, 0, 0);
    turns["turn" + index] = {
      completedAt: at.toISOString(),
      estimatedCredits: 2,
      estimateKind: "model",
    };
  }
  const history = buildWorkLogUsageHistory(turns, { range: "all", now });
  assert.equal(history.bucket, "day");
  assert.ok(history.points.every((point) => new Date(point.at).getHours() === 0));
});

test("all-time history respects maxPoints while preserving all credits", () => {
  const now = new Date(2026, 6, 30, 18, 0, 0, 0).getTime();
  const turns = {};
  for (let index = 0; index < 3_000; index += 1) {
    const at = new Date(now);
    at.setDate(at.getDate() - index);
    turns[`turn-${index}`] = {
      completedAt: at.toISOString(),
      estimatedCredits: 1,
      estimateKind: "model",
    };
  }
  const history = buildWorkLogUsageHistory(turns, { range: "all", now, maxPoints: 10 });
  assert.ok(history.points.length <= 10);
  assert.equal(history.points.reduce((sum, point) => sum + point.credits, 0), 3_000);
  assert.equal(history.totalCredits, 3_000);
});

test("Fast label uses the same model multiplier as credit calculation", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    mini: {
      provider: "codex",
      threadId: "thread-mini",
      turnId: "turn-mini",
      taskTitle: "Mini",
      title: "Проверка",
      usageReported: true,
      usage: { inputTokens: 1_000 },
      model: "gpt-5.4-mini",
      serviceTier: "fast",
      completedAt: "2026-07-30T12:00:00.000Z",
    },
  });
  assert.match(projected, /gpt-5\.4-mini · Fast ×1/u);
  assert.doesNotMatch(projected, /gpt-5\.4-mini · Fast ×2/u);
});

test("rate-limit summary is replaced in place above the journal days", () => {
  const first = projectWorkLogRateLimits(
    "# Глобальный журнал работ\n\n<details></details>\n",
    "CODEX - 94.0%\nSpark - 100.0%",
    "2026-07-29T10:00:00.000Z",
  );
  const second = projectWorkLogRateLimits(first, "CODEX - 93.0%", "2026-07-29T10:05:00.000Z");
  assert.equal((second.match(/data-work-log-rate-limits/gu) ?? []).length, 1);
  assert.match(
    second,
    /<span data-rate-limit><span data-rate-limit-name>CODEX<\/span><span data-rate-limit-value>93\.0%<\/span>/u,
  );
  assert.doesNotMatch(second, /94\.0%/u);
});

test("each rate-limit measure becomes a chip with its own reset", () => {
  const projected = projectWorkLogRateLimits(
    "# Глобальный журнал работ\n\n<details></details>\n",
    "CODEX - 87.0% - 6 дн. 14 ч.\nSpark - 100.0% - 7 дн.\nДоступно сбросов: 5",
    "",
  );
  assert.equal((projected.match(/data-rate-limit>/gu) ?? []).length, 2);
  assert.match(projected, /<span data-rate-limit-reset>6 дн\. 14 ч\.<\/span>/u);
  assert.match(projected, /<span data-rate-limit-group>/u);
  assert.match(
    projected,
    /<span data-rate-limit-credit><span data-rate-limit-credit-count>Сбросов 5<\/span><\/span>/u,
  );
  assert.match(projected, /<span data-rate-limit-caption>Лимиты<\/span>/u);
});

test("reset credits use a compact two-line cloud", () => {
  const projected = projectWorkLogRateLimits(
    "# Глобальный журнал работ\n\n<details></details>\n",
    "CODEX - 87.0% - 6 дн.\nСбросов 2\nДо 31 июл.",
    "",
  );
  assert.match(
    projected,
    /data-rate-limit-credit-count>Сбросов 2<\/span><span data-rate-limit-credit-deadline>До 31 июл\.<\/span>/u,
  );
});

test("applyWorkLogUsage replaces only the matching per-turn placeholder", () => {
  const source = [
    "<tr><td>",
    `<span data-usage-id="${WORK_ID}">${WORK_ID}</span> + `,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
    "</td></tr>",
  ].join("");
  assert.equal(
    applyWorkLogUsage(source, WORK_ID, {
      inputTokens: 356_973,
      cachedInputTokens: 348_672,
      outputTokens: 894,
      reasoningOutputTokens: 672,
    }),
    [
      "<tr><td>",
      `<span data-usage-id="${WORK_ID}">Итого 6,1 cr<br>Вход: 1,0 cr (17,1%)<br>Кэш: 4,4 cr (71,8%)<br>Выход: 0,2 cr (2,8%)<br>Думы: 0,5 cr (8,3%)</span> + `,
      `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
      "</td></tr>",
    ].join(""),
  );
  assert.throws(() => applyWorkLogUsage("<table></table>", WORK_ID, 10), /found 0/);
});

test("projectWorkLogUsage renders turn tables, preserves legacy outcomes and calculates shares", () => {
  const firstCompletedAt = new Date(2026, 6, 25, 12, 34).toISOString();
  const secondCompletedAt = new Date(2026, 6, 25, 13, 45).toISOString();
  const firstStartedAt = new Date(2026, 6, 25, 12, 30, 30).toISOString();
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><colgroup><col><col><col></colgroup><thead>",
    "<tr><th>Задача</th><th>Итог</th><th>Расход</th></tr></thead><tbody>",
    `<tr><td>Task A</td><td>Outcome A<details><summary>Изменённые файлы</summary>a.mjs</details></td><td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span><br>`,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span></td>`,
    "<td data-work-log-turns>legacy</td></tr>",
    `<tr><td>Task B</td><td>Outcome B</td><td><span data-usage-id="323e4567-e89b-42d3-a456-426614174000">pending</span></td></tr>`,
    `<tr><td>Task C</td><td>Outcome C</td><td><span data-usage-id="423e4567-e89b-42d3-a456-426614174000">recorded</span></td></tr>`,
    "</tbody></table>",
    "</details>",
  ].join("");
  const turns = {
    first: {
      workLogId: WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
      startedAt: firstStartedAt,
      completedAt: firstCompletedAt,
      text: "Первый <ход>\nСтрока",
      prompt: [
        "# Response annotations:",
        "<response-annotations>",
        '[{"text":"Старый ответ","annotation":"Короткий вопрос"}]',
        "</response-annotations>",
        "## My request for Codex:",
      ].join("\n"),
    },
    second: {
      workLogId: SECOND_WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
      completedAt: secondCompletedAt,
      text: "Второй & ход",
    },
    third: {
      workLogId: "423e4567-e89b-42d3-a456-426614174000",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 },
    },
  };
  const projected = projectWorkLogUsage(source, turns);
  assert.match(projected, /^<details data-work-log-day-section open>/);
  assert.match(projected, /<div data-work-log-table>/);
  assert.equal((projected.match(/<table\b/g) ?? []).length, 0);
  assert.equal((projected.match(/<div data-work-log-row/g) ?? []).length, 3);
  assert.doesNotMatch(projected, /data-work-log-previous-turn-table/);
  assert.match(
    projected,
    /<div data-work-log-header><strong>Задача<\/strong><strong>Ходы<\/strong><\/div>/,
  );
  assert.doesNotMatch(projected, /<strong>Расход<\/strong>/);
  assert.match(
    projected,
    /data-work-log-task-content>Task A<\/div><div data-work-log-usage><details data-task-usage-details>/,
  );
  assert.match(projected, /data-work-log-legacy-outcome>Outcome A<\/div>/);
  assert.match(projected, /data-work-log-legacy-outcome>Outcome B<\/div>/);
  assert.match(
    projected,
    /<div data-work-log-turn-table>[\s\S]*?data-work-log-turn-measure>13:45 — <span data-kilo-usage[^>]*>0,0 cr<\/span><\/span><span data-work-log-turn-share>\(50%\)<\/span>[\s\S]*?data-work-log-turn-title>Второй &amp; ход<\/span>[\s\S]*?<details data-work-log-previous-turns>[\s\S]*?data-work-log-turn-measure>12:34 — <span data-kilo-usage[^>]*>0,0 cr<\/span><\/span><span data-work-log-turn-share>\(50%\)<\/span>[\s\S]*?data-work-log-turn-title>Первый &lt;ход&gt; Строка<\/span>/,
  );
  assert.doesNotMatch(projected, /data-work-log-turn-files|a\.mjs/u);
  assert.match(
    projected,
    /<details data-work-log-previous-turns><summary><span data-work-log-previous-turns-closed>Показать предыдущие ходы \(1\)<\/span><span data-work-log-previous-turns-open>Свернуть<\/span><\/summary>/,
  );
  assert.match(
    projected,
    /<button type="button" data-work-log-collapse-turns>Свернуть ходы<\/button>/,
  );
  assert.match(
    projected,
    /<div data-work-log-usage>[\s\S]*?<button type="button" data-work-log-collapse-turns>Свернуть ходы<\/button><\/div><\/div>\s*<div data-work-log-turn-list>/,
  );
  assert.doesNotMatch(
    projected,
    /<details data-work-log-previous-turns>[\s\S]*?<button type="button" data-work-log-collapse-turns>/,
  );
  assert.equal((projected.match(/data-work-log-no-previous-turns/g) ?? []).length, 1);
  assert.match(projected, /data-work-log-no-previous-turns>Предыдущих ходов нет\.<\/div>/);
  assert.doesNotMatch(projected, /<details data-work-log-previous-turns open>/);
  assert.match(
    projected,
    /Второй &amp; ход[\s\S]*?<details data-work-log-previous-turns>[\s\S]*?data-work-log-previous-turn-list>[\s\S]*?Первый &lt;ход&gt; Строка[\s\S]*?<\/div><\/details>/,
  );
  assert.match(projected, /<strong>Длит\.:<\/strong> 3 мин 30 с/);
  assert.ok(projected.includes('data-work-log-turn-duration-seconds="210"'));
  assert.ok(projected.includes(`data-work-log-turn-completed-at="${firstCompletedAt}"`));
  assert.equal((projected.match(/data-work-log-turn-duration-seconds=/g) ?? []).length, 1);
  assert.equal((projected.match(/data-work-log-turn-credits=/g) ?? []).length, 3);
  assert.equal((projected.match(/data-work-log-turn-file-count=/g) ?? []).length, 3);
  assert.equal((projected.match(/data-work-log-turn-change-lines=/g) ?? []).length, 3);
  assert.equal((projected.match(/data-work-log-turn-subagent=/g) ?? []).length, 3);
  assert.match(projected, /<strong>Запрос:<\/strong> Короткий вопрос/);
  assert.doesNotMatch(projected, /Response annotations|response-annotations|Старый ответ/);
  assert.doesNotMatch(projected, /data-work-log-legacy-files/);
  assert.match(
    projected,
    /data-day-usage><span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="[^"]+">0,0 cr<\/span>/,
  );
  assert.match(
    projected,
    /data-work-log-day-duration data-work-log-duration-seconds="210">· 4 мин<\/span>/,
  );
  assert.doesNotMatch(projected, /За день:/);
  assert.match(
    projected,
    /<summary data-work-log-day><strong>25\.07\.2026<\/strong> <span data-day-usage-table>[\s\S]*?<\/summary>/,
  );
  assert.doesNotMatch(projected, /data-day-usage-details/);
  assert.doesNotMatch(
    projected.match(/<span data-day-usage-breakdown>[\s\S]*?<\/span>/)?.[0] ?? "",
    /<br>/,
  );
  assert.equal((projected.match(/data-day-usage-part/g) ?? []).length, 4);
  assert.match(projected, /Task A[\s\S]*?<span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="[^"]+">0,0 cr<\/span> <span data-usage-percent>\(50%\)<\/span>/);
  assert.match(projected, /Task C[\s\S]*?<span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="[^"]+">0,0 cr<\/span> <span data-usage-percent>\(50%\)<\/span>/);
  assert.match(
    projected,
    /<details data-task-usage-details><summary data-task-usage><span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="[^"]+">0,0 cr<\/span> <span data-usage-percent>\(50%\)<\/span><\/summary><span data-task-usage-breakdown><span data-task-usage-part>Вход:/,
  );
  assert.doesNotMatch(projected, /<details data-task-usage-details open>/);
  assert.match(
    projected,
    /data-work-log-task-content>Task B<\/div><div data-work-log-usage><span data-usage-id="323e4567-e89b-42d3-a456-426614174000" hidden>[\s\S]*?data-work-log-legacy-outcome>Outcome B<\/div>/,
  );
  assert.equal((projected.match(/data-task-usage>/g) ?? []).length, 2);
  assert.equal((projected.match(/data-task-usage-details/g) ?? []).length, 2);
  assert.equal((projected.match(/data-task-usage-part/g) ?? []).length, 8);
  assert.equal((projected.match(/data-usage-id=/g) ?? []).length, 4);
  assert.equal((projected.match(/data-usage-id=[^>]+hidden/g) ?? []).length, 4);
  const reprojected = projectWorkLogUsage(projected, turns);
  assert.equal((reprojected.match(/data-work-log-day-section/g) ?? []).length, 1);
  assert.equal(reprojected, projected);
});

test("projectWorkLogUsage keeps Claude turns visible but excludes their spend when disabled", () => {
  const completedAt = new Date(2026, 6, 25, 12, 0).toISOString();
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    codex: {
      provider: "codex",
      threadId: "codex-thread",
      turnId: "codex-turn",
      taskTitle: "Codex task",
      completedAt,
      estimatedCredits: 5,
      estimateKind: "model",
    },
    claude: {
      provider: "claude",
      threadId: "claude-thread",
      turnId: "claude-turn",
      taskTitle: "Claude task",
      completedAt,
      estimatedCredits: 7,
      estimateKind: "model",
    },
  }, { includeClaudeUsage: false });

  assert.match(projected, /data-day-usage><span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="5">5 cr<\/span>/u);
  assert.match(projected, /data-work-log-provider="claude"[\s\S]*?Claude task/u);
  assert.equal((projected.match(/data-task-usage>/gu) ?? []).length, 1);
  assert.equal((projected.match(/data-work-log-turn-credits=/gu) ?? []).length, 2);
});

test("usage breakdown keeps exact credits behind the rounded label", () => {
  const completedAt = new Date(2026, 6, 25, 12, 0).toISOString();
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    codex: {
      provider: "codex",
      threadId: "codex-thread",
      turnId: "codex-turn",
      taskTitle: "Codex task",
      completedAt,
      model: "gpt-5.6-sol",
      usage: { inputTokens: 9_876_543, outputTokens: 1_234_567 },
    },
  });

  /* «1,2 kcr» нельзя разобрать обратно без потери 2,8 %, поэтому точное значение
     обязано ехать атрибутом у каждой части разбивки, а не только у итогов. */
  assert.match(
    projected,
    /data-task-usage-part>Вход: <span data-mega-usage data-usage-credits="1234\.567875">1,2 kcr<\/span>/u,
  );
  assert.match(
    projected,
    /data-task-usage-part>Выход: <span data-kilo-usage data-usage-credits="925\.92525">925,9 cr<\/span>/u,
  );
  assert.match(
    projected,
    /data-day-usage-part>Вход: <span data-mega-usage data-usage-credits="1234\.567875">1,2 kcr<\/span>/u,
  );
  assert.doesNotMatch(projected, /data-(?:kilo|mega|high)-usage>/u);
});

test("tasks inside a day are sorted by their latest turn descending", () => {
  const source = [
    "<details><summary><strong>25.07.2026</strong></summary>",
    "<div data-work-log-table><div data-work-log-body>",
    '<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="old">',
    "<div data-work-log-task-cell><div data-work-log-task-content>Old task</div></div>",
    '<div data-work-log-turn-list></div></div>',
    '<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="fresh">',
    "<div data-work-log-task-cell><div data-work-log-task-content>Fresh task</div></div>",
    '<div data-work-log-turn-list></div></div>',
    "</div></div></details>",
  ].join("");
  const projected = projectWorkLogUsage(source, {
    old: {
      provider: "codex",
      threadId: "old",
      turnId: "turn-old",
      taskTitle: "Old task",
      completedAt: "2026-07-25T10:00:00.000Z",
      usage: { inputTokens: 1 },
    },
    fresh: {
      provider: "codex",
      threadId: "fresh",
      turnId: "turn-fresh",
      taskTitle: "Fresh task",
      completedAt: "2026-07-25T12:00:00.000Z",
      usage: { inputTokens: 1 },
    },
  });

  assert.ok(projected.indexOf("Fresh task") < projected.indexOf("Old task"));
  assert.equal(projectWorkLogUsage(projected, {
    old: {
      provider: "codex",
      threadId: "old",
      turnId: "turn-old",
      taskTitle: "Old task",
      completedAt: "2026-07-25T10:00:00.000Z",
      usage: { inputTokens: 1 },
    },
    fresh: {
      provider: "codex",
      threadId: "fresh",
      turnId: "turn-fresh",
      taskTitle: "Fresh task",
      completedAt: "2026-07-25T12:00:00.000Z",
      usage: { inputTokens: 1 },
    },
  }), projected);
});

test("projectWorkLogUsage keeps exact diffs out of the compact journal projection", () => {
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><tbody><tr>",
    "<td>Task</td><td></td>",
    `<td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span></td>`,
    "</tr></tbody></table>",
    "</details>",
  ].join("");
  const projected = projectWorkLogUsage(source, {
    diff: {
      workLogId: WORK_ID,
      provider: "codex",
      threadId: "thread-diff",
      turnId: "turn-diff",
      taskThreadId: "thread-diff",
      taskTitle: "Task",
      completedAt: new Date(2026, 6, 25, 13, 45).toISOString(),
      changedFiles: ["src/a.mjs"],
      diff: [
        "diff --git a/src/a.mjs b/src/a.mjs",
        "--- a/src/a.mjs",
        "+++ b/src/a.mjs",
        "@@ -1 +1 @@",
        "-const value = 1;",
        "+const value = 2;",
      ].join("\n"),
    },
  });
  assert.doesNotMatch(projected, /data-work-log-turn-diff/u);
  assert.doesNotMatch(projected, /const value/u);
  assert.doesNotMatch(projected, /data-work-log-turn-files>[\s\S]*src\/a\.mjs/u);
  assert.match(projected, /data-work-log-turn-file-count="1"/u);
  assert.match(projected, /data-work-log-turn-change-lines="2"/u);
});

test("projectWorkLogUsage exposes compact skill and MCP profile metrics", () => {
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><tbody><tr>",
    "<td>Task</td><td></td>",
    `<td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span></td>`,
    "</tr></tbody></table>",
    "</details>",
  ].join("");
  const projected = projectWorkLogUsage(source, {
    tools: {
      workLogId: WORK_ID,
      provider: "codex",
      threadId: "thread-tools",
      turnId: "turn-tools",
      taskThreadId: "thread-tools",
      taskTitle: "Task",
      completedAt: new Date(2026, 6, 25, 13, 45).toISOString(),
      skillsUsed: ["openai-docs", "plugin:review"],
      mcpCalls: [
        { id: "one", server: "docs", tool: "search", status: "completed" },
        { id: "two", server: "github", tool: "read", status: "failed" },
      ],
      toolMetricsKnown: true,
    },
  });
  assert.match(projected, /data-work-log-turn-skills="\[&quot;openai-docs&quot;,&quot;plugin:review&quot;\]"/u);
  assert.match(projected, /data-work-log-turn-mcp-calls="2"/u);
  assert.match(projected, /data-work-log-turn-mcp-tools="\[&quot;docs\/search&quot;,&quot;github\/read&quot;\]"/u);
  assert.match(projected, /data-work-log-turn-mcp-failures="1"/u);
});

test("projectWorkLogUsage does not present changed-file paths as a missing diff", () => {
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><tbody><tr>",
    "<td>Task</td><td></td>",
    `<td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span></td>`,
    "</tr></tbody></table>",
    "</details>",
  ].join("");
  const projected = projectWorkLogUsage(source, {
    missingDiff: {
      workLogId: WORK_ID,
      provider: "codex",
      threadId: "thread-no-diff",
      turnId: "turn-no-diff",
      taskThreadId: "thread-no-diff",
      taskTitle: "Task",
      completedAt: new Date(2026, 6, 25, 13, 45).toISOString(),
      changedFiles: ["src/noisy-path.mjs"],
      diff: "",
    },
  });
  assert.doesNotMatch(projected, /noisy-path\.mjs/u);
  assert.doesNotMatch(projected, /data-work-log-turn-diff/u);
});

test("projectWorkLogUsage marks every day as an independent layout section", () => {
  const source = [
    "<details open><summary><strong>25.07.2026</strong></summary></details>",
    "<details open><summary><strong>24.07.2026</strong></summary></details>",
  ].join("\n");
  const projected = projectWorkLogUsage(source);

  assert.match(projected, /^<details data-work-log-day-section open>/);
  assert.match(projected, /\n<details data-work-log-day-section>/);
  assert.equal((projected.match(/data-work-log-day-section open/g) ?? []).length, 1);
  assert.equal((projected.match(/data-work-log-day-section/g) ?? []).length, 2);
  assert.equal((projected.match(/summary data-work-log-day/g) ?? []).length, 2);
});

test("projectWorkLogUsage removes stale table fragments from a partially migrated day", () => {
  const source = [
    '<details open><summary><strong>27.07.2026</strong></summary>',
    '<div data-work-log-table><div data-work-log-body>',
    '<div data-work-log-row><div data-work-log-task-cell>',
    `<div data-work-log-task-content>Task</div><div data-work-log-usage><span data-usage-id="${WORK_ID}" hidden></span></div>`,
    '</div><div data-work-log-turn-list></div></div></div></div>',
    '<tr><td>stale task</td><td>stale turn</td></tr></tbody></table>',
    "</details>",
  ].join("");
  const turns = {
    turn: {
      workLogId: WORK_ID,
      turnId: "turn",
      usage: { inputTokens: 100 },
      completedAt: new Date(2026, 6, 27, 10, 0).toISOString(),
    },
  };

  const projected = projectWorkLogUsage(source, turns);

  assert.equal((projected.match(/<div data-work-log-row/g) ?? []).length, 1);
  assert.doesNotMatch(projected, /<(?:table|tr|td)\b|stale task|stale turn/);
  assert.equal(projectWorkLogUsage(projected, turns), projected);
});

test("projectWorkLogUsage canonicalizes a unique legacy row and refreshes its task title", () => {
  const workLogId = "823e4567-e89b-42d3-a456-426614174000";
  const completedAt = new Date(2026, 6, 27, 10, 0).toISOString();
  const source = "<details open><summary><strong>27.07.2026</strong></summary><table><tbody>"
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-legacy">Codex - Старое имя</a></td>'
    + `<td></td><td><span data-usage-id="${workLogId}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const turns = {
    "codex\0thread-legacy\0turn-legacy": {
      provider: "codex",
      threadId: "thread-legacy",
      turnId: "turn-legacy",
      workLogId,
      taskTitle: "Название из Agent Hub",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 100 },
    },
  };

  const projected = projectWorkLogUsage(source, turns);

  assert.match(
    projected,
    /<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="thread-legacy">/,
  );
  assert.match(
    projected,
    /<button type="button" data-open-task data-provider="codex" data-thread-id="thread-legacy">Codex - Название из Agent Hub<\/button>/,
  );
  assert.match(
    projected,
    /data-work-log-turn-provider="codex" data-work-log-turn-thread-id="thread-legacy" data-work-log-task-thread-id="thread-legacy"[^>]*data-work-log-turn-id="turn-legacy"/,
  );
  assert.match(
    projected,
    /<button type="button" data-open-turn[^>]*><svg data-phosphor-icon="arrow-square-out"/,
  );
  assert.doesNotMatch(projected, />Codex - Старое имя<\/a>/);
});

test("projectWorkLogUsage keeps ambiguous legacy rows with one thread separate", () => {
  const firstId = "923e4567-e89b-42d3-a456-426614174000";
  const secondId = "a23e4567-e89b-42d3-a456-426614174000";
  const completedAt = new Date(2026, 6, 26, 10, 0).toISOString();
  const source = "<details><summary><strong>26.07.2026</strong></summary><table><tbody>"
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-shared">Codex - Первая работа</a></td>'
    + `<td></td><td><span data-usage-id="${firstId}" hidden></span></td></tr>`
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-shared">Codex - Вторая работа</a></td>'
    + `<td></td><td><span data-usage-id="${secondId}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const turns = Object.fromEntries([
    ["turn-first", firstId],
    ["turn-second", secondId],
  ].map(([turnId, workLogId]) => [
    `codex\0thread-shared\0${turnId}`,
    {
      provider: "codex",
      threadId: "thread-shared",
      turnId,
      workLogId,
      taskTitle: "Общее имя",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 100 },
    },
  ]));

  const projected = projectWorkLogUsage(source, turns);

  assert.equal((projected.match(/data-work-log-thread-id="thread-shared"/g) ?? []).length, 0);
  assert.match(projected, />Codex - Первая работа<\/a>/);
  assert.match(projected, />Codex - Вторая работа<\/a>/);
});

test("work log colors kilo, mega and giga-or-higher usage independently", () => {
  const source = `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
    + `<tr><td>Task</td><td></td><td><span data-usage-id="${GIGA_WORK_ID}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const projected = projectWorkLogUsage(source, {
    turn: {
      workLogId: GIGA_WORK_ID,
      usage: { inputTokens: 1_000_000_000 },
      completedAt: "2026-07-25T00:00:00.000Z",
      text: "Большой ход",
    },
  });
  assert.match(projected, /data-mega-usage[^>]*>125,0 kcr<\/span>/);
});

test("work log CSS keeps dates equal and shows a compact always-visible turn list", async () => {
  const css = await readFile(new URL("../../work-log.css", import.meta.url), "utf8");
  assert.match(
    css,
    /details\[data-work-log-day-section\][\s\S]*?background-color:[\s\S]*?border-radius:[\s\S]*?padding:/,
  );
  assert.match(
    css,
    /details\[data-work-log-day-section\]\[open\][\s\S]*?background-color:/,
  );
  assert.match(css, /summary\[data-work-log-day\][\s\S]*?font-size:\s*1em/);
  assert.match(
    css,
    /div\[data-work-log-header\],[\s\S]*?div\[data-work-log-row\][\s\S]*?grid-template-columns:\s*28ch minmax\(0, 1fr\)/,
  );
  assert.match(css, /--work-log-task-card-width:\s*26ch/);
  assert.match(
    css,
    /div\[data-work-log-turn-table\][\s\S]*?width:\s*100%[\s\S]*?data-work-log-turn-entry\] \+ div\[data-work-log-turn-entry\][\s\S]*?margin-top:\s*0\.35em/,
  );
  assert.match(
    css,
    /div\[data-work-log-task-cell\] > div\[data-work-log-task-content\][\s\S]*?border:[\s\S]*?padding:\s*0\.3em 0\.45em[\s\S]*?width:\s*var\(--work-log-task-card-width\)/,
  );
  assert.match(
    css,
    /summary\[data-task-usage\][\s\S]*?padding:\s*0\.3em 0\.45em[\s\S]*?width:\s*var\(--work-log-task-card-width\)/,
  );
  assert.doesNotMatch(css, /table\[data-work-log-table\]/);
  assert.match(css, /details\[data-work-log-turn-details\] > summary[\s\S]*?display:\s*grid/);
  assert.match(
    css,
    /span\[data-work-log-turn-meta\][\s\S]*?display:\s*flex[\s\S]*?justify-content:\s*space-between/,
  );
  assert.match(css, /summary::-webkit-details-marker[\s\S]*?display:\s*none/);
  assert.match(
    css,
    /details\[data-work-log-turn-details\]\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?border-radius:\s*4px/,
  );
  assert.match(
    css,
    /details\[data-work-log-turn-details\]\[open\]\s*\{[\s\S]*?border:\s*2px solid var\(--vscode-focusBorder/,
  );
  assert.match(
    css,
    /div\[data-work-log-turn-table\]\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?border-radius:\s*4px[\s\S]*?overflow:\s*hidden/,
  );
  assert.match(
    css,
    /details\[data-work-log-previous-turns\]\s*\{[\s\S]*?border-top:\s*1px solid[\s\S]*?flex-direction:\s*column/,
  );
  assert.match(
    css,
    /details\[data-work-log-previous-turns\] > summary[\s\S]*?order:\s*2/,
  );
  assert.match(
    css,
    /div\[data-work-log-usage\] > button\[data-work-log-collapse-turns\]\s*\{[\s\S]*?display:\s*none[\s\S]*?width:\s*100%/,
  );
  assert.match(
    css,
    /div\[data-work-log-row\]:has\(details\[data-work-log-previous-turns\]\[open\]\)[\s\S]*?div\[data-work-log-usage\] > button\[data-work-log-collapse-turns\][\s\S]*?display:\s*block/,
  );
  assert.match(
    css,
    /div\[data-work-log-previous-turn-list\]\s*\{[\s\S]*?order:\s*1/,
  );
  assert.match(
    css,
    /div\[data-work-log-no-previous-turns\]\s*\{[\s\S]*?border-bottom:\s*1px solid[\s\S]*?padding:\s*0\.3em 0\.45em/,
  );
  assert.match(
    css,
    /data-work-log-previous-turns\]\[open\][\s\S]*?data-work-log-previous-turns-closed[\s\S]*?display:\s*none/,
  );
  assert.match(
    css,
    /data-work-log-previous-turns\]\[open\][\s\S]*?data-work-log-previous-turns-open[\s\S]*?display:\s*inline/,
  );
  assert.doesNotMatch(css, /data-work-log-turns-toggle/);
  assert.match(
    css,
    /span\[data-kilo-usage\][\s\S]*?#e5c07b[\s\S]*?span\[data-mega-usage\][\s\S]*?#ff9d00[\s\S]*?span\[data-high-usage\][\s\S]*?#f14c4c/,
  );
});

test("work log limits visible turn titles to 100 characters", () => {
  const source = "<details open><summary><strong>27.07.2026</strong></summary>"
    + "<table><tbody><tr><td>Task</td><td></td><td></td></tr></tbody></table></details>";
  const projected = projectWorkLogUsage(source, {
    turn: {
      provider: "codex",
      threadId: "thread-title",
      turnId: "turn-title",
      taskTitle: "Title",
      title: "Т".repeat(120),
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
    },
  });
  assert.match(projected, new RegExp(`data-work-log-turn-title>${"Т".repeat(100)}<\\/span>`));
  assert.doesNotMatch(projected, new RegExp("Т{101}"));
});

test("collapsed previous turns remain idempotent without a legacy outcome", () => {
  const source = "<details open><summary><strong>27.07.2026</strong></summary>"
    + '<table><tbody><tr data-work-log-provider="codex" data-work-log-thread-id="thread-idempotent">'
    + "<td>Task</td><td></td></tr></tbody></table></details>";
  const turns = Object.fromEntries(["first", "second"].map((turnId, index) => [
    `codex\0thread-idempotent\0${turnId}`,
    {
      provider: "codex",
      threadId: "thread-idempotent",
      turnId,
      taskTitle: "Title",
      title: `Ход ${index + 1}`,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: `2026-07-27T00:0${index}:00.000Z`,
    },
  ]));
  const projected = projectWorkLogUsage(source, turns);
  const reprojected = projectWorkLogUsage(projected, turns);
  assert.equal(reprojected, projected);
  assert.equal((reprojected.match(/data-work-log-turn-id=/g) ?? []).length, 2);
  assert.equal((reprojected.match(/data-work-log-legacy-outcome/g) ?? []).length, 0);
});

test("subagent usage is summed into its root task and shown as child turns", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    "codex\0root\0root-turn": {
      provider: "codex",
      threadId: "root",
      turnId: "root-turn",
      taskTitle: "Root task",
      title: "Основной результат",
      usageReported: true,
      usage: { inputTokens: 100_000 },
      completedAt: "2026-07-27T00:01:00.000Z",
    },
    "codex\0child\0child-turn": {
      provider: "codex",
      threadId: "child",
      taskThreadId: "root",
      parentThreadId: "root",
      parentTurnId: "root-turn",
      aggregateOnly: true,
      turnId: "child-turn",
      taskTitle: "Root task",
      title: "Скрытый результат субагента",
      usageReported: true,
      usage: { inputTokens: 50_000 },
      completedAt: "2026-07-27T00:02:00.000Z",
    },
    "codex\0child-2\0child-turn-2": {
      provider: "codex",
      threadId: "child-2",
      taskThreadId: "root",
      parentThreadId: "root",
      parentTurnId: "root-turn",
      aggregateOnly: true,
      turnId: "child-turn-2",
      taskTitle: "Root task",
      title: "Прерванный скрытый результат субагента",
      status: "aborted",
      usageReported: true,
      usage: { inputTokens: 25_000 },
      completedAt: "2026-07-27T00:03:00.000Z",
    },
    "codex\0grandchild\0grandchild-turn": {
      provider: "codex",
      threadId: "grandchild",
      taskThreadId: "root",
      parentThreadId: "child",
      parentTurnId: "child-turn",
      aggregateOnly: true,
      turnId: "grandchild-turn",
      taskTitle: "Root task",
      title: "Вложенный субагент",
      usageReported: true,
      usage: { inputTokens: 10_000 },
      completedAt: "2026-07-27T00:04:00.000Z",
    },
  });

  assert.match(projected, /data-work-log-thread-id="root"/);
  assert.match(projected, /<span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>23,1 cr<\/span>/);
  assert.equal((projected.match(/data-work-log-turn-id=/g) ?? []).length, 4);
  assert.equal((projected.match(/data-work-log-turn-subagent="1"/g) ?? []).length, 3);
  assert.match(projected, /Основной результат/);
  assert.match(projected, /Субагент · Скрытый результат субагента/);
  assert.match(projected, /Субагент · Прерванный скрытый результат субагента/);
  assert.match(projected, /Субагент · Вложенный субагент/);
  assert.match(
    projected,
    /data-work-log-turn-thread-id="child" data-work-log-task-thread-id="root" data-work-log-turn-parent-thread-id="root" data-work-log-turn-parent-turn-id="root-turn" data-work-log-turn-depth="1" data-work-log-turn-id="child-turn"/,
  );
  assert.match(
    projected,
    /data-work-log-turn-id="root-turn"[\s\S]*data-work-log-turn-children-details>[\s\S]*data-work-log-turn-id="child-turn"[\s\S]*data-work-log-turn-children-details>[\s\S]*data-work-log-turn-id="grandchild-turn"/,
  );
  assert.match(projected, /Показать субагентов \(3\)/);
  assert.match(projected, /Показать субагентов \(1\)/);
  assert.doesNotMatch(projected, /data-work-log-turn-children-details open/);
  assert.match(
    projected,
    /root-turn[\s\S]*data-work-log-turn-measure>[^<]+ — <span [^>]*>23,1 cr<\/span>[\s\S]*<strong>Свой расход:<\/strong> <span [^>]*>12,5 cr<\/span>/,
  );
  assert.match(
    projected,
    /child-turn[\s\S]*data-work-log-turn-measure>[^<]+ — <span [^>]*>7,5 cr<\/span>[\s\S]*<strong>Свой расход:<\/strong> <span [^>]*>6,3 cr<\/span>/,
  );
  assert.match(projected, /data-work-log-turn-depth="2" data-work-log-turn-id="grandchild-turn"/);
  assert.doesNotMatch(projected, /data-work-log-thread-id="child"/);
});

test("usage store quarantines inherited parent turns copied into a subagent rollout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-subagent-fork-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const childThreadId = "019fa366-e7a9-7aa1-b38a-6823c3a67e77";
    const inheritedTurnId = "019fa362-ffaf-7cd3-9c8f-480d9724657a";
    const childTurnId = "019fa366-e87d-7933-8ae8-f33a5200b24e";
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 5,
      turns: {
        [`codex\0${childThreadId}\0${inheritedTurnId}`]: {
          provider: "codex",
          threadId: childThreadId,
          taskThreadId: "root",
          parentThreadId: "root",
          aggregateOnly: true,
          turnId: inheritedTurnId,
          taskTitle: "Root task",
          title: "Copied parent turn",
          usage: { inputTokens: 100_000 },
          completedAt: "2026-07-27T11:47:38.192Z",
        },
        [`codex\0${childThreadId}\0${childTurnId}`]: {
          provider: "codex",
          threadId: childThreadId,
          taskThreadId: "root",
          parentThreadId: "root",
          aggregateOnly: true,
          turnId: childTurnId,
          taskTitle: "Root task",
          title: "Real child turn",
          usage: { inputTokens: 50_000 },
          completedAt: "2026-07-27T11:50:38.875Z",
        },
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");

    const store = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await store.project(workLogFile), { projected: true });
    const projected = await projectedJournal(store);
    assert.match(projected, /<span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>6,3 cr<\/span>/);
    assert.match(projected, /Субагент · Real child turn/);
    assert.doesNotMatch(projected, /Copied parent turn/);
    const persisted = await persistedLedger(store);
    assert.deepEqual(Object.keys(persisted.turns), [`codex\0${childThreadId}\0${childTurnId}`]);
    const quarantined = JSON.parse(await readFile(`${ledgerFile}.invalid-records.json`, "utf8"));
    assert.equal(quarantined.records.length, 1);
    assert.equal(quarantined.records[0].record.turnId, inheritedTurnId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store projects each turn into its own placeholder and deduplicates retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-usage-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      [
        "<details open><summary><strong>25.07.2026</strong></summary><table><tbody><tr><td>Task</td><td>Outcome</td><td>",
        `<span data-usage-id="${WORK_ID}">${WORK_ID}</span> + `,
        `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
        "</td></tr></tbody></table></details>",
      ].join(""),
      "utf8",
    );
    const store = new WorkLogUsageStore({ ledgerFile });
    const base = {
      provider: "codex",
      threadId: "thread-1",
      workLogId: WORK_ID,
      usageReported: true,
      workLogFile,
      usage: {
        inputTokens: 110,
        cachedInputTokens: 100,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      },
      text: "Первый результат",
    };
    await store.recordAndProject({ ...base, turnId: "turn-1" });
    await store.recordAndProject({ ...base, turnId: "turn-1" });
    await store.recordAndProject({
      ...base,
      turnId: "turn-2",
      workLogId: SECOND_WORK_ID,
      text: "Второй результат",
    });
    const projected = await projectedJournal(store);
    assert.match(
      projected,
      /data-day-usage><span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>0,0 cr<\/span>/,
    );
    assert.equal((projected.match(/data-day-usage-breakdown/g) ?? []).length, 1);
    assert.match(
      projected,
      /<details data-task-usage-details><summary data-task-usage><span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>0,0 cr<\/span> <span data-usage-percent>\(100%\)<\/span><\/summary><span data-task-usage-breakdown><span data-task-usage-part>Вход:/,
    );
    assert.doesNotMatch(projected, /data-usage-id=/u);
    const ledger = await persistedLedger(store);
    assert.equal(Object.keys(ledger.turns).length, 2);
    assert.deepEqual(
      Object.values(ledger.turns).map((record) => record.body),
      ["Первый результат", "Второй результат"],
    );
    const restored = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await restored.project(workLogFile), {
      projected: false,
      reason: "unchanged",
    });
    assert.deepEqual(await restored.project(path.join(root, "MISSING.md")), {
      projected: false,
      reason: "unchanged",
    });
    await assert.rejects(
      store.recordAndProject({ ...base, turnId: "turn-3" }),
      /already assigned to another turn/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh usage store reprojects an existing work log with its persisted ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-reproject-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 1,
      turns: {
        turn: {
          workLogId: WORK_ID,
          usage: { inputTokens: 1_756_500 },
          completedAt: "2026-07-25T00:00:00.000Z",
          text: "Сохранённый результат",
          prompt: [
            "# Response annotations:",
            "<response-annotations>",
            '[{"text":"Старый ответ","annotation":"Сохранённый вопрос"}]',
            "</response-annotations>",
            "## My request for Codex:",
          ].join("\n"),
        },
      },
    })}\n`, "utf8");
    await writeFile(
      workLogFile,
      `<details open><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td>Task</td><td>Outcome</td><td><span data-usage-id="${WORK_ID}" hidden></span></td></tr>`
        + "</tbody></table></details>",
      "utf8",
    );

    const store = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await store.project(workLogFile), { projected: true });
    const projected = await projectedJournal(store);
    assert.match(projected, /data-task-usage><span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>219,6 cr<\/span> <span data-usage-percent>\(100%\)<\/span>/);
    assert.match(projected, /data-work-log-turn-body>Сохранённый результат<\/div>/);
    assert.match(projected, /<strong>Запрос:<\/strong> Сохранённый вопрос/);
    assert.doesNotMatch(projected, /response-annotations|Старый ответ/);
    assert.doesNotMatch(projected, /data-mega-usage[^>]*>[^<]*cr/);
    const persisted = await persistedLedger(store);
    assert.equal(Object.values(persisted.turns)[0].prompt, "Сохранённый вопрос");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store backfills exact model and Fast tier before recalculating credits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-pricing-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const turnId = "turn-pricing";
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 6,
      turns: {
        [`codex\u0000thread-pricing\u0000${turnId}`]: {
          provider: "codex",
          threadId: "thread-pricing",
          turnId,
          workLogId: WORK_ID,
          projectRoot: root,
           usageReported: true,
           usage: { inputTokens: 1_000_000 },
           model: "gpt-5.6-sol",
           serviceTier: "default",
           startedAt: "2026-07-25T00:00:00.000Z",
           completedAt: "2026-07-25T00:00:00.000Z",
          title: "Тариф восстановлен",
        },
      },
    })}\n`, "utf8");
    await writeFile(
      workLogFile,
      `<details open><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td>Task</td><td>Outcome</td><td><span data-usage-id="${WORK_ID}" hidden></span></td></tr>`
        + "</tbody></table></details>",
      "utf8",
    );

    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    assert.deepEqual(await store.missingPricingTurns(), [{
      provider: "codex",
      threadId: "thread-pricing",
      turnId,
      projectRoot: root,
      startedAt: "2026-07-25T00:00:00.000Z",
    }]);
    assert.deepEqual(await store.synchronizePricingMetadataAndProject({
      items: [{
        provider: "codex",
        threadId: "thread-pricing",
        turnId,
        model: "gpt-5.4",
        serviceTier: "fast",
      }],
      projectRoot: root,
      workLogFile,
    }), {
      updated: 1,
      projected: true,
    });
    const projected = await projectedJournal(store);
    assert.match(projected, /Итого<\/span> <span [^>]*data-kilo-usage[^>]*>125 cr<\/span>/);
    assert.match(
      projected,
      /<div data-work-log-turn-facts><div data-work-log-turn-pricing>gpt-5\.4 · Fast ×2<\/div><div data-work-log-turn-context><strong>Длит\.:<\/strong>/,
    );
    const persisted = await persistedLedger(store);
    assert.equal(
      persisted.turns[`codex\u0000thread-pricing\u0000${turnId}`].pricingMetadataResolved,
      true,
    );
    assert.deepEqual(await store.missingPricingTurns(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store backfills a verified image generation estimate and reprojects credits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-image-estimate-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const turnId = "turn-image";
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 6,
      turns: {
        [`codex\u0000thread-image\u0000${turnId}`]: {
          provider: "codex",
          threadId: "thread-image",
          turnId,
          workLogId: WORK_ID,
          projectRoot: root,
          usageReported: true,
          usage: { inputTokens: 100_000 },
          prompt: "Сгенерируй навыком imagegen фон ночного леса",
          model: "gpt-5.6-sol",
          serviceTier: "default",
          startedAt: "2026-07-25T00:00:00.000Z",
          completedAt: "2026-07-25T00:03:00.000Z",
          title: "Фон создан",
        },
      },
    })}\n`, "utf8");
    await writeFile(
      workLogFile,
      `<details open><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td>Task</td><td>Outcome</td><td><span data-usage-id="${WORK_ID}" hidden></span></td></tr>`
        + "</tbody></table></details>",
      "utf8",
    );

    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    assert.deepEqual(await store.missingImageGenerationEstimateTurns(), [{
      provider: "codex",
      threadId: "thread-image",
      turnId,
      projectRoot: root,
      startedAt: "2026-07-25T00:00:00.000Z",
    }]);
    assert.deepEqual(await store.synchronizeUsageEstimatesAndProject({
      items: [{
        provider: "codex",
        threadId: "thread-image",
        turnId,
        estimatedCredits: 90,
        estimateKind: "imagegen-default",
      }],
      projectRoot: root,
      workLogFile,
    }), {
      updated: 1,
      projected: true,
    });
    const projected = await projectedJournal(store);
    assert.match(projected, /ImageGen: <span data-kilo-usage data-usage-credits="90">90 cr<\/span>/);
    assert.deepEqual(await store.missingImageGenerationEstimateTurns(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store restores exact turn texts from deferred notification state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-text-restore-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 1,
      turns: {
        turn: {
          workLogId: WORK_ID,
          usage: { inputTokens: 100 },
          completedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    })}\n`, "utf8");
    const store = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await store.mergeTurnTexts([
      { workLogId: WORK_ID, text: "Точный текст из Telegram" },
      { workLogId: "invalid", text: "Не попадёт" },
    ]), { updated: 1 });
    assert.deepEqual(await store.mergeTurnTexts([
      { workLogId: WORK_ID, text: "Точный текст из Telegram" },
    ]), { updated: 0 });
    const ledger = await persistedLedger(store);
    assert.equal(Object.values(ledger.turns)[0].body, "Точный текст из Telegram");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic usage attaches to the only row for the thread and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-automatic-exact-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const completedAt = new Date(2026, 6, 25, 12, 34).toISOString();
    await writeFile(
      workLogFile,
      `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td><a href="vscode://openai.chatgpt/local/thread-1">Task</a></td>`
        + "<td>Outcome</td><td></td></tr></tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({
      ledgerFile,
      randomUUID: () => WORK_ID,
    });
    const input = {
      threadId: "thread-1",
      turnId: "turn-aborted",
      usageReported: true,
      usage: { inputTokens: 1_756_500 },
      completedAt,
      text: "Остановленный ход",
      workLogFile,
    };
    assert.deepEqual(await store.recordAutomaticAndProject(input), {
      recorded: true,
      usage: {
        inputTokens: 1_756_500,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      workLogId: null,
      target: "thread-day-row",
      projected: true,
    });
    let projected = await projectedJournal(store);
    assert.equal(projected.match(/data-usage-id=/g)?.length ?? 0, 0);
    assert.match(projected, /data-work-log-thread-id="thread-1"/);
    assert.match(projected, /data-work-log-turn-id="turn-aborted"/);
    assert.match(projected, /Остановленный ход/);
    assert.equal((await store.recordAutomaticAndProject(input)).recorded, false);
    projected = await projectedJournal(store);
    assert.equal(projected.match(/data-usage-id=/g)?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic batch records many historical turns and projects once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-automatic-batch-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const records = ["first", "second"].map((turnId, index) => ({
      provider: "claude",
      threadId: "claude-session",
      turnId,
      projectRoot: root,
      taskTitle: "Claude Work",
      title: `Ход ${index + 1}`,
      body: `Ответ ${index + 1}`,
      prompt: `Запрос ${index + 1}`,
      usageReported: true,
      usage: { inputTokens: 100 + index },
      startedAt: `2026-07-27T0${index}:00:00.000Z`,
      completedAt: `2026-07-27T0${index}:01:00.000Z`,
      status: "completed",
    }));

    assert.deepEqual(await store.recordAutomaticBatchAndProject({
      records,
      projectRoot: root,
      workLogFile,
    }), {
      recorded: 2,
      updated: 0,
      projected: true,
    });
    assert.deepEqual(await store.recordAutomaticBatchAndProject({
      records,
      projectRoot: root,
      workLogFile,
    }), {
      recorded: 0,
      updated: 0,
      projected: false,
      reason: "unchanged",
    });
    const ledger = await persistedLedger(store);
    assert.equal(Object.keys(ledger.turns).length, 2);
    const projected = await projectedJournal(store);
    assert.match(projected, /Ответ 1/u);
    assert.match(projected, /Ответ 2/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage projection ignores the legacy WORK_LOG path and uses SQLite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-manual-edit-race-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");
    let edited = false;
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
      beforeProjectionWrite: async () => {
        if (edited) return;
        edited = true;
        await writeFile(workLogFile, "Ручная заметка\n", "utf8");
      },
    });

    await store.recordAutomaticAndProject({
      threadId: "thread-manual",
      turnId: "turn-manual",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Автоматический ход",
      workLogFile,
    });

    const projected = await projectedJournal(store);
    assert.equal(edited, true);
    assert.doesNotMatch(projected, /Ручная заметка/u);
    assert.match(projected, /Автоматический ход/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic SQLite ledger survives a projection failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-durable-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
      beforeProjectionWrite: async () => {
        throw new Error("projection unavailable");
      },
    });
    const result = await store.recordAutomaticAndProject({
      threadId: "thread-durable",
      turnId: "turn-durable",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Сохранено до проекции",
      workLogFile: path.join(root, "ignored.md"),
    });
    assert.equal(result.recorded, true);
    assert.equal(result.projected, false);
    assert.match(result.projectionError, /projection unavailable/i);
    const ledger = await persistedLedger(store);
    assert.equal(Object.keys(ledger.turns).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task title synchronization updates existing ledger turns and the projected journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-task-title-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await store.recordAutomaticAndProject({
      threadId: "thread-title",
      turnId: "turn-title",
      projectRoot: root,
      taskTitle: "Agent Hub",
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Готово",
      workLogFile,
    });

    const result = await store.synchronizeTaskTitlesAndProject({
      titles: [{ provider: "codex", threadId: "thread-title", taskTitle: "Agent HUB" }],
      projectRoot: root,
      workLogFile,
    });

    assert.equal(result.updated, 1);
    assert.equal(result.projected, true);
    const ledger = await persistedLedger(store);
    assert.equal(Object.values(ledger.turns)[0].taskTitle, "Agent HUB");
    const projected = await projectedJournal(store);
    assert.match(
      projected,
      /<button type="button" data-open-task data-provider="codex" data-thread-id="thread-title">Codex - Agent HUB<\/button>/,
    );
    assert.doesNotMatch(projected, />Codex - Agent Hub<\/a>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a late unknown Stop result cannot overwrite an exact terminal status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-status-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const input = {
      threadId: "thread-status",
      turnId: "turn-status",
      projectRoot: root,
      usageReported: false,
      usage: {},
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Статус",
      workLogFile,
    };
    await store.recordAutomaticAndProject({ ...input, status: "aborted" });
    await store.recordAutomaticAndProject({ ...input, status: "unknown" });
    const ledger = await persistedLedger(store);
    assert.equal(Object.values(ledger.turns)[0].status, "aborted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy synthetic interruptions are provisional and retract from the projected journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-provisional-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 4,
      turns: {
        "codex\u0000thread-live\u0000turn-live": {
          provider: "codex",
          threadId: "thread-live",
          turnId: "turn-live",
          projectRoot: root,
          taskTitle: "Живая задача",
          title: "Ход остановлен пользователем",
          body: "Ход остановлен пользователем.",
          status: "aborted",
          completedAt: "2026-07-27T04:00:00.000Z",
          usageReported: false,
        },
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    assert.equal((await store.getTurn({
      provider: "codex",
      threadId: "thread-live",
      turnId: "turn-live",
    })).provisional, true);

    const result = await store.retractProvisionalAndProject({
      provider: "codex",
      threadId: "thread-live",
      turnId: "turn-live",
      projectRoot: root,
      workLogFile,
    });

    assert.equal(result.retracted, true);
    const ledger = await persistedLedger(store);
    assert.equal(ledger.version, 8);
    assert.deepEqual(ledger.turns, {});
    assert.doesNotMatch(await projectedJournal(store), /Живая задача/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy empty auto-compaction subagent turns are removed from the ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-auto-compact-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 8,
      turns: {
        "codex\u0000child-thread\u0000auto-compact-0": {
          provider: "codex",
          threadId: "child-thread",
          taskThreadId: "root-thread",
          parentThreadId: "root-thread",
          aggregateOnly: true,
          turnId: "auto-compact-0",
          projectRoot: root,
          title: "Ход отменён",
          status: "aborted",
          usageReported: false,
          usage: {},
          model: "codex-auto-review",
          startedAt: "2026-07-14T12:00:00.000Z",
          completedAt: "2026-07-14T12:00:00.000Z",
        },
      },
    }, null, 2)}\n`, "utf8");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    assert.deepEqual((await persistedLedger(store)).turns, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store recovers a damaged primary ledger from its backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-recovery-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const seed = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await seed.recordAutomaticAndProject({
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Восстановлено",
      workLogFile,
    });
    await writeFile(ledgerFile, "{damaged", "utf8");
    const recovered = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await recovered.project(workLogFile, { projectRoot: root });
    const ledger = await persistedLedger(recovered);
    assert.equal(Object.keys(ledger.turns).length, 1);
    assert.equal(ledger.version, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store verifies, archives and removes retired legacy journal files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-retire-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const backupRoot = path.join(root, "migrations");
    const record = {
      provider: "codex",
      threadId: "thread-retired",
      taskThreadId: "thread-retired",
      turnId: "turn-retired",
      projectRoot: root,
      completedAt: "2026-08-02T00:00:00.000Z",
      taskTitle: "SQLite cutover",
    };
    const ledger = {
      version: 8,
      turns: {
        [workLogTurnKey(record)]: record,
      },
    };
    const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
    await writeFile(ledgerFile, ledgerText, "utf8");
    await writeFile(`${ledgerFile}.bak`, ledgerText, "utf8");
    await writeFile(`${ledgerFile}.delta.jsonl`, "", "utf8");
    await writeFile(`${ledgerFile}.invalid-records.json`, "{}\n", "utf8");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");

    const store = new WorkLogUsageStore({ ledgerFile });
    const result = await store.retireLegacyStorage({
      workLogFile,
      backupRoot,
      now: new Date("2026-08-02T12:34:56.789Z"),
    });

    assert.equal(result.retired, true);
    assert.equal(result.verification.verified, true);
    assert.equal(
      result.backupDirectory,
      path.join(backupRoot, "sqlite-cutover-2026-08-02T12-34-56-789Z"),
    );
    assert.equal(result.archived.length, 5);
    for (const source of [
      ledgerFile,
      `${ledgerFile}.bak`,
      `${ledgerFile}.delta.jsonl`,
      `${ledgerFile}.invalid-records.json`,
      workLogFile,
    ]) {
      await assert.rejects(readFile(source, "utf8"), { code: "ENOENT" });
      const archived = result.archived.find((item) => item.source === source);
      assert.ok(archived);
      assert.equal(typeof await readFile(archived.backupFile, "utf8"), "string");
    }
    const persisted = await persistedLedger(store);
    assert.equal(Object.keys(persisted.turns).length, 1);
    assert.equal(Object.values(persisted.turns)[0].turnId, "turn-retired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent read-only recovery instances serialize their repair checkpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-read-recovery-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const seed = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await seed.recordAutomaticAndProject({
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Восстановлено чтением",
      workLogFile,
    });
    await writeFile(ledgerFile, "{damaged", "utf8");
    const first = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const second = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const [turn, history] = await Promise.all([
      first.getTurn({ provider: "codex", threadId: "thread-recovery", turnId: "turn-recovery" }),
      second.usageHistory(),
    ]);
    assert.equal(turn.turnId, "turn-recovery");
    assert.equal(typeof history.totalCredits, "number");
    assert.equal((await persistedLedger(first)).version, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite projection can select one requested project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-projects-"));
  try {
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const firstLog = path.join(firstRoot, "WORK_LOG.md");
    const secondLog = path.join(secondRoot, "WORK_LOG.md");
    const ledgerFile = path.join(root, "work-log-usage.json");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: firstRoot });
    await store.recordAutomaticAndProject({
      threadId: "thread-first",
      turnId: "turn-first",
      projectRoot: firstRoot,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      taskTitle: "Первая задача",
      text: "Первый проект",
      workLogFile: firstLog,
    });
    await store.recordAutomaticAndProject({
      threadId: "thread-second",
      turnId: "turn-second",
      projectRoot: secondRoot,
      usageReported: true,
      usage: { inputTokens: 200 },
      completedAt: "2026-07-27T00:01:00.000Z",
      taskTitle: "Вторая задача",
      text: "Второй проект",
      workLogFile: secondLog,
    });
    await store.project(null, { projectRoot: firstRoot });
    const first = await projectedJournal(store);
    await store.project(null, { projectRoot: secondRoot });
    const second = await projectedJournal(store);
    assert.match(first, /Первый проект/);
    assert.doesNotMatch(first, /Второй проект/);
    assert.match(second, /Второй проект/);
    assert.doesNotMatch(second, /Первый проект/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one ledger can project all configured projects into one global journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-global-projects-"));
  try {
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const globalLog = path.join(root, "WORK_LOG.md");
    const ledgerFile = path.join(root, "work-log-usage.json");
    const projectionProjectRoots = [firstRoot, secondRoot];
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await store.recordAutomaticAndProject({
      threadId: "thread-first",
      turnId: "turn-first",
      projectRoot: firstRoot,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      taskTitle: "Первая задача",
      text: "Первый проект",
      workLogFile: globalLog,
      projectionProjectRoots,
    });
    await store.recordAutomaticAndProject({
      threadId: "thread-second",
      turnId: "turn-second",
      projectRoot: secondRoot,
      usageReported: true,
      usage: { inputTokens: 200 },
      completedAt: "2026-07-27T00:01:00.000Z",
      taskTitle: "Вторая задача",
      text: "Второй проект",
      workLogFile: globalLog,
      projectionProjectRoots,
    });

    const global = await projectedJournal(store);
    assert.match(global, /Первый проект/);
    assert.match(global, /Второй проект/);
    assert.equal((global.match(/data-work-log-turn-entry/gu) ?? []).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic usage creates an explicit fallback row for an ambiguous thread", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-automatic-fallback-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const completedAt = new Date(2026, 6, 25, 13, 45).toISOString();
    const linkedRow = (title) => (
      `<tr><td><a href="vscode://openai.chatgpt/local/thread-1">${title}</a></td>`
      + "<td>Outcome</td><td></td></tr>"
    );
    await writeFile(
      workLogFile,
      `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + linkedRow("Task A") + linkedRow("Task B")
        + "</tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({
      ledgerFile,
      randomUUID: () => SECOND_WORK_ID,
    });
    const result = await store.recordAutomaticAndProject({
      threadId: "thread-1",
      turnId: "turn-aborted",
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt,
      text: "Автоматически учтённый ход",
      workLogFile,
    });
    assert.equal(result.target, "thread-day-row");
    const projected = await projectedJournal(store);
    assert.match(projected, /data-work-log-thread-id="thread-1"/);
    assert.match(projected, /Codex - Без названия/);
    assert.doesNotMatch(projected, /data-usage-id=/);
    assert.match(projected, /data-task-usage><span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>0,0 cr<\/span> <span data-usage-percent>\(100%\)<\/span>/);
    assert.match(projected, /13:45 — <span data-kilo-usage[^>]*>0,0 cr<\/span>/);
    assert.match(projected, /Автоматически учтённый ход/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic journal records a stopped turn even when usage is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-no-usage-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      "<details open><summary><strong>25.07.2026</strong></summary><table><tbody></tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({ ledgerFile });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-stopped",
      turnId: "turn-stopped",
      taskTitle: "Остановленная задача",
      status: "aborted",
      title: "Ход остановлен",
      body: "Промежуточный результат сохранён.",
      prompt: "Сделай работу",
      changedFiles: ["src/stopped.mjs"],
      diff: "diff --git a/src/stopped.mjs b/src/stopped.mjs\n+const stopped = true;",
      startedAt: new Date(2026, 6, 25, 12, 0).toISOString(),
      completedAt: new Date(2026, 6, 25, 12, 1).toISOString(),
      usageReported: false,
      workLogFile,
    });
    const projected = await projectedJournal(store);
    assert.match(projected, /Codex - Остановленная задача/);
    assert.match(projected, /12:01 — нет данных/);
    assert.match(projected, /data-work-log-turn-title>Ход остановлен<\/span>/);
    assert.match(projected, /data-work-log-turn-prompt><strong>Запрос:<\/strong> Сделай работу<\/div>/);
    assert.doesNotMatch(projected, /data-work-log-turn-diff/u);
    assert.doesNotMatch(projected, /data-work-log-turn-files>[\s\S]*stopped\.mjs/u);
    const ledger = await persistedLedger(store);
    assert.equal(Object.values(ledger.turns)[0].usageReported, false);
    assert.match(Object.values(ledger.turns)[0].diff, /stopped = true/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic journal marks only the image-generated turn while task and day totals stay plain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-image-estimate-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");
    const store = new WorkLogUsageStore({ ledgerFile });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-art",
      turnId: "turn-art",
      taskTitle: "Art",
      status: "completed",
      title: "Фон создан",
      prompt: "Нарисуй чёрную дыру — это будет фон журнала",
      startedAt: new Date(2026, 6, 25, 12, 0).toISOString(),
      completedAt: new Date(2026, 6, 25, 12, 3).toISOString(),
      usageReported: true,
      usage: { inputTokens: 100_000 },
      estimatedCredits: 90,
      estimateKind: "imagegen-default",
      workLogFile,
    });
    const projected = await projectedJournal(store);
    assert.match(projected, /Итого<\/span> <span [^>]*data-kilo-usage[^>]*>102,5 cr<\/span>/);
    assert.match(projected, /ImageGen: <span data-kilo-usage data-usage-credits="90">90 cr<\/span> <span data-usage-percent>\(87,8%\)<\/span>/);
    assert.match(projected, /12:03 — <span data-kilo-usage data-usage-credits="102.5">102,5 cr<\/span>/);
    assert.doesNotMatch(projected, /≈/u);
    assert.doesNotMatch(projected, /Итого<\/span> ≈/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic journal creates the missing local-date section", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-new-day-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      "# Глобальный журнал работ\n\n"
        + "<details><summary><strong>24.07.2026</strong></summary>"
        + "<table><tbody></tbody></table></details>\n",
      "utf8",
    );
    const completedAt = new Date(2026, 6, 25, 15, 30).toISOString();
    const store = new WorkLogUsageStore({ ledgerFile });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-new-day",
      turnId: "turn-new-day",
      taskTitle: "Новая дата",
      title: "Автоматически создана строка",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 1_000 },
      workLogFile,
    });
    const projected = await projectedJournal(store);
    assert.match(projected, /<summary data-work-log-day><strong>25\.07\.2026<\/strong>/);
    assert.match(projected, /data-work-log-thread-id="thread-new-day"/);
    assert.match(projected, /data-work-log-turn-id="turn-new-day"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy outcome restoration matches rows by date and task title", () => {
  const previous = "<details><summary><strong>24.07.2026</strong></summary><table><tbody>"
    + "<tr><td>Codex - Task</td><td>Старый итог</td><td></td></tr>"
    + "</tbody></table></details>";
  const current = "<details><summary><strong>24.07.2026</strong></summary><table><tbody>"
    + "<tr><td>Codex - Task</td><td data-work-log-turn-list></td><td></td></tr>"
    + "</tbody></table></details>";
  const restored = restoreLegacyOutcomes(current, previous);
  assert.match(restored, /data-work-log-restored-outcome>Старый итог<\/div>/);
  assert.match(projectWorkLogUsage(restored), /data-work-log-legacy-outcome>Старый итог<\/div>/);
});

test("full-text work-log search covers prompts, answers, files and local dates", () => {
  const turns = {
    first: {
      provider: "codex",
      projectRoot: "C:\\Projects\\Main",
      threadId: "thread-a",
      taskThreadId: "thread-a",
      turnId: "turn-1",
      taskTitle: "Журнал работ",
      title: "Исправлена доставка",
      prompt: "Почему сообщение дублируется?",
      body: "Дедупликация теперь использует точный itemId.",
      changedFiles: ["assets/mini-app/hub-client.js"],
      completedAt: "2026-07-30T03:15:00.000Z",
    },
    second: {
      provider: "codex",
      projectRoot: "C:\\Projects\\Other",
      threadId: "thread-b",
      turnId: "turn-2",
      taskTitle: "Чужой проект",
      body: "Дедупликация",
      completedAt: "2026-07-30T04:00:00.000Z",
    },
  };
  const byAnswer = searchWorkLogRecords(turns, "точный itemId", {
    projectRoots: ["C:\\Projects\\Main"],
  });
  assert.equal(byAnswer.length, 1);
  assert.equal(byAnswer[0].threadId, "thread-a");
  assert.equal(byAnswer[0].matches[0].field, "Ответ");
  assert.match(byAnswer[0].matches[0].snippet, /itemId/u);

  assert.equal(searchWorkLogRecords(turns, "hub-client.js")[0].matches[0].field, "Файлы");
  assert.equal(searchWorkLogRecords(turns, "30.07.2026")[0].matches[0].field, "Дата");
});
