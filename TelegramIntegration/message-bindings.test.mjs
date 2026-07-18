import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendMessageBindings,
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
