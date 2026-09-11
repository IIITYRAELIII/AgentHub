import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeTurnLauncher } from "../../src/providers/claude/claude-turn-launcher.mjs";
import { RecordingContourProvider } from "../../src/providers/recording-contour-provider.mjs";
import { claudeStreamInputMessage } from "../../src/providers/claude/claude.mjs";

test("Claude launcher binds exact command identity before literal CLI and isolates cleanup files", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-recording-claude-"));
  await writeFile(path.join(root, "recording-provider.json"), JSON.stringify({ schemaVersion: 1, kind: "literal-recording-provider", root, externalEffects: "deny",
    sources: [{ source: "C:\\prod\\repo", kind: "project" }, { source: "C:\\prod\\attachments", kind: "attachment" }], threads: [{ provider: "claude", id: "thread-original", streamId: "stream-original", cwd: "C:\\prod\\repo" }] }));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    await rm(root, { recursive: true, force: true });
  });
  const run = { id: "original-run", provider: "claude", streamId: "stream-original", threadId: "thread-original", clientUserMessageId: "command-original", projectRoot: "C:\\prod\\repo" };
  const temporaryFiles = ["C:\\prod\\attachments\\image.png"];
  const input = [{ type: "text", text: " [child:../../escape] [hold:forever] [fail] ", responseAnnotations: [{ text: "Цитата".repeat(1000), source: { threadId: "thread-original" } }] }, { type: "localImage", path: temporaryFiles[0] }];
  const registry = new Map();
  let persisted = false;
  const launcher = new ClaudeTurnLauncher({ recordingContourRoot: root, taskRuns: { reindex() {} }, turnTemporaryFiles: registry,
    taskSnapshots: { read() { throw new Error("must not read original sessions"); } },
    resolveInvocation() { throw new Error("must not resolve installed Claude"); },
    persistHistory: async () => { persisted = true; },
    runController: { start: async (boundRun, invocation) => {
      assert.equal(persisted, true);
      assert.equal(boundRun, run);
      assert.equal(run.projectRoot, "C:\\prod\\repo");
      assert.notEqual(invocation.cwd, run.projectRoot);
      assert.equal(invocation.env.ANTHROPIC_API_KEY, undefined);
      assert.ok(registry.get(run.turnId)[0].startsWith(root));
      child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const exited = once(child, "exit");
      const lines = createInterface({ input: child.stdout });
      const events = [];
      lines.on("line", (line) => {
        const event = JSON.parse(line); events.push(event);
        if (event.type === "system") child.stdin.write(`${JSON.stringify({ type: "contour-finish", clientUserMessageId: run.clientUserMessageId, status: "completed", answer: "scenario answer" })}\n`);
      });
      child.stdin.write(`${claudeStreamInputMessage(invocation.input)}\n`);
      const [code] = await exited;
      assert.equal(code, 0);
      assert.equal(events.at(-1)?.result, "scenario answer");
      assert.ok(events.every((event) => event.session_id === "thread-original"));
    } },
  });
  await launcher.start(run, input, temporaryFiles);
  const provider = new RecordingContourProvider({ root, provider: "claude" });
  try {
    const recorded = provider.command("command-original");
    assert.equal(recorded.turnId, run.turnId);
    assert.deepEqual(recorded.canonical.input, input);
    assert.equal(recorded.canonical.streamId, "stream-original");
    assert.equal(provider.thread("thread-original").turns[0].status, "completed");
  } finally { provider.close(); }
});
