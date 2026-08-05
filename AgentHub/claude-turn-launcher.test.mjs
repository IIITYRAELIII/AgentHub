import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ClaudeTurnLauncher } from "./src/providers/claude/claude-turn-launcher.mjs";

test("ClaudeTurnLauncher owns session setup and detached run invocation", async () => {
  const events = [];
  const temporaryFiles = new Map();
  const projectRoot = path.resolve("project");
  const run = {
    threadId: "11111111-1111-4111-8111-111111111111",
    projectRoot,
    collaborationMode: "default",
    modelId: "opus",
    reasoningId: "high",
  };
  const launcher = new ClaudeTurnLauncher({
    taskRuns: { reindex: (...args) => events.push(["reindex", ...args]) },
    turnTemporaryFiles: temporaryFiles,
    taskSnapshots: { read: async () => ({ sessionId: run.threadId, sessionRoot: projectRoot }) },
    permissionMode: "default",
    autoApprove: () => true,
    persistHistory: async () => events.push(["persist"]),
    resolveInvocation: () => ({ command: "claude", prefixArgs: ["--shim"] }),
    runController: { start: async (_run, options) => events.push(["start", options]) },
    logWarning: (...args) => events.push(["warning", ...args]),
  });

  await launcher.start(run, [{ type: "text", text: "Проверка" }], ["temporary.png"]);

  assert.match(run.turnId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(temporaryFiles.get(run.turnId), ["temporary.png"]);
  assert.equal(events[0][0], "reindex");
  assert.equal(events[1][0], "persist");
  assert.equal(events[2][1].command, "claude");
  assert.equal(events[2][1].args.includes("--resume"), true);
  assert.equal(events[2][1].env.MAX_THINKING_TOKENS, "8000");
});
