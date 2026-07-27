import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_AUDIT_SOURCE_KINDS,
  CODEX_SUBAGENT_SOURCE_KINDS,
  CODEX_TASK_SOURCE_KINDS,
  resolveCodexAccountingThread,
} from "./codex-subagent-accounting.mjs";

test("Codex terminal audit includes every public subagent source kind", () => {
  assert.deepEqual(CODEX_AUDIT_SOURCE_KINDS, [
    ...CODEX_TASK_SOURCE_KINDS,
    ...CODEX_SUBAGENT_SOURCE_KINDS,
  ]);
  assert.ok(CODEX_AUDIT_SOURCE_KINDS.includes("subAgentThreadSpawn"));
  assert.equal(new Set(CODEX_AUDIT_SOURCE_KINDS).size, CODEX_AUDIT_SOURCE_KINDS.length);
});

test("ordinary Codex threads account to themselves without an RPC read", async () => {
  let reads = 0;
  const root = { id: "root", parentThreadId: null };
  const result = await resolveCodexAccountingThread(root, {
    readThread: async () => {
      reads += 1;
      return null;
    },
  });
  assert.equal(reads, 0);
  assert.deepEqual(result, {
    thread: root,
    threadId: "root",
    parentThreadId: "",
    isSubagent: false,
    depth: 0,
  });
});

test("nested Codex subagents account to the root thread", async () => {
  const threads = new Map([
    ["child", { id: "child", parentThreadId: "middle" }],
    ["middle", { id: "middle", parentThreadId: "root" }],
    ["root", { id: "root", parentThreadId: null, name: "Root task" }],
  ]);
  const result = await resolveCodexAccountingThread(threads.get("child"), {
    readThread: async (id) => ({ thread: threads.get(id) }),
  });
  assert.equal(result.threadId, "root");
  assert.equal(result.thread.name, "Root task");
  assert.equal(result.parentThreadId, "middle");
  assert.equal(result.isSubagent, true);
  assert.equal(result.depth, 2);
});

test("Codex subagent parent cycles are rejected", async () => {
  const threads = new Map([
    ["child", { id: "child", parentThreadId: "parent" }],
    ["parent", { id: "parent", parentThreadId: "child" }],
  ]);
  await assert.rejects(
    resolveCodexAccountingThread(threads.get("child"), {
      readThread: async (id) => threads.get(id),
    }),
    /parent cycle/,
  );
});
