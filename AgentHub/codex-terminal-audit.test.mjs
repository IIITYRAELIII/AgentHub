import assert from "node:assert/strict";
import test from "node:test";

import { CodexTerminalAudit } from "./codex-terminal-audit.mjs";

const project = { path: "D:\\workspace" };

function thread(id, updatedAt, path = `${id}.jsonl`) {
  return {
    id,
    cwd: project.path,
    path,
    updatedAt,
    status: { type: "idle" },
  };
}

function subagentThread(id, updatedAt, path = `${id}.jsonl`) {
  return {
    ...thread(id, updatedAt, path),
    parentThreadId: "parent-thread",
  };
}

test("terminal audit bootstraps recent turns and seeds older rollout positions", async () => {
  const nowMs = Date.parse("2026-07-27T04:00:00.000Z");
  const pages = [
    {
      data: [
        thread("recent", "2026-07-27T03:50:00.000Z"),
        thread("old", "2026-07-26T01:00:00.000Z"),
      ],
      nextCursor: "page-2",
    },
    {
      data: [thread("older", "2026-07-25T01:00:00.000Z")],
      nextCursor: null,
    },
  ];
  const scans = [];
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => nowMs,
    listPage: async (cursor) => pages[cursor ? 1 : 0],
    resolveProject: () => project,
    statFile: async (path) => ({ size: path === "recent.jsonl" ? 120 : 500 }),
    scanFile: async (path, { startOffset }) => {
      scans.push([path, startOffset]);
      return {
        terminals: [{
          turnId: "turn-recent",
          status: "aborted",
          completedAt: "2026-07-27T03:51:00.000Z",
        }],
        nextOffset: 120,
      };
    },
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });

  assert.equal(await audit.run(), true);
  assert.deepEqual(scans, [["recent.jsonl", 0]]);
  assert.deepEqual(recovered, ["turn-recent"]);
  assert.equal(audit.snapshot().completedThrough, "2026-07-27T04:00:00.000Z");
  assert.deepEqual(audit.snapshot().positions, [
    ["recent", { path: "recent.jsonl", offset: 120 }],
    ["old", { path: "old.jsonl", offset: 500 }],
    ["older", { path: "older.jsonl", offset: 500 }],
  ]);
});

test("terminal audit resumes byte positions after a long server outage", async () => {
  const scans = [];
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-07-29T04:00:00.000Z"),
    listPage: async () => ({
      data: [thread("thread-1", "2026-07-28T12:00:00.000Z", "rollout.jsonl")],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({ size: 180 }),
    scanFile: async (_path, { startOffset }) => {
      scans.push(startOffset);
      return {
        terminals: [{
          turnId: "turn-after-outage",
          status: "completed",
          completedAt: "2026-07-28T12:00:00.000Z",
        }],
        nextOffset: 180,
      };
    },
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });
  audit.restore({
    version: 6,
    completedThrough: "2026-07-27T04:00:00.000Z",
    positions: [["thread-1", { path: "rollout.jsonl", offset: 100 }]],
  });

  assert.equal(await audit.run(), true);
  assert.deepEqual(scans, [100]);
  assert.deepEqual(recovered, ["turn-after-outage"]);
  assert.equal(audit.snapshot().completedThrough, "2026-07-29T04:00:00.000Z");
  assert.equal(audit.snapshot().positions[0][1].offset, 180);
});

