import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendMessageBindings,
  compactMessageBindings,
  findMessageBinding,
  readMessageBindings,
  removeMessageBindings,
} from "./message-bindings.mjs";

test("message bindings persist and resolve by chat and message", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-bindings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const binding = {
    chatId: 123,
    messageId: 456,
    provider: "codex",
    threadId: "thread-1",
    projectRoot: "C:\\Project",
    createdAt: new Date().toISOString(),
  };
  await appendMessageBindings(directory, [binding]);
  assert.deepEqual(await findMessageBinding(directory, 123, 456), binding);
  assert.equal((await readMessageBindings(directory)).length, 1);
});

test("corrupt binding records are isolated without breaking valid buttons", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-bindings-corrupt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await appendMessageBindings(directory, [{
    chatId: 1,
    messageId: 2,
    provider: "codex",
    threadId: "thread-1",
    projectRoot: "C:\\Project",
    taskTitle: "Task",
  }]);
  const events = path.join(directory, "telegram-thread-bindings.d");
  await mkdir(events, { recursive: true });
  await writeFile(path.join(events, "000-corrupt.json"), "{broken", "utf8");
  assert.equal((await findMessageBinding(directory, 1, 2))?.threadId, "thread-1");
  assert.equal((await readdir(events)).some((name) => name.includes(".invalid-")), true);
});

test("removeMessageBindings removes only matching task messages", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-bindings-remove-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await appendMessageBindings(directory, [{
    chatId: 123,
    messageId: 1,
    provider: "codex",
    threadId: "thread-1",
    projectRoot: "C:\\Project",
  }, {
    chatId: 123,
    messageId: 2,
    provider: "codex",
    threadId: "thread-2",
    projectRoot: "C:\\Project",
  }]);
  assert.equal(
    await removeMessageBindings(directory, (item) => item.threadId === "thread-1"),
    1,
  );
  assert.deepEqual((await readMessageBindings(directory)).map((item) => item.messageId), [2]);
});

test("parallel append operations never overwrite unrelated bindings", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-bindings-parallel-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 40 }, (_, index) => appendMessageBindings(directory, [{
    chatId: 123,
    messageId: index + 1,
    provider: index % 2 ? "claude" : "codex",
    threadId: `thread-${index + 1}`,
    projectRoot: "C:\\Project",
    createdAt: new Date(Date.now() + index).toISOString(),
  }])));
  const bindings = await readMessageBindings(directory);
  assert.equal(bindings.length, 40);
  assert.deepEqual(bindings.map((item) => item.messageId).sort((a, b) => a - b),
    Array.from({ length: 40 }, (_, index) => index + 1));
});

test("append-only events overlay and can remove legacy JSON bindings", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-bindings-legacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = {
    chatId: 5,
    messageId: 6,
    provider: "codex",
    threadId: "legacy",
    projectRoot: "C:\\Project",
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(directory, "telegram-thread-bindings.json"), JSON.stringify([legacy]), "utf8");
  await appendMessageBindings(directory, [{ ...legacy, threadId: "updated" }]);
  assert.equal((await findMessageBinding(directory, 5, 6)).threadId, "updated");
  assert.equal(await removeMessageBindings(directory, (item) => item.messageId === 6), 1);
  assert.equal(await findMessageBinding(directory, 5, 6), null);
});

test("compaction preserves current bindings and safely removes processed events", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-bindings-compact-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 20 }, (_, index) => appendMessageBindings(directory, [{
    chatId: 42,
    messageId: index + 1,
    provider: "codex",
    threadId: `thread-${index + 1}`,
    projectRoot: "C:\\Project",
    createdAt: new Date(Date.now() + index).toISOString(),
  }])));
  await removeMessageBindings(directory, (item) => item.messageId === 3);
  assert.equal(await compactMessageBindings(directory), 21);
  assert.deepEqual(await readdir(path.join(directory, "telegram-thread-bindings.d")), []);
  const compacted = JSON.parse(await readFile(
    path.join(directory, "telegram-thread-bindings.json"),
    "utf8",
  ));
  assert.equal(compacted.length, 19);
  assert.equal(compacted.some((item) => item.messageId === 3), false);

  await Promise.all([
    compactMessageBindings(directory),
    appendMessageBindings(directory, [{
      chatId: 42,
      messageId: 99,
      provider: "claude",
      threadId: "thread-99",
      projectRoot: "C:\\Project",
    }]),
  ]);
  assert.ok(await findMessageBinding(directory, 42, 99));
});
