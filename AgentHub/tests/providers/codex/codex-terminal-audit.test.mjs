import assert from "node:assert/strict";
import test from "node:test";

import { CodexTerminalAudit } from "../../../src/providers/codex/codex-terminal-audit.mjs";
import { CODEX_CONTEXT_PROBE_PROMPT } from "../../../src/domain/codex-context-probe.mjs";

const project = { path: "D:\\workspace" };

test("terminal audit uses local rollout discovery without Codex thread/list", async () => {
  let listCalls = 0;
  const scans = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-16T10:00:00.000Z"),
    listPage: async () => {
      listCalls += 1;
      return { data: [], nextCursor: null };
    },
    discoverHistoricalThreads: async () => [thread(
      "local-thread",
      "2026-08-16T09:59:00.000Z",
      "local-thread.jsonl",
    )],
    resolveProject: () => project,
    statFile: async () => ({ size: 10, mtimeMs: Date.parse("2026-08-16T09:59:00.000Z") }),
    scanFile: async (file) => {
      scans.push(file);
      return { terminals: [], activeTurns: [], nextOffset: 10 };
    },
    reconcile: async () => true,
  });

  await audit.run();

  assert.equal(listCalls, 0);
  assert.deepEqual(scans, ["local-thread.jsonl"]);
});

test("completed rollout audit does not rescan and repairs only a newly appended exact image turn", async () => {
  let size = 10;
  const scans = [];
  const reconciled = [];
  const options = {
    now: () => Date.parse("2026-08-16T10:00:00.000Z"),
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [thread(
      "thread-image",
      "2026-08-16T09:59:00.000Z",
      "thread-image.jsonl",
    )],
    resolveProject: () => project,
    statFile: async () => ({ size, mtimeMs: Date.parse("2026-08-16T09:59:00.000Z") }),
    scanFile: async (_file, { startOffset }) => {
      scans.push(startOffset);
      return startOffset === 0 ? {
        turns: [],
        attachmentCandidates: [],
        nextOffset: 10,
        resumeState: { turns: [] },
      } : {
        turns: [],
        attachmentCandidates: [{
          turnId: "turn-image-origin",
          generatedImageSources: [{ type: "generated-path", value: "C:/generated/new.png" }],
        }],
        nextOffset: size,
        resumeState: { turns: [] },
      };
    },
    reconcile: async (_thread, _project, terminal) => {
      reconciled.push(terminal);
      return true;
    },
  };
  const initial = new CodexTerminalAudit(options);
  await initial.run();
  await initial.run();
  assert.deepEqual(scans, [0]);

  const reopened = new CodexTerminalAudit(options);
  reopened.restore(initial.snapshot());
  await reopened.run();
  assert.deepEqual(scans, [0]);

  size = 20;
  await reopened.run();
  await reopened.run();
  assert.deepEqual(scans, [0, 10]);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].turnId, "turn-image-origin");
  assert.equal(reconciled[0].attachmentRepairOnly, true);
  assert.deepEqual(reconciled[0].generatedImageSources, [
    { type: "generated-path", value: "C:/generated/new.png" },
  ]);
});

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

test("terminal audit projects an internal context probe for accounting", async () => {
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-08T10:01:00.000Z"),
    listPage: async () => ({
      data: [thread("probe-thread", "2026-08-08T10:00:30.000Z", "probe.jsonl")],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({ size: 100 }),
    scanFile: async () => ({
      terminals: [{
        turnId: "probe-turn",
        status: "completed",
        completedAt: "2026-08-08T10:00:30.000Z",
        contextProbe: true,
      }],
      activeTurns: [],
      nextOffset: 100,
    }),
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });

  await audit.run();

  assert.deepEqual(recovered, ["probe-turn"]);
});