test("terminal audit follows every thread-list page newer than its cursor", async () => {
  const calls = [];
  const reconciled = [];
  const pages = new Map([
    [null, {
      data: [
        thread("one", "2026-07-27T04:03:00.000Z"),
        thread("two", "2026-07-27T04:02:00.000Z"),
      ],
      nextCursor: "two",
    }],
    ["two", {
      data: [
        thread("three", "2026-07-27T04:01:00.000Z"),
        thread("boundary", "2026-07-27T04:00:00.000Z"),
      ],
      nextCursor: "three",
    }],
    ["three", {
      data: [thread("old", "2026-07-26T04:00:00.000Z")],
      nextCursor: null,
    }],
  ]);
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-07-27T04:04:00.000Z"),
    pageSize: 2,
    listPage: async (cursor, limit) => {
      calls.push([cursor, limit]);
      return pages.get(cursor);
    },
    resolveProject: () => project,
    statFile: async () => ({ size: 10 }),
    scanFile: async (path) => ({
      terminals: [{
        turnId: path,
        status: "aborted",
        completedAt: "2026-07-27T04:01:00.000Z",
      }],
      nextOffset: 10,
    }),
    reconcile: async (_thread, _project, terminal) => reconciled.push(terminal.turnId),
  });
  audit.restore({
    version: 6,
    completedThrough: "2026-07-27T04:00:00.000Z",
    positions: [],
  });

  await audit.run();
  assert.deepEqual(calls, [
    [null, 2],
    ["two", 2],
    ["three", 2],
  ]);
  assert.deepEqual(reconciled, [
    "one.jsonl",
    "two.jsonl",
    "three.jsonl",
    "boundary.jsonl",
  ]);
});

test("terminal audit does not advance its cursor past a deferred terminal", async () => {
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-07-27T04:01:00.000Z"),
    listPage: async () => ({
      data: [thread("thread-1", "2026-07-27T04:00:30.000Z")],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({ size: 20 }),
    scanFile: async () => ({
      terminals: [{
        turnId: "too-fresh",
        status: "completed",
        completedAt: "2026-07-27T04:00:59.000Z",
      }],
      nextOffset: 20,
    }),
    reconcile: async () => false,
  });
  audit.restore({
    version: 6,
    completedThrough: "2026-07-27T04:00:00.000Z",
    positions: [["thread-1", { path: "thread-1.jsonl", offset: 10 }]],
  });

  assert.equal(await audit.run(), false);
  assert.equal(audit.snapshot().completedThrough, "2026-07-27T04:00:00.000Z");
  assert.equal(audit.snapshot().positions[0][1].offset, 10);
});

test("terminal audit advances through an active rollout and reads its later terminal", async () => {
  let nowMs = Date.parse("2026-07-27T04:01:00.000Z");
  let fileSize = 100;
  let active = true;
  const starts = [];
  const observedStarts = [];
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => nowMs,
    listPage: async () => ({
      data: [{
        ...thread("thread-active", nowMs, "active.jsonl"),
        status: { type: active ? "active" : "idle" },
      }],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({ size: fileSize }),
    scanFile: async (_path, { startOffset }) => {
      starts.push(startOffset);
      return {
        terminals: active || startOffset >= fileSize ? [] : [{
          turnId: "turn-active",
          status: "aborted",
          completedAt: new Date(nowMs).toISOString(),
        }],
        activeTurns: active ? [{
          turnId: "turn-active",
          startedAt: "2026-07-27T04:00:30.000Z",
          lastActivityAt: "2026-07-27T04:01:00.000Z",
        }] : [],
        nextOffset: fileSize,
      };
    },
    onTurnStarted: async (observedThread, observedProject, turn) => {
      observedStarts.push([observedThread.id, observedProject.path, turn.turnId]);
    },
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });
  audit.restore({
    version: 6,
    completedThrough: "2026-07-27T04:00:00.000Z",
    positions: [["thread-active", { path: "active.jsonl", offset: 50 }]],
  });

  await audit.run();
  active = false;
  fileSize = 120;
  nowMs += 60_000;
  await audit.run();

  assert.deepEqual(starts, [50, 100, 120]);
  assert.deepEqual(observedStarts, [["thread-active", project.path, "turn-active"]]);
  assert.deepEqual(recovered, ["turn-active"]);
  assert.equal(audit.snapshot().positions[0][1].offset, 120);
});

