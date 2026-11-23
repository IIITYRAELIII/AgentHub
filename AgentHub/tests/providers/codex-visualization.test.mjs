import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexVisualizationInWorker } from "../../src/providers/codex/codex-rollout-activity-worker-client.mjs";

const threadId = "88888888-2222-4555-9555-aaaaaaaaaaaa";
const foreignThread = "88888888-2222-4555-9555-bbbbbbbbbbbb";
const turnId = "turn-visualization";
const itemId = "agent-visualization";
const at = "2026-11-22T19:13:14.000Z";
const html = "<button>Выбрать</button><script>document.body.dataset.loaded='yes'</script>";
const markerFor = (filename) => "\uE200visualize\uE202" + JSON.stringify({ path: filename }) + "\uE201";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-visualization-"));
  const attachmentDirectory = path.join(directory, "attachments");
  const ownDirectory = path.join(attachmentDirectory, "visualizations", threadId);
  const foreignDirectory = path.join(attachmentDirectory, "visualizations", foreignThread);
  const rollout = path.join(directory, "rollout.jsonl");
  await Promise.all([mkdir(ownDirectory, { recursive: true }), mkdir(foreignDirectory, { recursive: true })]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const read = async (marker, {
    creation, session = threadId, request = {}, content = marker, phase = "final_answer", atomic = true,
  } = {}) => {
    const row = (payload, timestamp = at) => ({ timestamp, type: "event_msg", payload });
    const records = [
      { timestamp: at, type: "session_meta", payload: { id: session } },
      row({ type: "task_started", turn_id: turnId }, "2026-11-22T19:13:00.000Z"),
      ...(creation ? [row({ type: "item_completed", thread_id: threadId, turn_id: turnId, item: {
        type: "FileChange", status: "completed", changes: { [creation]: { type: "add" } },
      } })] : []),
      row({ type: "item_completed", thread_id: threadId, turn_id: turnId, item: {
        type: "AgentMessage", id: itemId, phase, content: [{ type: "Text", text: content }],
      } }),
      row({ type: "task_complete", turn_id: turnId, last_agent_message: content }, "2026-11-22T19:14:00.000Z"),
    ];
    await writeFile(rollout, records.map(record => JSON.stringify(record)).join("\n") + (atomic ? "\n" : ""));
    return readCodexVisualizationInWorker(rollout, { attachmentDirectory, threadId, turnId, itemId,
      markerHash: createHash("sha256").update(marker).digest("hex"), ...request });
  };
  return { read, directory, attachmentDirectory, ownDirectory, foreignDirectory };
}

test("same Codex final can open its scoped HTML after a fresh read", async (t) => {
  const { read, ownDirectory } = await fixture(t);
  const filename = path.join(ownDirectory, "chart.html");
  const marker = markerFor(filename);
  assert.equal(await read(marker), null);
  await writeFile(filename, html);
  assert.equal(await read(marker), html);
  assert.equal(await read(marker, { request: { itemId: turnId + ":agent:final" } }), html);
  assert.equal(await read(marker, { request: { itemId: "other-message" } }), null);
  assert.equal(await read(marker, { request: { turnId: "other-turn" } }), null);
  assert.equal(await read(marker, { session: foreignThread }), null);
  assert.equal(await read(marker, { content: "\x60\x60\x60text\n" + marker + "\n\x60\x60\x60" }), null);
  assert.equal(await read(marker, { phase: "commentary" }), null);
  assert.equal(await read(marker, { atomic: false }), null);
  await writeFile(filename, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  assert.equal(await read(marker), null);
  await writeFile(filename, "<html><body>Not a fragment</body></html>");
  assert.equal(await read(marker), null);
});

test("direct legacy attachment needs exact creation and unchanged turn-local bytes", async (t) => {
  const { read, attachmentDirectory } = await fixture(t);
  const filename = path.join(attachmentDirectory, "legacy.html");
  const marker = markerFor(filename);
  await writeFile(filename, html);
  await utimes(filename, new Date(at), new Date(at));
  assert.equal(await read(marker), null);
  assert.equal(await read(marker, { creation: path.join(attachmentDirectory, "different.html") }), null);
  assert.equal(await read(marker, { creation: filename }), html);
  const later = new Date("2026-11-22T19:15:00.000Z");
  await utimes(filename, later, later);
  assert.equal(await read(marker, { creation: filename }), null);
});

test("visualization markers cannot select outside files or another thread's artifact", async (t) => {
  const { read, directory, ownDirectory, foreignDirectory } = await fixture(t);
  const outside = path.join(directory, "outside.html");
  const foreign = path.join(foreignDirectory, "foreign.html");
  await Promise.all([writeFile(outside, html), writeFile(foreign, html)]);
  assert.equal(await read(markerFor(outside), { creation: outside }), null);
  assert.equal(await read(markerFor(foreign), { creation: foreign }), null);
  assert.equal(await read(markerFor("https://example.invalid/data.html")), null);
  assert.equal(await read("\uE200visualize\uE202bad-json\uE201"), null);
  const alias = path.join(ownDirectory, "alias.html");
  await link(outside, alias);
  assert.equal(await read(markerFor(alias), { creation: alias }), null);
});