test("terminal audit projects a late-identified probe for accounting", async () => {
  let nowMs = Date.parse("2026-08-08T10:00:00.000Z");
  let scans = 0;
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => nowMs,
    statusIdleMs: 5_000,
    listPage: async () => ({
      data: [thread("probe-thread", nowMs, "probe.jsonl")],
      nextCursor: null,
    }),
    readThread: async () => ({
      thread: {
        ...thread("probe-thread", nowMs, "probe.jsonl"),
        turns: [{
          id: "probe-turn",
          status: "completed",
          items: [{
            type: "userMessage",
            clientId: "agent-hub-context-probe:late",
            content: [{ type: "text", text: CODEX_CONTEXT_PROBE_PROMPT }],
          }],
        }],
      },
    }),
    resolveProject: () => project,
    statFile: async () => ({ size: 100, mtimeMs: nowMs }),
    scanFile: async () => ({
      terminals: [],
      activeTurns: scans++ === 0 ? [{
        turnId: "probe-turn",
        startedAt: "2026-08-08T10:00:00.000Z",
        lastActivityAt: "2026-08-08T10:00:00.000Z",
      }] : [],
      nextOffset: 100,
    }),
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });

  await audit.run();
  assert.equal(audit.snapshot().pendingTurns.length, 1);
  nowMs += 6_000;
  await audit.run();

  assert.deepEqual(recovered, ["probe-turn"]);
  assert.equal(audit.snapshot().pendingTurns.length, 0);
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
    version: 8,
    completedThrough: "2026-07-27T04:00:00.000Z",
    positions: [["thread-1", { path: "rollout.jsonl", offset: 100 }]],
  });

  assert.equal(await audit.run(), true);
  assert.deepEqual(scans, [100]);
  assert.deepEqual(recovered, ["turn-after-outage"]);
  assert.equal(audit.snapshot().completedThrough, "2026-07-29T04:00:00.000Z");
  assert.equal(audit.snapshot().positions[0][1].offset, 180);
});

test("terminal audit reuses persisted usage state and passes exact usage to reconciliation", async () => {
  const scans = [];
  const reconciled = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-30T04:00:00.000Z"),
    listPage: async () => ({
      data: [thread("thread-indexed", "2026-08-30T03:59:00.000Z", "indexed.jsonl")],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({ size: 120, dev: 7, ino: 9, birthtimeMs: 11 }),
    scanFile: async (_path, options) => {
      scans.push(options);
      return {
        turns: [{
          turnId: "turn-indexed",
          terminal: true,
          status: "aborted",
          completedAt: "2026-08-30T03:59:00.000Z",
          usage: { inputTokens: 42 },
          reported: true,
          model: "gpt-5.6-sol",
        }],
        nextOffset: 120,
        resumeState: { turns: [], activeTurnIds: [], latestModel: "gpt-5.6-sol" },
      };
    },
    reconcile: async (_thread, _project, terminal) => reconciled.push(terminal),
  });
  audit.restore({
    version: 13,
    completedThrough: "2026-08-30T03:58:00.000Z",
    positions: [["thread-indexed", {
      path: "indexed.jsonl",
      offset: 100,
      fileIdentity: "7:9:11",
      resumeState: { turns: [], activeTurnIds: [], latestModel: "gpt-5.6-sol" },
    }]],
  });

  await audit.run();

  assert.equal(scans[0].startOffset, 100);
  assert.equal(scans[0].resumeState.latestModel, "gpt-5.6-sol");
  assert.equal(reconciled[0].usageResult.usage.inputTokens, 42);
  assert.equal(audit.snapshot().positions[0][1].offset, 120);
  assert.equal(audit.snapshot().positions[0][1].fileIdentity, "7:9:11");
});

test("terminal audit resets its offset when a rollout file is replaced", async () => {
  const starts = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-30T04:00:00.000Z"),
    listPage: async () => ({
      data: [thread("thread-replaced", "2026-08-30T03:59:00.000Z", "replaced.jsonl")],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async () => ({ size: 300, dev: 7, ino: 10, birthtimeMs: 12 }),
    scanFile: async (_path, { startOffset }) => {
      starts.push(startOffset);
      return { terminals: [], activeTurns: [], nextOffset: 300 };
    },
    reconcile: async () => true,
  });
  audit.restore({
    version: 13,
    completedThrough: "2026-08-30T03:58:00.000Z",
    positions: [["thread-replaced", {
      path: "replaced.jsonl",
      offset: 200,
      fileIdentity: "7:9:11",
      resumeState: { turns: [], activeTurnIds: [] },
    }]],
  });

  await audit.run();

  assert.deepEqual(starts, [0]);
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
    version: 8,
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
    version: 8,
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
    version: 8,
    completedThrough: "2026-07-27T04:00:00.000Z",
    positions: [["thread-active", { path: "active.jsonl", offset: 50 }]],
  });

  await audit.run();
  active = false;
  fileSize = 120;
  nowMs += 60_000;
  await audit.run();

  assert.deepEqual(starts, [50, 100]);
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
    version: 8,
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
    version: 8,
    completedThrough: "2026-08-01T13:33:00.000Z",
    positions: [],
  });

  await audit.run();

  assert.deepEqual(scans, [0]);
  assert.deepEqual(recovered, ["child-turn"]);
});

