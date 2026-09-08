import assert from "node:assert/strict";
import test from "node:test";

import { CodexAccountingResolver } from "../../../src/providers/codex/codex-accounting-resolver.mjs";

test("Codex accounting resolver follows a subagent to its durable root", async () => {
  const root = { id: "root", parentThreadId: null, name: "Root" };
  const resolver = new CodexAccountingResolver({
    readThread: async (id) => ({ thread: id === "root" ? root : null }),
    findRollout: async () => "",
    readRolloutSession: async () => null,
    readSubagentSpawn: async () => null,
    scanHistoricalRollout: async () => null,
  });

  const result = await resolver.accountingThread({ id: "child", parentThreadId: "root" });
  assert.equal(result.threadId, "root");
  assert.equal(result.isSubagent, true);
});

test("Codex accounting resolver recovers a parent turn from historical rollout", async () => {
  let scans = 0;
  const resolver = new CodexAccountingResolver({
    readThread: async () => null,
    findRollout: async () => "parent.jsonl",
    readRolloutSession: async () => null,
    readSubagentSpawn: async () => null,
    scanHistoricalRollout: async () => {
      scans += 1;
      return ({
      turns: [{ turnId: "turn-parent", spawnedSubagents: [{ threadId: "child" }] }],
      });
    },
  });

  assert.equal(await resolver.subagentParentTurnId(
    { id: "child" },
    { parentThreadId: "parent" },
  ), "turn-parent");
  assert.equal(await resolver.subagentParentTurnId(
    { id: "child" },
    { parentThreadId: "parent" },
  ), "turn-parent");
  assert.equal(scans, 1);
});

test("Codex accounting resolver local-only mode never attempts App Server RPC", async () => {
  let providerReads = 0;
  const root = { id: "root", parentThreadId: null, name: "Root" };
  const resolver = new CodexAccountingResolver({
    readThread: async () => {
      providerReads += 1;
      return new Promise(() => {});
    },
    findRollout: async (id) => id === root.id ? "root.jsonl" : "",
    readRolloutSession: async () => root,
    readSubagentSpawn: async () => null,
    scanHistoricalRollout: async () => null,
  });

  const result = await Promise.race([
    resolver.accountingThread(
      { id: "child", parentThreadId: root.id },
      { localOnly: true },
    ),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("local-only accounting waited for provider RPC")),
      100,
    )),
  ]);

  assert.equal(providerReads, 0);
  assert.equal(result.threadId, root.id);
  assert.equal(result.isSubagent, true);
});
