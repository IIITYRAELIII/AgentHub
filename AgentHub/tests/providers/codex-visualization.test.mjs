import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexVisualizationInWorker } from "../../src/providers/codex/codex-rollout-activity-worker-client.mjs";
import { prepareCodexVisualizationDirectory } from "../../src/providers/codex/codex-visualization.mjs";
import { CodexTurnService } from "../../src/providers/provider-turn-services.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";

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

test("ordinary workspace-write turn produces an artifact in its advertised root and durable history opens it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-visualization-turn-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project");
  const attachmentDirectory = path.join(directory, "attachments");
  await mkdir(projectRoot);
  const newThreadRoot = path.join(attachmentDirectory, "visualizations", threadId);
  const run = { id: "viz-real-launch", provider: "codex", streamId: "stream-visualization", threadId,
    projectRoot, modelId: "gpt-5.6-codex", reasoningId: "medium", collaborationMode: "default" };
  let answer;
  let received;
  const noop = async () => {};
  const service = new CodexTurnService({
    sandboxMode: () => "workspace-write",
    prepareVisualizationDirectory: (id) => prepareCodexVisualizationDirectory(attachmentDirectory, id),
    developerInstructions: async () => "Existing work context",
    sendRpc: async (method, params) => {
      assert.equal(method, "turn/start");
      received = params;
      const [project, writableOutput] = params.sandboxPolicy.writableRoots;
      assert.equal(params.sandboxPolicy.type, "workspaceWrite");
      assert.equal(project, projectRoot);
      assert.equal(writableOutput, newThreadRoot);
      assert.equal(params.sandboxPolicy.writableRoots.length, 2);
      assert.ok(params.additionalContext["agent-hub"].value.includes(JSON.stringify(writableOutput)));
      const file = path.join(writableOutput, "fresh.html");
      await writeFile(file, html, { flag: "wx" });
      answer = markerFor(file);
      return { turn: { id: turnId } };
    },
    compactionRecycle: () => null, resolvedSkillNames: async () => ["visualize"],
    reindexRun: noop, saveState: noop, startTyping: noop, scheduleObservedRun: noop,
    finishProgress: noop, completeRun: noop,
    readThread: async () => ({ thread: { turns: [{ id: turnId, items: [{ type: "userMessage" }] }] } }),
    speechButtons: new Map(), temporaryFiles: new Map(), turnTokenUsage: new Map(),
  });
  await service.launch(run, "Use visualize");
  assert.equal(run.turnId, turnId);
  assert.ok(received);
  const filePath = path.join(directory, "tasks.json");
  const rollout = path.join(directory, "fresh.jsonl");
  const made = (payload) => JSON.stringify({ timestamp: at, type: "event_msg", payload });
  await writeFile(rollout, [
    JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
    made({ type: "task_started", turn_id: turnId }),
    made({ type: "item_completed", turn_id: turnId, thread_id: threadId,
      item: { type: "AgentMessage", id: itemId, phase: "final_answer", content: [{ text: answer }] } }),
    made({ type: "task_complete", turn_id: turnId, last_agent_message: answer }),
  ].join("\n") + "\n");
  let store = new LocalTaskSyncStore({ filePath });
  try {
    await store.load();
    await store.recordHistory(run, [{ id: turnId, completed: true, completedAt: at,
      messages: [{ role: "agent", itemId, phase: "final_answer", text: answer }] }]);
    store.close();
    store = new LocalTaskSyncStore({ filePath });
    await store.load();
    const retained = store.historyTurn(run).messages.at(-1);
    assert.equal(retained.text, answer);
    const markerHash = createHash("sha256").update(retained.text).digest("hex");
    assert.equal(await readCodexVisualizationInWorker(rollout, { attachmentDirectory, threadId,
      turnId, itemId: retained.itemId, markerHash }), html);
    await symlink(newThreadRoot, path.join(attachmentDirectory, "visualizations", foreignThread),
      process.platform === "win32" ? "junction" : "dir");
    assert.equal(await prepareCodexVisualizationDirectory(attachmentDirectory, foreignThread), "");
  } finally {
    store.close();
  }
});
