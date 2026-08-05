import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_AUDIT_SOURCE_KINDS,
  CODEX_SUBAGENT_SOURCE_KINDS,
  CODEX_TASK_SOURCE_KINDS,
  isInheritedSubagentTurn,
  resolveCodexAccountingThread,
  uuidV7TimestampMs,
} from "./src/providers/codex/codex-subagent-accounting.mjs";

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

test("four custom model subagents account to one external parent", async () => {
  const root = {
    id: "external-root",
    parentThreadId: null,
    name: "Four-model hook test",
  };
  const children = ["sol", "terra", "luna", "spark"].map((model) => ({
    id: `external-${model}`,
    parentThreadId: root.id,
  }));

  const results = await Promise.all(children.map((child) => resolveCodexAccountingThread(child, {
    readThread: async (id) => ({ thread: id === root.id ? root : null }),
  })));

  assert.deepEqual(results.map((value) => ({
    threadId: value.threadId,
    taskName: value.thread.name,
    parentThreadId: value.parentThreadId,
    isSubagent: value.isSubagent,
    depth: value.depth,
  })), children.map(() => ({
    threadId: root.id,
    taskName: root.name,
    parentThreadId: root.id,
    isSubagent: true,
    depth: 1,
  })));
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

test("UUIDv7 timestamps distinguish inherited parent turns from a subagent's own turn", () => {
  const childThreadId = "019fa366-e7a9-7aa1-b38a-6823c3a67e77";
  const inheritedTurnId = "019fa362-ffaf-7cd3-9c8f-480d9724657a";
  const childTurnId = "019fa366-e87d-7933-8ae8-f33a5200b24e";

  assert.ok(uuidV7TimestampMs(inheritedTurnId) < uuidV7TimestampMs(childThreadId));
  assert.ok(uuidV7TimestampMs(childTurnId) >= uuidV7TimestampMs(childThreadId));
  assert.equal(isInheritedSubagentTurn({
    aggregateOnly: true,
    threadId: childThreadId,
    turnId: inheritedTurnId,
  }), true);
  assert.equal(isInheritedSubagentTurn({
    aggregateOnly: true,
    threadId: childThreadId,
    turnId: childTurnId,
  }), false);
  assert.equal(isInheritedSubagentTurn({
    aggregateOnly: false,
    threadId: childThreadId,
    turnId: inheritedTurnId,
  }), false);
});
