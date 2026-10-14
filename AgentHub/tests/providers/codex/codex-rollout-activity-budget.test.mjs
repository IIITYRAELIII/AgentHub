import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseCodexRolloutActivity,
  readCodexRolloutActivity,
} from "../../../src/providers/codex/codex-rollout-activity.mjs";

const turnId = "long-turn";
const analysisText = "x".repeat(1_000);

function line(index) {
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 8, 29, 0, 0, 0, index)).toISOString(),
    type: "response_item",
    payload: {
      id: `analysis-${index}`,
      type: "message",
      role: "assistant",
      phase: "analysis",
      content: [{ type: "output_text", text: analysisText }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });
}

function lines(from, to) {
  return Array.from({ length: to - from }, (_, offset) => line(from + offset)).join("\n") + "\n";
}

function assertBounded(activity, expectedUnboundedGroups) {
  const groups = activity.activityGroups[turnId];
  assert.ok(groups.length <= 256, `retained ${groups.length} activity groups`);
  assert.ok(Buffer.byteLength(JSON.stringify(groups), "utf8") <= 512 * 1024);
  if (expectedUnboundedGroups <= 256) {
    assert.equal(groups.length, expectedUnboundedGroups);
    assert.equal(groups[0]?.omittedGroupsBefore, undefined);
  } else {
    assert.equal(groups[0].omittedGroupsBefore, expectedUnboundedGroups - groups.length);
    assert.equal(groups.at(-1).id, `commentary:analysis-${expectedUnboundedGroups - 1}`);
  }
}

test("Codex rollout activity bounds long-turn projection without changing its source", async (context) => {
  for (const count of [100, 1_000, 5_000]) {
    assertBounded(parseCodexRolloutActivity(lines(0, count)), count);
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-budget-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rollout = path.join(root, "rollout.jsonl");
  const session = `${JSON.stringify({ type: "session_meta", payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } })}\n`;
  const first = lines(0, 100);
  const second = lines(100, 1_000);
  const third = lines(1_000, 5_000);
  const completeSource = session + first + second + third;

  await writeFile(rollout, session + first, "utf8");
  assertBounded(await readCodexRolloutActivity(rollout, {
    freshnessMs: Number.POSITIVE_INFINITY,
    pinCache: true,
  }), 100);
  await appendFile(rollout, second, "utf8");
  assertBounded(await readCodexRolloutActivity(rollout, {
    freshnessMs: Number.POSITIVE_INFINITY,
    pinCache: true,
  }), 1_000);
  await appendFile(rollout, third, "utf8");
  assertBounded(await readCodexRolloutActivity(rollout, {
    freshnessMs: Number.POSITIVE_INFINITY,
    pinCache: true,
  }), 5_000);

  assert.equal(await readFile(rollout, "utf8"), completeSource);
});

test("Codex rollout activity bounds one oversized reasoning and tool group", () => {
  const scoped = (payload) => JSON.stringify({
    type: "response_item",
    payload: {
      ...payload,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });
  const source = [
    scoped({
      id: "reasoning-large",
      type: "message",
      role: "assistant",
      phase: "analysis",
      content: [{ type: "output_text", text: "r".repeat(100_000) }],
    }),
    ...Array.from({ length: 1_000 }, (_, index) => scoped({
      id: `tool-${index}`,
      type: "custom_tool_call",
      name: "exec",
      status: "completed",
    })),
  ].join("\n");

  const activity = parseCodexRolloutActivity(source);
  const [group] = activity.activityGroups[turnId];
  assert.equal(group.reasoning.length, 100_000);
  assert.equal(group.activities.length, 128);
  assert.equal(group.omittedActivities, 872);
  assert.ok(Buffer.byteLength(JSON.stringify(group), "utf8") <= 512 * 1024);
});
