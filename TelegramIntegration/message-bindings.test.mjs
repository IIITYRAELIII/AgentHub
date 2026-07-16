import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendMessageBindings, findMessageBinding, readMessageBindings } from "./message-bindings.mjs";

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