test("terminal audit discovers a new subagent rollout omitted by thread/list", async () => {
  let nowMs = Date.parse("2026-08-04T03:00:00.000Z");
  const scans = [];
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => nowMs,
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverSupplementalThreads: async () => [subagentThread(
      "child-thread",
      "2026-08-04T01:00:00.000Z",
      "child.jsonl",
    )],
    supplementalDiscoveryIntervalMs: 30_000,
    resolveProject: () => project,
    statFile: async () => ({ size: 240, mtimeMs: Date.parse("2026-08-04T01:01:00.000Z") }),
    scanFile: async (path, { startOffset }) => {
      scans.push([path, startOffset]);
      return {
        terminals: [{
          turnId: "child-turn",
          status: "completed",
          completedAt: "2026-08-04T01:01:00.000Z",
        }],
        nextOffset: 240,
      };
    },
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });
  audit.restore({
    version: 9,
    completedThrough: "2026-08-04T02:59:00.000Z",
    positions: [],
    pendingTurns: [],
    historicalSubagentBackfill: { pending: false, initialized: true, queue: [] },
  });

  assert.equal(await audit.run(), true);
  assert.deepEqual(scans, [["child.jsonl", 0]]);
  assert.deepEqual(recovered, ["child-turn"]);

  nowMs += 5_000;
  assert.equal(await audit.run(), true);
  assert.deepEqual(scans, [["child.jsonl", 0]]);
});

test("terminal audit migrates v7 and imports an external parent with four subagents", async () => {
  const externalRootId = "external-parent";
  const externalThreads = [
    {
      ...thread(externalRootId, "2026-08-03T11:42:49.000Z", "parent.jsonl"),
      cwd: "C:\\Temp\\agent-hub-hook-model-eval",
      repositoryUrl: "D:\\workspace\\fixture\\origin.git",
    },
    ...["sol", "terra", "luna", "spark"].map((model, index) => ({
      ...subagentThread(
        `external-${model}`,
        `2026-08-03T11:43:${String(index + 5).padStart(2, "0")}.000Z`,
        `${model}.jsonl`,
      ),
      cwd: "C:\\Temp\\agent-hub-hook-model-eval",
      parentThreadId: externalRootId,
      repositoryUrl: "D:\\workspace\\fixture\\origin.git",
    })),
  ];
  const scans = [];
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-03T12:30:00.000Z"),
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => externalThreads,
    resolveProject: async (value) => value.repositoryUrl ? project : null,
    statFile: async () => ({
      size: 100,
      mtimeMs: Date.parse("2026-08-03T11:45:00.000Z"),
    }),
    scanFile: async (file) => {
      scans.push(file);
      return {
        terminals: [{
          turnId: `turn-${file}`,
          status: "completed",
          completedAt: "2026-08-03T11:45:00.000Z",
        }],
        activeTurns: [],
        nextOffset: 100,
      };
    },
    reconcile: async (value, resolvedProject, terminal) => recovered.push({
      threadId: value.id,
      project: resolvedProject,
      turnId: terminal.turnId,
    }),
  });
  audit.restore({
    version: 7,
    completedThrough: "2026-08-03T11:58:00.000Z",
  });

  for (let pass = 0; pass < externalThreads.length + 1
    && audit.snapshot().historicalSubagentBackfill.pending; pass += 1) {
    await audit.run();
  }

  assert.deepEqual(new Set(scans), new Set(externalThreads.map((value) => value.path)));
  assert.deepEqual(
    new Set(recovered.map((value) => value.threadId)),
    new Set(externalThreads.map((value) => value.id)),
  );
  assert.ok(recovered.every((value) => value.project === project));
  assert.ok(recovered.every((value) => value.turnId.startsWith("turn-")));
  assert.equal(audit.snapshot().version, 14);
  assert.equal(audit.snapshot().historicalSubagentBackfill.pending, false);
  assert.equal(audit.snapshot().historicalSubagentBackfill.completedFiles, 5);
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
    version: 8,
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

