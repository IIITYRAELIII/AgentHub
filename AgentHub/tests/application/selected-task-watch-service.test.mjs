import assert from "node:assert/strict";
import test from "node:test";

import { SelectedTaskWatchService } from "../../src/application/selected-task-watch-service.mjs";

function fixture({ snapshot = { active: true, turnId: "turn-1" } } = {}) {
  const task = { streamId: "stream-1", provider: "codex", threadId: "thread-1", projectRoot: "C:/work" };
  let selected = task;
  let currentRun = null;
  const events = [];
  const dismissed = new Set();
  const lastSeen = new Map();
  let releaseSnapshot;
  const pendingSnapshot = new Promise((resolve) => { releaseSnapshot = resolve; });
  let delayed = false;
  const service = new SelectedTaskWatchService({
    providers: {
      async call(_provider, method) {
        assert.equal(method, "readRunSnapshot");
        events.push(["snapshot"]);
        return delayed ? pendingSnapshot : snapshot;
      },
    },
    taskRuns: { forTask: () => currentRun },
    dismissedTasks: {
      has: (value) => dismissed.has(value.threadId),
      add: (value) => dismissed.add(value.threadId),
      delete: (value) => dismissed.delete(value.threadId),
    },
    lastSeenTurnIds: lastSeen,
    timers: { schedule: (...args) => events.push(["schedule", ...args.slice(0, 1)]) },
    intervalMs: 50,
    isStopping: () => false,
    selectedTask: () => selected,
    chatId: () => 7,
    activeTaskTitle: () => "Selected title",
    rememberLastTaskMessage: (...args) => events.push(["remember", ...args]),
    createObservedRun: async (...args) => {
      events.push(["create", ...args]);
      return { id: "run-1" };
    },
    scheduleObservedRun: (run) => events.push(["observe", run]),
    saveState: async () => events.push(["save"]),
    autoObserve: ({ task: captured, selectedTask: current }) => (
      captured.threadId === current.threadId && snapshot?.active === true
    ),
    taskKey: (value) => value.streamId,
    logger: {
      log: (...args) => events.push(["log", ...args]),
      error: (...args) => events.push(["error", ...args]),
    },
  });
  return {
    service,
    task,
    events,
    dismissed,
    lastSeen,
    setSelected: (value) => { selected = value; },
    setCurrentRun: (value) => { currentRun = value; },
    delaySnapshot: () => { delayed = true; },
    releaseSnapshot,
  };
}

test("SelectedTaskWatchService observes the exact still-selected active task", async () => {
  const state = fixture();
  assert.equal(await state.service.watch(), true);
  assert.equal(state.events.filter(([name]) => name === "create").length, 1);
  assert.equal(state.events.filter(([name]) => name === "observe").length, 1);
  assert.equal(state.events.filter(([name]) => name === "save").length, 1);
  assert.equal(state.events.at(-1)[0], "schedule");
});

test("SelectedTaskWatchService never applies a stale snapshot after task switch", async () => {
  const state = fixture();
  state.delaySnapshot();
  const watching = state.service.watch();
  state.setSelected({ streamId: "stream-2", provider: "codex", threadId: "thread-2" });
  state.releaseSnapshot({ active: true, turnId: "turn-1" });

  assert.equal(await watching, false);
  assert.equal(state.events.some(([name]) => name === "create"), false);
});

test("SelectedTaskWatchService never overlays a managed run started during snapshot read", async () => {
  const state = fixture();
  state.delaySnapshot();
  const watching = state.service.watch();
  state.setCurrentRun({ id: "managed-run" });
  state.releaseSnapshot({ active: true, turnId: "turn-1" });

  assert.equal(await watching, false);
  assert.equal(state.events.some(([name]) => name === "create"), false);
});

test("SelectedTaskWatchService records a new completed answer without observing it", async () => {
  const state = fixture({ snapshot: { completed: true, active: false, turnId: "turn-9", answer: "Final" } });
  assert.equal(await state.service.watch(), false);
  assert.equal(state.lastSeen.get("stream-1"), "turn-9");
  const remembered = state.events.find(([name]) => name === "remember");
  assert.equal(remembered[1].streamId, "stream-1");
  assert.equal(remembered[1].taskTitle, "Selected title");
  assert.equal(remembered[2], "Final");
});

test("SelectedTaskWatchService clears a dismissal only after external activity ends", async () => {
  const state = fixture({ snapshot: { active: false } });
  state.dismissed.add("thread-1");
  await state.service.watch();
  assert.equal(state.dismissed.has("thread-1"), false);
  assert.equal(state.events.some(([name]) => name === "save"), true);
});
