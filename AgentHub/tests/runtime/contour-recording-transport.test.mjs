import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CodexAppServerTransport } from "../../src/providers/codex/codex-app-server-transport.mjs";
import { RecordingContourProvider } from "../../src/providers/recording-contour-provider.mjs";

test("actual Codex transport runs literal recording CLI and recovers the same receipt after process restart", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-recording-rpc-"));
  const file = fileURLToPath(new URL("../../src/providers/recording-contour-codex-cli.mjs", import.meta.url));
  await writeFile(path.join(root, "recording-provider.json"), JSON.stringify({ schemaVersion: 1, kind: "literal-recording-provider", root, externalEffects: "deny",
    sources: [{ source: "C:\\prod\\repo", kind: "project" }], threads: [{ provider: "codex", id: "thread-original", streamId: "stream-original", cwd: "C:\\prod\\repo" }] }));
  const children = [];
  const events = [];
  let terminalObserved;
  const terminal = new Promise((resolve) => { terminalObserved = resolve; });
  let startedObserved;
  const started = new Promise((resolve) => { startedObserved = resolve; });
  const transport = new CodexAppServerTransport({
    spawnProcess: (args) => {
      const child = spawn(process.execPath, [file, "--recording-root", root, ...args], { cwd: root, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RECORDING_PROVIDER_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    }, rpcTimeoutMs: 1000, onMessage: (message) => {
      events.push(message);
      if (message.method === "turn/completed") terminalObserved();
      if (message.method === "turn/started") startedObserved();
    }, onExit: () => {}, onStderr: () => {},
  });
  async function stop() {
    const child = children.at(-1);
    const exited = child && child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve();
    await transport.stop();
    await exited;
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await transport.start();
  await transport.initialize();
  const input = [{ type: "text", text: " [child:../../escape] [hold:forever] [fail] [rollout-exact-pair] [hub-mcp-no-admission] ", responseAnnotations: [{ text: "Full quote", source: { itemId: "original-item" } }] }];
  const params = { threadId: "thread-original", clientUserMessageId: "command-original", input };
  const first = await transport.request("turn/start", params);
  assert.equal(first.turn.status, "inProgress");
  assert.deepEqual(first.turn.items[0].content, input);
  await started;
  await assert.rejects(transport.request("command/exec", { command: "ignored" }), /Unsupported/);
  await stop();
  await transport.start();
  await transport.initialize();
  const retry = await transport.request("turn/start", params);
  assert.equal(retry.turn.id, first.turn.id);
  const read = await transport.readThread("thread-original", { fresh: true });
  assert.equal(read.thread.turns.length, 1);
  assert.equal(read.thread.turns[0].clientUserMessageId, "command-original");
  const finished = await transport.request("contour/finish", { threadId: "thread-original", turnId: first.turn.id, status: "completed", answer: "Explicit scenario result" });
  assert.equal(finished.turn.status, "completed");
  await terminal;
  assert.equal(events.filter((event) => event.method === "turn/started").length, 1);
  assert.equal(events.filter((event) => event.method === "turn/completed").length, 1);
  assert.ok(events.every((event) => ["turn/started", "turn/completed", "item/completed"].includes(event.method)));
});

test("thread/name/set records only provider-scoped literal metadata and survives transport restart", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-recording-name-"));
  const cli = fileURLToPath(new URL("../../src/providers/recording-contour-codex-cli.mjs", import.meta.url));
  const markerFile = path.join(root, "recording-provider.json");
  const threads = ["codex", "claude"].map((provider) => ({ provider, id: "canonical-thread", streamId: "canonical-stream", cwd: "C:\\prod\\repo", name: "Original seed name" }));
  await writeFile(markerFile, JSON.stringify({ schemaVersion: 1, kind: "literal-recording-provider", root, externalEffects: "deny",
    sources: [{ source: "C:\\prod\\repo", kind: "project" }], threads }));
  const originalMarker = await readFile(markerFile);
  const events = [];
  let child;
  const transport = new CodexAppServerTransport({
    spawnProcess: (args) => {
      child = spawn(process.execPath, [cli, "--recording-root", root, ...args], { cwd: root, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RECORDING_PROVIDER_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
      return child;
    }, rpcTimeoutMs: 1000, onMessage: (event) => events.push(event), onExit: () => {}, onStderr: () => {},
  });
  const stop = async () => {
    const exited = child && child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve();
    await transport.stop(); await exited;
  };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await transport.start(); await transport.initialize();
  const readThread = async () => (await transport.request("thread/read", { threadId: "canonical-thread", includeTurns: true })).thread;
  const initial = await readThread();
  const name = "Agent HUB — Sirius [hold:forever] __E2E_EXTERNAL_HOLD__";
  const params = { threadId: "canonical-thread", name };
  assert.deepEqual(await transport.request("thread/name/set", params), {});
  assert.deepEqual(await transport.request("thread/name/set", params), {});
  const expected = { ...initial, name };
  assert.deepEqual(await readThread(), expected);
  assert.deepEqual((await transport.request("thread/list", {})).data, [expected]);
  await assert.rejects(transport.request("thread/name/set", { threadId: "unseeded", name }), /Unseeded Thread/);
  for (const invalid of [null, 42, "", "  ", "bad\0name"]) await assert.rejects(transport.request("thread/name/set", { threadId: "canonical-thread", name: invalid }), /literal Thread name/);
  await assert.rejects(transport.request("thread/name/set", { name }), /thread ID is required/);
  await assert.rejects(transport.request("thread/archive", { threadId: "canonical-thread" }), /Unsupported recording operation/);
  await stop();
  await transport.start(); await transport.initialize();
  assert.deepEqual(await readThread(), expected);
  await transport.request("thread/name/set", params);
  await transport.request("thread/name/set", { ...params, name: "Second literal name" });
  assert.equal((await readThread()).name, "Second literal name");
  await stop();
  const claude = new RecordingContourProvider({ root, provider: "claude" });
  try { assert.equal(claude.thread("canonical-thread").name, "Original seed name"); } finally { claude.close(); }
  const db = new DatabaseSync(path.join(root, "recording-provider.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT value_json FROM threads ORDER BY provider DESC").all().map((row) => JSON.parse(row.value_json)), threads);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM thread_names").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM commands").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM turns").get().n, 0);
  } finally { db.close(); }
  assert.deepEqual(await readFile(markerFile), originalMarker);
  assert.deepEqual(events, []);
});
