import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function lifecycleApi() {
  const source = await readFile(
    new URL("../../assets/web-app/messages/lifecycle.js", import.meta.url),
    "utf8",
  );
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  return context.globalThis.AgentHubMessageLifecycle;
}

test("conversation task identity prefers explicit Stream over provider Thread", async () => {
  const { conversationTaskId } = await lifecycleApi();
  const id = conversationTaskId(
    { provider: "codex", threadId: "thread-shared", streamId: "stream-current" },
    [
      { provider: "codex", threadId: "thread-shared", streamId: "stream-old" },
      { provider: "codex", threadId: "thread-shared", streamId: "stream-current" },
    ],
  );
  assert.equal(id, "stream-current");
});

test("conversation task identity infers Stream only from an unambiguous match", async () => {
  const { conversationTaskId } = await lifecycleApi();
  const id = conversationTaskId(
    { provider: "claude", threadId: "thread-1" },
    [
      { provider: "codex", threadId: "thread-1", streamId: "stream-codex" },
      { provider: "claude", threadId: "thread-1", streamId: "stream-claude" },
    ],
  );
  assert.equal(id, "stream-claude");
});

test("conversation task identity does not guess when provider Thread is ambiguous", async () => {
  const { conversationTaskId } = await lifecycleApi();
  const id = conversationTaskId(
    { provider: "codex", threadId: "thread-shared" },
    [
      { provider: "codex", threadId: "thread-shared", streamId: "stream-dialogs" },
      { provider: "codex", threadId: "thread-shared", streamId: "stream-security" },
    ],
  );
  assert.equal(id, "codex:thread-shared");
});
