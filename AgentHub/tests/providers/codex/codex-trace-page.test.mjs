import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCodexTracePageInWorker } from "../../../src/providers/codex/codex-rollout-activity-worker-client.mjs";
import { readCodexRolloutActivity } from "../../../src/providers/codex/codex-rollout-activity.mjs";

const turnId = "turn-details";
const meta = { type: "session_meta", payload: { id: "01a0ea85-db2c-7bd3-bfad-2634824c6069" } };
const row = (index, text = `block-${index}`) => ({ type: "response_item", payload: {
  type: "message", id: `analysis-${index}`, role: "assistant", phase: "analysis",
  content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId },
} });
const jsonl = rows => `${rows.map(value => JSON.stringify(value)).join("\n")}\n`;

test("worker preview stays bounded; explicit pages recover every exact block without rewriting rollout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub239-trace-"));
  const file = path.join(directory, "rollout.jsonl");
  const source = jsonl([meta, ...Array.from({ length: 600 }, (_, i) => row(i, i === 0 ? `start-${"Ж".repeat(50_000)}` : undefined))]);
  try {
    await writeFile(file, source);
    const preview = await readCodexRolloutActivity(file);
    assert.equal(preview.activityGroups[turnId].length, 256);
    let page = await readCodexTracePageInWorker(file, { turnId });
    const all = [...page.groups];
    const first = page;
    await appendFile(file, jsonl([row(600)]));
    while (page.nextOffset !== null) {
      page = await readCodexTracePageInWorker(file, { ...first, groups: undefined, turnId, offset: page.nextOffset });
      assert.ok(page.groups.length <= 50);
      all.push(...page.groups);
    }
    assert.equal(all.length, 600);
    assert.equal(all[0].reasoning, `start-${"Ж".repeat(50_000)}`);
    assert.equal(all.at(-1).id, "commentary:analysis-599");
    const exact = await readCodexTracePageInWorker(file, { turnId, groupId: "commentary:analysis-0" });
    assert.deepEqual(exact.groups, [all[0]]);
    assert.equal(await readFile(file, "utf8"), source + jsonl([row(600)]));
    await writeFile(file, source.replace("block-1", "other-1") + jsonl([row(600)]));
    await assert.rejects(readCodexTracePageInWorker(file, { ...first, groups: undefined, offset: 50 }), /prefix changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("trace lookup rejects duplicate identities, foreign turns and oversized blocks explicitly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub239-trace-"));
  const file = path.join(directory, "rollout.jsonl");
  try {
    await writeFile(file, jsonl([meta, row(1), row(1)]));
    await assert.rejects(readCodexTracePageInWorker(file, { turnId, groupId: "commentary:analysis-1" }), /ambiguous/);
    assert.deepEqual((await readCodexTracePageInWorker(file, { turnId: "foreign" })).groups, []);
    await writeFile(file, jsonl([meta, row(1, "x".repeat(600_000))]));
    await assert.rejects(readCodexTracePageInWorker(file, { turnId }), /transport budget/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