test("historical rollout backfill visits every file for one resumed thread", async () => {
  const first = thread(
    "resumed-thread",
    "2026-07-01T00:00:00.000Z",
    "resumed-thread-first.jsonl",
  );
  const second = thread(
    "resumed-thread",
    "2026-07-02T00:00:00.000Z",
    "resumed-thread-second.jsonl",
  );
  const scans = [];
  const audit = new CodexTerminalAudit({
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [first, second],
    resolveProject: () => project,
    statFile: async () => ({
      size: 100,
      mtimeMs: Date.parse("2026-07-02T00:10:00.000Z"),
    }),
    scanFile: async (file) => {
      scans.push(file);
      return { terminals: [], activeTurns: [], nextOffset: 100 };
    },
    reconcile: async () => true,
  });
  audit.restore({ version: 6, completedThrough: "2026-08-01T13:30:00.000Z" });

  await audit.run();
  await audit.run();

  assert.deepEqual(scans, ["resumed-thread-first.jsonl", "resumed-thread-second.jsonl"]);
  const completed = audit.snapshot().historicalSubagentBackfill;
  assert.equal(completed.totalFiles, 2);
  assert.equal(completed.completedFiles, 2);
  assert.equal(completed.pending, false);
});

test("historical rollout backfill also restores ordinary Codex threads", async () => {
  const ordinary = thread(
    "ordinary-thread",
    "2026-07-01T00:00:00.000Z",
    "ordinary-thread.jsonl",
  );
  const recovered = [];
  const audit = new CodexTerminalAudit({
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [ordinary],
    resolveProject: () => project,
    statFile: async () => ({
      size: 100,
      mtimeMs: Date.parse("2026-07-01T00:10:00.000Z"),
    }),
    scanFile: async () => ({
      terminals: [{
        turnId: "ordinary-turn",
        status: "completed",
        completedAt: "2026-07-01T00:10:00.000Z",
      }],
      activeTurns: [],
      nextOffset: 100,
    }),
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal),
  });
  audit.restore({ version: 5, completedThrough: "2026-08-01T13:30:00.000Z" });

  await audit.run();

  assert.deepEqual(recovered, [{
    turnId: "ordinary-turn",
    status: "completed",
    completedAt: "2026-07-01T00:10:00.000Z",
    historical: true,
  }]);
  assert.equal(audit.snapshot().historicalSubagentBackfill.totalFiles, 1);
});

