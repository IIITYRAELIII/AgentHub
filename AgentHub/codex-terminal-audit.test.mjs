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
        terminals: active ? [] : [{
          turnId: "turn-active",
          status: "aborted",
          completedAt: new Date(nowMs).toISOString(),
        }],
        nextOffset: fileSize,
      };
    },
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });
  audit.restore({
    completedThrough: "2026-07-27T04:00:00.000Z",
    positions: [["thread-active", { path: "active.jsonl", offset: 50 }]],
  });

  await audit.run();
  active = false;
  fileSize = 120;
  nowMs += 60_000;
  await audit.run();

  assert.deepEqual(starts, [50, 100]);
  assert.deepEqual(recovered, ["turn-active"]);
  assert.equal(audit.snapshot().positions[0][1].offset, 120);
});
