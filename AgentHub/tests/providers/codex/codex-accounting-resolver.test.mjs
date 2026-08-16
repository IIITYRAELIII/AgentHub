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
