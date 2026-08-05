import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskReadStateStore, taskHasUnreadAnswer } from "./src/infrastructure/persistence/task-read-state-store.mjs";

test("read cursor is shared by account, not trusted device", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-read-state-"));
  const store = new TaskReadStateStore({ dataDir: directory, now: () => 1_700_000_000_000 });
  try {
    const task = {
      accountId: "owner-42",
      provider: "codex",
      threadId: "thread-1",
      answerAt: "2026-08-02T10:00:00.000Z",
      answerTurnId: "turn-1",
    };
    assert.equal(taskHasUnreadAnswer(task, store.get(task)), true);
    store.markRead(task);
    assert.equal(taskHasUnreadAnswer(task, store.get({
      accountId: "owner-42",
      provider: "codex",
      threadId: "thread-1",
    })), false);
    assert.equal(taskHasUnreadAnswer(task, store.get({
      accountId: "another-owner",
      provider: "codex",
      threadId: "thread-1",
    })), true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("read cursor does not hide a later answer or a different equal-time turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-read-state-"));
  const store = new TaskReadStateStore({ dataDir: directory });
  const base = {
    accountId: "owner",
    provider: "claude",
    threadId: "thread-1",
    answerAt: "2026-08-02T10:00:00.000Z",
    answerTurnId: "turn-1",
  };
  try {
    store.markRead(base);
    assert.equal(taskHasUnreadAnswer({ ...base, answerTurnId: "turn-2" }, store.get(base)), true);
    assert.equal(taskHasUnreadAnswer({
      ...base,
      answerAt: "2026-08-02T10:00:01.000Z",
      answerTurnId: "turn-2",
    }, store.get(base)), true);
    const before = store.get(base);
    store.markRead({ ...base, answerAt: "2026-08-02T09:59:59.000Z", answerTurnId: "old" });
    assert.deepEqual(store.get(base), before);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