test("historical rollout backfill resumes large files and deduplicates before reconciliation", async () => {
  const ordinary = thread(
    "ordinary-thread",
    "2026-07-01T00:00:00.000Z",
    "large-ordinary-thread.jsonl",
  );
  const scans = [];
  const recovered = [];
  const chunkBytes = 64 * 1024;
  const fileSize = chunkBytes * 2;
  let interactive = false;
  const usageResult = (turnId) => ({
    turnId,
    terminal: true,
    status: "completed",
    completedAt: "2026-07-01T00:10:00.000Z",
    reported: true,
    usage: { inputTokens: 42 },
  });
  const options = {
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [ordinary],
    resolveProject: () => project,
    statFile: async () => ({
      size: fileSize,
      mtimeMs: Date.parse("2026-07-01T00:10:00.000Z"),
    }),
    historicalSubagentBackfillBytes: chunkBytes,
    scanHistoricalFile: async () => {
      throw new Error("large rollout must not use the whole-file scanner");
    },
    scanHistoricalChunk: async (_path, scanOptions) => {
      scans.push([scanOptions.startOffset, scanOptions.maxBytes]);
      if (scanOptions.startOffset === 0) {
        return {
          session: { threadId: ordinary.id, parentThreadId: "" },
          turns: [usageResult("first"), usageResult("second")],
          nextOffset: chunkBytes,
          resumeState: { turns: [] },
        };
      }
      return {
        session: { threadId: ordinary.id, parentThreadId: "" },
        turns: [usageResult("second"), usageResult("third")],
        nextOffset: fileSize,
        resumeState: { turns: [] },
      };
    },
    shouldRunHistoricalBackfill: () => !interactive,
    reconcile: async (_thread, _project, terminal) => {
      recovered.push(terminal.turnId);
      if (terminal.turnId === "first") interactive = true;
      return true;
    },
  };
  const audit = new CodexTerminalAudit(options);
  audit.restore({ version: 7, completedThrough: "2026-08-01T13:30:00.000Z" });

  await audit.run();
  assert.deepEqual(scans, [[0, chunkBytes]]);
  assert.deepEqual(recovered, ["first"]);
  assert.equal(audit.snapshot().historicalSubagentBackfill.queue[0].offset, 0);

  interactive = false;
  await audit.run();
  assert.deepEqual(scans, [[0, chunkBytes]]);
  assert.deepEqual(recovered, ["first", "second"]);
  const checkpoint = audit.snapshot();
  assert.equal(checkpoint.historicalSubagentBackfill.queue[0].offset, chunkBytes);

  const resumedAudit = new CodexTerminalAudit(options);
  resumedAudit.restore(checkpoint);
  await resumedAudit.run();

  assert.deepEqual(scans, [[0, chunkBytes], [chunkBytes, chunkBytes]]);
  assert.deepEqual(recovered, ["first", "second", "third"]);
  assert.equal(resumedAudit.snapshot().historicalSubagentBackfill.completedFiles, 1);
  assert.equal(resumedAudit.snapshot().historicalSubagentBackfill.processedTurns, 3);
});

test("terminal audit reruns v11 historical reconciliation once after preparing a backup", async () => {
  const preparations = [];
  const scans = [];
  const options = {
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [thread(
      "previously-completed",
      "2026-08-01T00:00:00.000Z",
      "previously-completed.jsonl",
    )],
    resolveProject: () => project,
    statFile: async () => ({ size: 10, mtimeMs: Date.parse("2026-08-01T00:00:00.000Z") }),
    scanHistoricalFile: async (value) => {
      scans.push(value.path);
      return { turns: [] };
    },
    prepareHistoricalBackfill: async () => {
      preparations.push("prepared");
      return { backupFile: "journal-before-v11.sqlite" };
    },
    reconcile: async () => true,
  };
  const audit = new CodexTerminalAudit(options);
  audit.restore({
    version: 11,
    completedThrough: "2026-08-03T11:58:00.000Z",
    historicalSubagentBackfill: { pending: false, initialized: true, queue: [] },
  });

  await audit.run();

  assert.deepEqual(preparations, ["prepared"]);
  assert.deepEqual(scans, ["previously-completed.jsonl"]);
  const checkpoint = audit.snapshot();
  assert.equal(checkpoint.version, 14);
  assert.equal(checkpoint.historicalSubagentBackfill.pending, false);
  assert.equal(checkpoint.historicalSubagentBackfill.prepared, true);
  assert.equal(
    checkpoint.historicalSubagentBackfill.backupFile,
    "journal-before-v11.sqlite",
  );

  const restored = new CodexTerminalAudit(options);
  restored.restore(checkpoint);
  await restored.run();
  assert.deepEqual(preparations, ["prepared"]);
  assert.deepEqual(scans, ["previously-completed.jsonl"]);
});