test("terminal audit recovers an interrupted turn when rollout has no terminal event", async () => {
  let nowMs = Date.parse("2026-07-27T04:00:00.000Z");
  let scans = 0;
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => nowMs,
    statusIdleMs: 5_000,
    listPage: async () => ({
      data: [thread("thread-missing-terminal", "2026-07-27T04:00:00.000Z", "missing.jsonl")],
      nextCursor: null,
    }),
    readThread: async () => ({
      thread: {
        ...thread(
          "thread-missing-terminal",
          "2026-07-27T04:00:04.000Z",
          "missing.jsonl",
        ),
        turns: [{
          id: "turn-missing-terminal",
          status: "interrupted",
        }],
      },
    }),
    resolveProject: () => project,
    statFile: async () => ({ size: 100, mtimeMs: nowMs }),
    scanFile: async () => ({
      terminals: [],
      activeTurns: scans++ === 0
        ? [{
          turnId: "turn-missing-terminal",
          startedAt: "2026-07-27T03:59:00.000Z",
          lastActivityAt: "2026-07-27T04:00:04.000Z",
        }]
        : [],
      nextOffset: 100,
    }),
    reconcile: async (_thread, _project, terminal) => {
      recovered.push(terminal);
      return true;
    },
  });

  await audit.run();
  assert.equal(audit.snapshot().pendingTurns.length, 1);
  nowMs += 6_000;
  await audit.run();

  assert.deepEqual(recovered, [{
    turnId: "turn-missing-terminal",
    status: "aborted",
    completedAt: "2026-07-27T04:00:04.000Z",
    authoritative: true,
  }]);
  assert.equal(audit.snapshot().pendingTurns.length, 0);
});

test("terminal audit does not trust interrupted status while the exact rollout turn is active", async () => {
  let nowMs = Date.parse("2026-07-27T04:00:00.000Z");
  let active = true;
  const recovered = [];
  const retracted = [];
  const audit = new CodexTerminalAudit({
    now: () => nowMs,
    statusIdleMs: 5_000,
    listPage: async () => ({
      data: [thread("thread-compacting", nowMs, "compacting.jsonl")],
      nextCursor: null,
    }),
    readThread: async () => ({
      thread: {
        ...thread("thread-compacting", nowMs, "compacting.jsonl"),
        turns: [{ id: "turn-compacting", status: "interrupted" }],
      },
    }),
    isTurnActive: async (_thread, turnId) => active && turnId === "turn-compacting",
    onTurnActive: async (_thread, _project, turnId) => retracted.push(turnId),
    resolveProject: () => project,
    statFile: async () => ({ size: 100, mtimeMs: nowMs }),
    scanFile: async () => ({
      terminals: [],
      activeTurns: [{
        turnId: "turn-compacting",
        startedAt: "2026-07-27T03:59:00.000Z",
        lastActivityAt: "2026-07-27T04:00:00.000Z",
      }],
      nextOffset: 100,
    }),
    reconcile: async (_thread, _project, terminal) => {
      recovered.push(terminal);
      return true;
    },
  });

  await audit.run();
  nowMs += 6_000;
  await audit.run();
  assert.deepEqual(recovered, []);
  assert.deepEqual(retracted, ["turn-compacting"]);
  assert.equal(audit.snapshot().pendingTurns.length, 1);

  active = false;
  nowMs += 30_000;
  await audit.run();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "aborted");
});

test("terminal audit performs one compatible bootstrap for unknown snapshots", () => {
  const audit = new CodexTerminalAudit({
    listPage: async () => ({ data: [], nextCursor: null }),
    resolveProject: () => project,
    reconcile: async () => true,
  });
  audit.restore({
    completedThrough: "2026-07-27T04:00:00.000Z",
    positions: [["legacy", { path: "legacy.jsonl", offset: 100 }]],
  });

  assert.equal(audit.snapshot().completedThrough, "");
  assert.deepEqual(audit.snapshot().positions, []);
});

test("terminal audit bounds persisted per-thread positions", () => {
  const audit = new CodexTerminalAudit({
    listPage: async () => ({ data: [], nextCursor: null }),
    resolveProject: () => project,
    reconcile: async () => true,
    maxPositions: 100,
  });
  audit.restore({
    version: 6,
    positions: Array.from({ length: 120 }, (_, index) => [
      `thread-${index}`,
      { path: `thread-${index}.jsonl`, offset: index },
    ]),
  });
  assert.equal(audit.snapshot().positions.length, 100);
  assert.equal(audit.snapshot().positions[0][0], "thread-20");
});

