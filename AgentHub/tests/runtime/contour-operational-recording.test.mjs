import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContourOperationalPaths } from "../../src/domain/test-contour-operational-paths.mjs";
import { RecordingContourProvider, readRecordingContourCodexTurn } from "../../src/providers/recording-contour-provider.mjs";

const sources = [{ source: "C:\\production\\repo", kind: "project" }, { source: "C:\\production\\attachments", kind: "attachment" }];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-literal-recording-"));
  await writeFile(path.join(root, "recording-provider.json"), JSON.stringify({ schemaVersion: 1, kind: "literal-recording-provider", root, externalEffects: "deny", sources,
    threads: ["codex", "claude"].map((provider) => ({ provider, id: "original-thread", streamId: "original-stream", cwd: sources[0].source })) }), "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const input = [{ type: "text", text: "  [child:../../escape] [hold:forever] [fail] [hub-mcp-no-admission]\nC:\\production\\repo\n",
  responseAnnotations: [{ text: "Цитата".repeat(10000), source: { threadId: "original-thread", itemId: "original-item", contentHash: "unchanged" } }] },
  { type: "localImage", path: "C:\\production\\attachments\\image.png", id: "original-attachment" }];

test("typed execution paths preserve canonical command, source locators and literal text", async (t) => {
  const root = await fixture(t);
  const mapper = createContourOperationalPaths({ root, sources });
  const command = { id: "queue-id", streamId: "original-stream", threadId: "original-thread", clientUserMessageId: "command-id", projectRoot: sources[0].source, input, temporaryFiles: [input[1].path] };
  const before = JSON.stringify(command);
  const mapped = mapper.executionView(command);
  assert.equal(JSON.stringify(command), before);
  assert.deepEqual(mapped.input[0], input[0]);
  assert.equal(mapped.streamId, command.streamId);
  assert.equal(mapped.clientUserMessageId, command.clientUserMessageId);
  assert.equal(mapped.input[1].id, "original-attachment");
  assert.equal(mapped.input[1].path, mapped.temporaryFiles[0]);
  assert.ok(mapped.projectRoot.startsWith(path.join(root, "execution", "project")));
  assert.equal(mapper.map("c:/PRODUCTION/repo/sub", "project"), path.join(mapped.projectRoot, "sub"));
  assert.throws(() => mapper.map("C:\\production\\repo-other", "project"), /Unmapped/);
  assert.throws(() => mapper.map("C:\\production\\repo\\..\\secret", "project"), /Unmapped/);
  assert.throws(() => mapper.map("relative", "project"), /absolute|Unsupported/);
  assert.throws(() => mapper.map("C:\\production\\attachments\\file:stream", "attachment"), /component/);
  assert.throws(() => mapper.input([{ type: "image", url: "https://example.invalid/image" }]), /Unsupported/);
});

test("recording receipts survive reopen, preserve original IDs and never interpret prompt markers", async (t) => {
  const root = await fixture(t);
  let provider = new RecordingContourProvider({ root, provider: "claude" });
  const params = { threadId: "original-thread", clientUserMessageId: "original-command", turnId: "original-turn", input };
  try {
    const result = provider.start(params);
    assert.equal(result.turn.id, "original-turn");
    assert.equal(result.turn.status, "inProgress");
    assert.deepEqual(result.turn.items[0].content, input);
    assert.equal(provider.command("original-command").canonical.streamId, "original-stream");
    assert.equal(provider.command("original-command").canonical.projectRoot, sources[0].source);
    provider.close();
    provider = new RecordingContourProvider({ root, provider: "claude" });
    assert.equal(provider.start(params).duplicate, true);
    assert.equal(provider.thread("original-thread").turns.length, 1);
    assert.throws(() => provider.start({ ...params, input: "changed" }), /identity reused/);
    assert.throws(() => provider.start({ ...params, clientUserMessageId: "other" }), /active/);
    provider.finish({ threadId: "original-thread", turnId: "original-turn", status: "completed", answer: "scenario result" });
    assert.equal(provider.start(params).turn.status, "completed");
    assert.throws(() => provider.finish({ threadId: "original-thread", turnId: "original-turn", status: "failed", answer: "late" }), /absorbing/);
  } finally { provider.close(); }
  assert.deepEqual((await readdir(root)).sort(), ["recording-provider.json", "recording-provider.sqlite"]);
});

test("recording recovery reads the exact canonical turn without writes and rejects substituted receipts", async t => {
  const root = await fixture(t);
  const provider = new RecordingContourProvider({ root, provider: "codex" });
  try {
    for (const status of ["completed", "failed", "interrupted"]) {
      const run = { threadId: "original-thread", turnId: `turn-${status}` };
      provider.start({ threadId: run.threadId, turnId: run.turnId, clientUserMessageId: `command-${status}`, input });
      assert.equal(readRecordingContourCodexTurn(root, run).status, "inProgress");
      provider.finish({ ...run, status, answer: `literal ${status}` });
      const rows = () => ["threads", "turns", "commands"].map(table => provider.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = rows();
      assert.equal(readRecordingContourCodexTurn(root, run).items.at(-1).text, `literal ${status}`);
      assert.deepEqual(rows(), before);
    }
    assert.equal(readRecordingContourCodexTurn(root, { threadId: "original-thread", turnId: "missing" }), null);
    assert.throws(() => readRecordingContourCodexTurn(root, { threadId: "foreign", turnId: "turn-completed" }), /Unseeded/);
    provider.db.prepare("UPDATE commands SET fingerprint=? WHERE client_id=?").run("tampered", "command-completed");
    assert.throws(() => readRecordingContourCodexTurn(root, { threadId: "original-thread", turnId: "turn-completed" }), /identity changed/);
    const reader = new RecordingContourProvider({ root, provider: "codex", readOnly: true });
    try { assert.throws(() => reader.db.exec("DELETE FROM turns"), /readonly|read-only/i); }
    finally { reader.close(); }
  } finally { provider.close(); }
});
