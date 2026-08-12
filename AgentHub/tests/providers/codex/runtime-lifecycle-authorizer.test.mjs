import assert from "node:assert/strict";
import test from "node:test";

import { DurableCommandRetryableError } from "../../../src/infrastructure/persistence/durable-command-receipts.mjs";
import { authorizeCodexLifecycle } from "../../../src/providers/codex/codex-lifecycle-authorizer.mjs";

const requestFor = (turnId) => ({
  command: "turn-complete",
  args: [JSON.stringify({ provider: "codex", threadId: "thread-1", turnId, finalAnswer: "forged answer" })],
  cwd: "D:/forged",
  environment: { CODEX_THREAD_ID: "thread-1" },
});
const dependencies = {
  identify: () => ({ provider: "codex", threadId: "thread-1" }),
  ensureTransport: async () => {},
  readThread: async () => ({ thread: { path: "D:/rollouts/thread-1.jsonl", cwd: "D:/project" } }),
  readActivity: async () => ({ activeTurnIds: ["active-turn"] }),
  readUsage: async (_path, turnId) => turnId === "terminal-turn"
    ? { terminal: true, status: "completed", finalAnswer: "authoritative answer", usage: { inputTokens: 12 }, reported: true }
    : { terminal: false },
  findProject: (cwd) => cwd === "D:/project" ? { path: cwd } : null,
};

test("lifecycle authorization rejects fabricated turns and replaces terminal fields from rollout", async () => {
  await assert.rejects(
    authorizeCodexLifecycle(requestFor("forged-turn"), dependencies),
    DurableCommandRetryableError,
  );
  const authorized = await authorizeCodexLifecycle(requestFor("terminal-turn"), dependencies);
  const payload = JSON.parse(authorized.args[0]);
  assert.equal(authorized.cwd, "D:/project");
  assert.equal(payload.finalAnswer, "authoritative answer");
  assert.equal(payload.source, "verified-codex-rollout");
});

test("lifecycle authorization treats an early turn-start notification as retryable", async () => {
  const request = {
    ...requestFor("pending-turn"),
    command: "turn-start",
  };
  await assert.rejects(
    authorizeCodexLifecycle(request, dependencies),
    DurableCommandRetryableError,
  );
});