test("terminal audit uses rollout mtime when thread updatedAt stays at creation time", async () => {
  const scans = [];
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-01T13:34:00.000Z"),
    listPage: async () => ({
      data: [subagentThread(
        "child-thread",
        "2026-08-01T12:55:37.000Z",
        "child.jsonl",
      )],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({
      size: 200,
      mtimeMs: Date.parse("2026-08-01T13:33:30.000Z"),
    }),
    scanFile: async (_path, { startOffset }) => {
      scans.push(startOffset);
      return {
        terminals: [{
          turnId: "child-turn",
          status: "completed",
          completedAt: "2026-08-01T13:33:00.000Z",
        }],
        nextOffset: 200,
      };
    },
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });
  audit.restore({
    version: 6,
    completedThrough: "2026-08-01T13:33:00.000Z",
    positions: [],
  });

  await audit.run();

  assert.deepEqual(scans, [0]);
  assert.deepEqual(recovered, ["child-turn"]);
});

test("terminal audit migrates v4 state and backfills missing subagent rollouts once", async () => {
  const scans = [];
  const recovered = [];
  const pages = new Map([
    [null, {
      data: [thread("old-parent", "2026-07-01T00:00:00.000Z", "parent.jsonl")],
      nextCursor: "children",
    }],
    ["children", {
      data: [subagentThread(
        "missed-child",
        "2026-07-01T00:00:00.000Z",
        "child.jsonl",
      )],
      nextCursor: null,
    }],
  ]);
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-01T14:00:00.000Z"),
    listPage: async (cursor) => pages.get(cursor),
    resolveProject: () => project,
    statFile: async (path) => ({
      size: path === "parent.jsonl" ? 500 : 200,
      mtimeMs: path === "parent.jsonl"
        ? Date.parse("2026-07-01T00:00:00.000Z")
        : Date.parse("2026-08-01T13:20:00.000Z"),
    }),
    scanFile: async (path, { startOffset }) => {
      scans.push([path, startOffset]);
      return {
        terminals: path === "child.jsonl" ? [{
          turnId: "missed-child-turn",
          status: "completed",
          completedAt: "2026-08-01T13:20:00.000Z",
        }] : [],
        nextOffset: path === "parent.jsonl" ? 500 : 200,
      };
    },
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });
  audit.restore({
    version: 6,
    subagentBackfillPending: true,
    completedThrough: "2026-08-01T13:30:00.000Z",
    positions: [["old-parent", { path: "parent.jsonl", offset: 500 }]],
  });

  assert.equal(audit.snapshot().subagentBackfillPending, true);
  await audit.run();

  assert.deepEqual(scans, [["child.jsonl", 0]]);
  assert.deepEqual(recovered, ["missed-child-turn"]);
  assert.equal(audit.snapshot().subagentBackfillPending, false);

  await audit.run();
  assert.deepEqual(scans, [["child.jsonl", 0]]);
});