test("historical rollout backfill yields while interactive work is active", async () => {
  const scans = [];
  let interactive = true;
  const audit = new CodexTerminalAudit({
    listPage: async () => ({ data: [], nextCursor: null }),
    readThread: async () => ({ thread: { turns: [] } }),
    resolveProject: async () => "C:\\Project",
    discoverHistoricalThreads: async () => [{
      id: "historical-thread",
      cwd: "C:\\Project",
      path: "historical-thread.jsonl",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
    statFile: async () => ({ size: 10, mtimeMs: Date.parse("2026-07-01T00:00:00.000Z") }),
    scanHistoricalFile: async (thread) => {
      scans.push(thread.path);
      return { turns: [] };
    },
    shouldRunHistoricalBackfill: () => !interactive,
    reconcile: async () => true,
  });
  audit.restore({ version: 7, completedThrough: "2026-08-03T11:58:00.000Z" });

  await audit.run();
  assert.deepEqual(scans, []);
  assert.equal(audit.snapshot().historicalSubagentBackfill.pending, true);

  interactive = false;
  await audit.run();
  assert.deepEqual(scans, ["historical-thread.jsonl"]);
  assert.equal(audit.snapshot().historicalSubagentBackfill.pending, false);
});

test("historical rollout backfill pauses inside a scanned file and resumes at the next turn", async () => {
  const scans = [];
  const recovered = [];
  let interactive = false;
  const audit = new CodexTerminalAudit({
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [{
      id: "large-thread",
      cwd: "C:\\Project",
      path: "large-thread.jsonl",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
    resolveProject: async () => "C:\\Project",
    statFile: async () => ({ size: 100, mtimeMs: Date.parse("2026-07-01T00:00:00.000Z") }),
    scanHistoricalFile: async (thread) => {
      scans.push(thread.path);
      return {
        turns: ["first", "second", "third"].map((turnId) => ({
          turnId,
          terminal: true,
          status: "completed",
          completedAt: "2026-07-01T00:00:00.000Z",
        })),
      };
    },
    shouldRunHistoricalBackfill: () => !interactive,
    reconcile: async (_thread, _project, terminal) => {
      recovered.push(terminal.turnId);
      if (terminal.turnId === "first") interactive = true;
      return true;
    },
  });
  audit.restore({
    version: 8,
    completedThrough: "2026-08-03T11:58:00.000Z",
    historicalSubagentBackfill: { pending: true, initialized: false },
  });

  await audit.run();
  assert.deepEqual(recovered, ["first"]);
  assert.equal(audit.snapshot().historicalSubagentBackfill.queue[0].terminalTurnIndex, 1);
  assert.equal(audit.snapshot().historicalSubagentBackfill.pending, true);

  interactive = false;
  await audit.run();
  assert.deepEqual(recovered, ["first", "second", "third"]);
  assert.deepEqual(scans, ["large-thread.jsonl"]);
  assert.equal(audit.snapshot().historicalSubagentBackfill.pending, false);
});

test("historical rollout backfill bounds each pass and flushes projection once", async () => {
  const recovered = [];
  let projections = 0;
  const audit = new CodexTerminalAudit({
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [{
      id: "bounded-thread",
      cwd: "C:\\Project",
      path: "bounded-thread.jsonl",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
    resolveProject: async () => project,
    statFile: async () => ({ size: 10, mtimeMs: Date.parse("2026-07-01T00:00:00.000Z") }),
    scanHistoricalFile: async () => ({
      turns: ["first", "second", "third"].map((turnId) => ({
        turnId,
        terminal: true,
        status: "completed",
        completedAt: "2026-07-01T00:00:00.000Z",
      })),
    }),
    reconcile: async (_thread, _project, terminal) => {
      recovered.push(terminal.turnId);
      return true;
    },
    flushHistoricalProjection: async () => { projections += 1; },
    historicalTurnsPerRun: 2,
  });
  audit.restore({
    version: 11,
    completedThrough: "2026-08-03T11:58:00.000Z",
  });

  await audit.run();
  assert.deepEqual(recovered, ["first", "second"]);
  assert.equal(projections, 0);
  assert.equal(audit.snapshot().historicalSubagentBackfill.projectionPending, true);

  await audit.run();
  assert.deepEqual(recovered, ["first", "second", "third"]);
  assert.equal(projections, 1);
  assert.equal(audit.snapshot().historicalSubagentBackfill.projectionPending, false);
});

test("terminal audit scans current rollouts before historical maintenance", async () => {
  const order = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-26T10:00:00.000Z"),
    listPage: async () => ({
      data: [thread("live-thread", "2026-08-26T09:59:00.000Z", "live.jsonl")],
      nextCursor: null,
    }),
    discoverHistoricalThreads: async () => [thread(
      "historical-thread",
      "2026-07-01T00:00:00.000Z",
      "historical.jsonl",
    )],
    resolveProject: () => project,
    statFile: async () => ({ size: 10, mtimeMs: Date.parse("2026-08-26T09:59:00.000Z") }),
    scanFile: async (file) => {
      order.push(`live:${file}`);
      return { terminals: [], activeTurns: [], nextOffset: 10 };
    },
    scanHistoricalFile: async (value) => {
      order.push(`historical:${value.path}`);
      return { turns: [] };
    },
    reconcile: async () => true,
  });
  audit.restore({ version: 11, completedThrough: "2026-08-26T09:58:00.000Z" });

  await audit.run();

  assert.deepEqual(order, ["live:historical.jsonl", "historical:historical.jsonl"]);
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
    historical: true,
  }]);
  assert.equal(audit.snapshot().historicalSubagentBackfill.pending, false);
  assert.equal(audit.snapshot().historicalSubagentBackfill.processedTurns, 1);
});

test("terminal audit isolates a missing pending rollout from unrelated completed turns", async () => {
  const recovered = [];
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-02T10:00:00.000Z"),
    listPage: async () => ({
      data: [
        thread("valid", "2026-08-02T09:56:00.000Z", "valid.jsonl"),
      ],
      nextCursor: null,
    }),
    resolveProject: () => project,
    statFile: async (file) => {
      if (file === "missing.jsonl") {
        const error = new Error("missing rollout");
        error.code = "ENOENT";
        throw error;
      }
      return { size: 100, mtimeMs: Date.parse("2026-08-02T09:56:00.000Z") };
    },
    scanFile: async () => ({
      terminals: [{
        turnId: "valid-turn",
        status: "completed",
        completedAt: "2026-08-02T09:56:00.000Z",
      }],
      activeTurns: [],
      nextOffset: 100,
    }),
    reconcile: async (_thread, _project, terminal) => recovered.push(terminal.turnId),
  });
  audit.restore({
    version: 8,
    completedThrough: "2026-08-02T09:50:00.000Z",
    pendingTurns: [["missing", {
      thread: thread("missing", "2026-08-02T09:55:00.000Z", "missing.jsonl"),
      turns: [{ turnId: "missing-turn", startedAt: "2026-08-02T09:55:00.000Z" }],
    }]],
  });

  await audit.run();
  assert.deepEqual(recovered, ["valid-turn"]);
  assert.deepEqual(audit.snapshot().positions, [["valid", { path: "valid.jsonl", offset: 100 }]]);
  assert.equal(audit.snapshot().pendingTurns[0][0], "missing");
});

