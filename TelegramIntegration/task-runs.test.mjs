import assert from "node:assert/strict";
import test from "node:test";
import { TaskRunRegistry, serializableTaskRun, taskRunKey } from "./task-runs.mjs";

function run(overrides = {}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    provider: "codex",
    projectRoot: "C:\\Work\\Project",
    threadId: "thread-1",
    turnId: null,
    status: "running",
    ...overrides,
  };
}

test("different tasks and projects can run at the same time", () => {
  const first = run({ id: "run-1" });
  const second = run({ id: "run-2", threadId: "thread-2" });
  const third = run({ id: "run-3", projectRoot: "C:\\Work\\Other" });
  const registry = new TaskRunRegistry([first, second, third]);

  assert.equal(registry.size, 3);
  assert.equal(registry.forTask(first), first);
  assert.deepEqual(registry.inProject(first.projectRoot), [first, second]);
});

test("a task cannot start a second concurrent turn", () => {
  const registry = new TaskRunRegistry([run({ id: "run-1" })]);
  assert.throws(() => registry.add(run({ id: "run-2" })), /already running/);
});

test("turn and thread events resolve to their own runs", () => {
  const first = run({ id: "run-1", turnId: "turn-1" });
  const second = run({ id: "run-2", threadId: "thread-2", turnId: "turn-2" });
  const registry = new TaskRunRegistry([first, second]);

  assert.equal(registry.forEvent({ turnId: "turn-2" }), second);
  assert.equal(registry.forEvent({ threadId: "thread-1" }), first);
});

test("reindex follows a Claude session id assigned after startup", () => {
  const provisional = run({ id: "run-1", provider: "claude", threadId: null });
  const registry = new TaskRunRegistry([provisional]);
  provisional.threadId = "session-1";
  registry.reindex(provisional, { threadId: null });

  assert.equal(registry.forTask({ ...provisional, threadId: null }), null);
  assert.equal(registry.forTask(provisional), provisional);
});

test("task keys normalize Windows project path casing", () => {
  if (process.platform !== "win32") return;
  assert.equal(
    taskRunKey(run({ projectRoot: "C:\\WORK\\Project" })),
    taskRunKey(run({ projectRoot: "c:\\work\\project" })),
  );
});

test("serialization excludes process and timer handles", () => {
  const source = run({
    process: { pid: 42 },
    progressStartTimer: { timer: true },
    progressTimer: { timer: true },
    progressUpdateInFlight: true,
  });
  const serialized = serializableTaskRun(source);

  assert.equal(serialized.process, undefined);
  assert.equal(serialized.progressStartTimer, undefined);
  assert.equal(serialized.progressTimer, undefined);
  assert.equal(serialized.progressUpdateInFlight, undefined);
  assert.equal(serialized.id, source.id);
});