test("terminal audit migrates v5 state and resumes bounded historical subagent backfill", async () => {
  const chunkBytes = 64 * 1024;
  const fileSize = chunkBytes * 3;
  const scans = [];
  const recovered = [];
  const options = {
    now: () => Date.parse("2026-08-01T14:00:00.000Z"),
    listPage: async () => ({
      data: [subagentThread(
        "historical-child",
        "2026-07-01T00:00:00.000Z",
        "historical-child.jsonl",
      )],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({
      size: fileSize,
      mtimeMs: Date.parse("2026-07-01T00:10:00.000Z"),
    }),
    scanFile: async (_path, scanOptions) => {
      scans.push(scanOptions);
      return {
        terminals: [{
          turnId: `turn-${scanOptions.startOffset}`,
          status: "completed",
          completedAt: "2026-07-01T00:10:00.000Z",
        }],
        activeTurns: [],
        nextOffset: Math.min(scanOptions.startOffset + chunkBytes, fileSize),
      };
    },
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
    historicalSubagentBackfillBytes: chunkBytes,
  };
  const audit = new CodexTerminalAudit(options);
  audit.restore({
    version: 5,
    completedThrough: "2026-08-01T13:30:00.000Z",
    positions: [[
      "historical-child",
      { path: "historical-child.jsonl", offset: fileSize },
    ]],
  });

  await audit.run();
  const afterFirstChunk = audit.snapshot();
  assert.equal(afterFirstChunk.historicalSubagentBackfill.pending, true);
  assert.equal(afterFirstChunk.historicalSubagentBackfill.queue[0].offset, chunkBytes);

  const resumed = new CodexTerminalAudit(options);
  resumed.restore(afterFirstChunk);
  await resumed.run();
  await resumed.run();

  assert.deepEqual(scans.map((value) => value.startOffset), [0, chunkBytes, chunkBytes * 2]);
  assert.ok(scans.every((value) => value.maxBytes === chunkBytes));
  assert.ok(scans.every((value) => value.rolloutId === "historical-child"));
  assert.deepEqual(recovered, ["turn-0", `turn-${chunkBytes}`, `turn-${chunkBytes * 2}`]);
  const completed = resumed.snapshot().historicalSubagentBackfill;
  assert.equal(completed.pending, false);
  assert.equal(completed.totalFiles, 1);
  assert.equal(completed.completedFiles, 1);
  assert.equal(completed.processedTurns, 3);
  assert.deepEqual(completed.queue, []);
});

test("historical subagent backfill merges filesystem-only archived rollouts", async () => {
  const archived = subagentThread(
    "archived-child",
    "2026-07-01T00:00:00.000Z",
    "archived-child.jsonl",
  );
  const scans = [];
  const audit = new CodexTerminalAudit({
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [archived],
    resolveProject: () => project,
    statFile: async () => ({
      size: 100,
      mtimeMs: Date.parse("2026-07-01T00:10:00.000Z"),
    }),
    scanFile: async (file) => {
      scans.push(file);
      return { terminals: [], activeTurns: [], nextOffset: 100 };
    },
    reconcile: async () => true,
  });
  audit.restore({ version: 5, completedThrough: "2026-08-01T13:30:00.000Z" });

  await audit.run();

  assert.deepEqual(scans, ["archived-child.jsonl"]);
  assert.equal(audit.snapshot().historicalSubagentBackfill.totalFiles, 1);
  assert.equal(audit.snapshot().historicalSubagentBackfill.completedFiles, 1);
});

test("historical subagent backfill records a stale unterminated turn as aborted", async () => {
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-01T14:00:00.000Z"),
    listPage: async () => ({
      data: [subagentThread(
        "interrupted-child",
        "2026-07-01T00:00:00.000Z",
        "interrupted-child.jsonl",
      )],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({
      size: 100,
      mtimeMs: Date.parse("2026-07-01T00:10:00.000Z"),
    }),
    scanFile: async () => ({
      terminals: [],
      activeTurns: [{
        turnId: "unterminated-turn",
        startedAt: "2026-07-01T00:05:00.000Z",
        lastActivityAt: "2026-07-01T00:10:00.000Z",
      }],
      nextOffset: 100,
    }),
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal),
  });
  audit.restore({
    version: 5,
    completedThrough: "2026-08-01T13:30:00.000Z",
    positions: [[
      "interrupted-child",
      { path: "interrupted-child.jsonl", offset: 100 },
    ]],
  });

  await audit.run();

  assert.deepEqual(recovered, [{
    turnId: "unterminated-turn",
    status: "aborted",
    completedAt: "2026-07-01T00:10:00.000Z",
    authoritative: true,
  }]);
  assert.equal(audit.snapshot().historicalSubagentBackfill.pending, false);
  assert.equal(audit.snapshot().historicalSubagentBackfill.processedTurns, 1);
});