test("production-shaped terminal audit bounds a tick and resumes its durable checkpoint", async () => {
  const nowMs = Date.parse("2026-09-03T12:00:00.000Z");
  const terminals = Array.from({ length: 2_000 }, (_, index) => ({
    turnId: `historical-${index}`,
    status: "completed",
    completedAt: "2026-09-03T11:59:00.000Z",
  }));
  const threads = Array.from({ length: 279 }, (_, index) => thread(
    `thread-${index}`,
    "2026-09-03T11:59:00.000Z",
    `thread-${index}.jsonl`,
  ));
  const reconciled = [];
  const checkpoints = [];
  const scans = [];
  let audit;
  const options = {
    now: () => nowMs,
    discoverHistoricalThreads: async () => threads,
    resolveProject: () => project,
    statFile: async () => ({ size: 512 * 1024, mtimeMs: nowMs }),
    scanFile: async (file, scanOptions) => {
      scans.push([file, scanOptions.startOffset, scanOptions.maxBytes]);
      return file === "thread-0.jsonl"
        ? { terminals, activeTurns: [], nextOffset: 128 * 1024 }
        : { terminals: [], activeTurns: [], nextOffset: 128 * 1024 };
    },
    reconcile: async (_thread, _project, terminal) => {
      reconciled.push(terminal.turnId);
      return true;
    },
    persistProgress: async () => checkpoints.push(audit.snapshot()),
    auditTurnsPerRun: 25,
    auditThreadsPerRun: 8,
    auditBytesPerRun: 512 * 1024,
    liveScanBytes: 128 * 1024,
  };
  audit = new CodexTerminalAudit(options);

  await audit.run();

  assert.equal(reconciled.length, 25);
  assert.equal(scans.length, 1);
  assert.equal(scans[0][2], 128 * 1024);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].positions[0][1].pendingScan.terminalIndex, 25);
  assert.ok(checkpoints[0].positions[0][1].pendingScan.fingerprint.length < 100);
  assert.deepEqual(checkpoints[0].lastRun, {
    completedAt: "2026-09-03T12:00:00.000Z",
    elapsedMs: 0,
    bytes: 128 * 1024,
    threads: 1,
    turns: 25,
    cycleComplete: false,
    yielded: "turns",
  });

  const firstCheckpoint = checkpoints.at(-1);
  audit = new CodexTerminalAudit(options);
  audit.restore(firstCheckpoint);
  await audit.run();

  assert.equal(reconciled.length, 50);
  assert.deepEqual(reconciled.slice(25), terminals.slice(25, 50).map((item) => item.turnId));
  assert.equal(new Set(reconciled).size, reconciled.length);
  assert.equal(checkpoints.at(-1).positions[0][1].pendingScan.terminalIndex, 50);
});

