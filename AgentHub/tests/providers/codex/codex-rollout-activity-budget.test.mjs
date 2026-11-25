import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { constants, zstdCompressSync } from "node:zlib";

import {
  readCodexAdmissionActivity,
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

test("admission worker reads only the activity tail and retains exact active turn evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-activity-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rollout = path.join(root, "large.jsonl");
  const active = path.join(root, "active.jsonl");
  const empty = path.join(root, "empty.jsonl");
  const stamp = new Date().toISOString();
  const session = JSON.stringify({ timestamp: stamp, type: "session_meta", payload: { id: "fixture" } });
  const event = (type, extra = {}) => JSON.stringify({
    timestamp: stamp, type: "event_msg", payload: { type, turn_id: "active-exact-turn", ...extra },
  });
  const tail = [event("task_started"), event("user_message", { message: "fixture" })].join("\n") + "\n";
  const inert = JSON.stringify({ timestamp: stamp, type: "inert", payload: "x".repeat(8192) }) + "\n";
  await Promise.all([
    writeFile(rollout, session + "\n" + inert.repeat(2300) + tail),
    writeFile(active, session + "\n" + tail),
    writeFile(empty, ""),
  ]);
  const history = readCodexRolloutActivity(rollout);
  const [large, independent, unavailable] = await Promise.all([
    readCodexAdmissionActivity(rollout),
    readCodexAdmissionActivity(active),
    readCodexAdmissionActivity(empty),
  ]);
  const original = await history;
  assert.equal(unavailable.activity.sourceUnavailable, true);
  assert.deepEqual(large.activity.activeTurnIds, original.activeTurnIds);
  assert.deepEqual(large.activity.activeTurnIds, ["active-exact-turn"]);
  assert.equal(large.activity.running, true);
  assert.deepEqual(independent.activity.activeTurnIds, ["active-exact-turn"]);
  assert.ok(large.activity.scanBytes <= 16 * 1024 * 1024);
  assert.ok(Number.isFinite(large.timing.queueWaitMs));
  assert.ok(Number.isFinite(large.timing.readMs));
  await appendFile(rollout, event("task_complete") + "\n");
  assert.equal((await readCodexAdmissionActivity(rollout)).activity.running, false);
});

test("admission verifies the exact archive, rejects a truncated frame, and prefers the plain file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-archive-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rollout = path.join(root, "fixture.jsonl");
  const archive = rollout + ".zst";
  const header = JSON.stringify({ type: "session_meta", payload: { id: "fixture" } }) + "\n";
  const valid = zstdCompressSync(Buffer.from(header + '{}\n'.repeat(80_000)), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
  assert.equal((await readCodexAdmissionActivity(rollout, "fixture")).activity.sourceIssue, "missing");
  await writeFile(archive, valid);
  const [correct, wrong] = await Promise.all([
    readCodexAdmissionActivity(rollout, "fixture"), readCodexAdmissionActivity(rollout, "other"),
  ]);
  assert.equal(correct.activity.sourceKind, "compressed");
  assert.equal(correct.activity.scanBytes, valid.length);
  assert.equal(wrong.activity.sourceIssue, "thread-mismatch");
  assert.equal((await readCodexAdmissionActivity(archive, "fixture")).activity.scanBytes, 0);
  const skippable = Buffer.from("502a4d1803000000010203", "hex");
  const second = zstdCompressSync(Buffer.from('{"type":"event_msg"}\n'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
  const secondCorrupt = Buffer.from(second);
  secondCorrupt[secondCorrupt.length - 1] ^= 1;
  for (const [parts, issue] of [
    [[valid, second], undefined],
    [[skippable, valid, skippable], undefined],
    [[valid, secondCorrupt], "invalid"],
    [[valid, second.subarray(0, -1)], "invalid"],
  ]) {
    await writeFile(archive, Buffer.concat(parts));
    const observation = await readCodexAdmissionActivity(rollout, "fixture", performance.timeOrigin + performance.now() + 5_000);
    assert.equal(observation.activity.sourceIssue, issue);
    assert.equal(observation.activity.sourceUnavailable, issue ? true : undefined);
  }
  await writeFile(archive, valid.subarray(0, -1));
  assert.equal((await readCodexAdmissionActivity(rollout, "fixture")).activity.sourceIssue, "invalid");
  const changed = Buffer.from(valid);
  changed[changed.length - 1] ^= 1;
  await writeFile(archive, changed);
  assert.equal((await readCodexAdmissionActivity(rollout, "fixture")).activity.sourceIssue, "invalid");
  await writeFile(rollout, header);
  assert.equal((await readCodexAdmissionActivity(archive, "fixture")).activity.sourceKind, "plain");
  assert.deepEqual(await readFile(archive), changed);
});
