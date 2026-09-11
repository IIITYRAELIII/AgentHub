import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerTransport } from "../../src/providers/codex/codex-app-server-transport.mjs";

test("actual Codex transport runs literal recording CLI and recovers the same receipt after process restart", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-recording-rpc-"));
  const file = fileURLToPath(new URL("../../src/providers/recording-contour-codex-cli.mjs", import.meta.url));
  await writeFile(path.join(root, "recording-provider.json"), JSON.stringify({ schemaVersion: 1, kind: "literal-recording-provider", root, externalEffects: "deny",
    sources: [{ source: "C:\\prod\\repo", kind: "project" }], threads: [{ provider: "codex", id: "thread-original", streamId: "stream-original", cwd: "C:\\prod\\repo" }] }));
  const children = [];
  const events = [];
  let terminalObserved;
  const terminal = new Promise((resolve) => { terminalObserved = resolve; });
  const transport = new CodexAppServerTransport({
    spawnProcess: (args) => {
      const child = spawn(process.execPath, [file, "--recording-root", root, ...args], { cwd: root, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RECORDING_PROVIDER_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    }, rpcTimeoutMs: 1000, onMessage: (message) => { events.push(message); if (message.method === "turn/completed") terminalObserved(); }, onExit: () => {}, onStderr: () => {},
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