test("terminal audit processes the final permitted scan before yielding its scan budget", async () => {
  const nowMs = Date.parse("2026-09-03T12:00:00.000Z");
  const reconciled = [];
  const audit = new CodexTerminalAudit({
    now: () => nowMs,
    discoverHistoricalThreads: async () => [
      thread("one", "2026-09-03T11:59:00.000Z", "one.jsonl"),
      thread("two", "2026-09-03T11:59:00.000Z", "two.jsonl"),
      thread("three", "2026-09-03T11:59:00.000Z", "three.jsonl"),
    ],
    resolveProject: () => project,
    statFile: async () => ({ size: 16 * 1024, mtimeMs: nowMs }),
    scanFile: async (file) => ({
      terminals: [{
        turnId: file.replace(".jsonl", ""),
        status: "completed",
        completedAt: "2026-09-03T11:59:00.000Z",
      }],
      activeTurns: [],
      nextOffset: 16 * 1024,
    }),
    reconcile: async (_thread, _project, terminal) => reconciled.push(terminal.turnId),
    liveScanBytes: 16 * 1024,
    auditBytesPerRun: 32 * 1024,
    auditThreadsPerRun: 2,
  });

  await audit.run();

  assert.deepEqual(reconciled, ["one", "two"]);
  assert.equal(audit.snapshot().lastRun.threads, 2);
  assert.equal(audit.snapshot().lastRun.bytes, 32 * 1024);
  assert.equal(audit.snapshot().lastRun.yielded, "bytes");
});

test("terminal audit yields to interactive work and flushes one projection per recovered batch", async () => {
  let interactive = false;
  let preemptOnce = true;
  let audit;
  let projections = 0;
  const reconciled = [];
  const checkpoints = [];
  const terminals = Array.from({ length: 10 }, (_, index) => ({
    turnId: `turn-${index}`,
    status: "completed",
    completedAt: "2026-09-03T11:59:00.000Z",
  }));
  audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-09-03T12:00:00.000Z"),
    discoverHistoricalThreads: async () => [{
      ...thread("subagent", "2026-09-03T11:59:00.000Z", "subagent.jsonl"),
      parentThreadId: "parent",
    }],
    resolveProject: () => project,
    statFile: async () => ({ size: 100, mtimeMs: Date.parse("2026-09-03T11:59:00.000Z") }),
    scanFile: async () => ({ terminals, activeTurns: [], nextOffset: 100 }),
    reconcile: async (_thread, _project, terminal) => {
      reconciled.push(terminal.turnId);
      if (preemptOnce) {
        preemptOnce = false;
        interactive = true;
      }
      return true;
    },
    shouldRunAudit: () => !interactive,
    persistProgress: async () => checkpoints.push(audit.snapshot()),
    flushHistoricalProjection: async () => { projections += 1; },
    auditTurnsPerRun: 10,
  });

  await audit.run();

  assert.deepEqual(reconciled, ["turn-0"]);
  assert.equal(projections, 0);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].lastRun.yielded, "interactive");
  assert.equal(checkpoints[0].liveProjectionPending, true);

  interactive = false;
  await audit.run();
  assert.equal(reconciled.length, 10);
  assert.equal(projections, 1);
  assert.equal(checkpoints.at(-1).liveProjectionPending, false);
});
