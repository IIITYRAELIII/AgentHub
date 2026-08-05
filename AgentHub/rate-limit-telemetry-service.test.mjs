import assert from "node:assert/strict";
import test from "node:test";

import { RateLimitTelemetryService } from "./src/application/rate-limit-telemetry-service.mjs";
import { parseClaudeLimits } from "./src/providers/claude/claude.mjs";
import {
  formatClaudeRateLimits,
  formatCodexRateLimits,
} from "./src/interfaces/telegram/status.mjs";

function fixture({
  codexRunning = true,
  claudeOutput = "Current session: 10% used · resets Aug 5, 5:00pm (Asia/Yekaterinburg)",
} = {}) {
  const events = [];
  let releaseCodex;
  let delayCodex = false;
  const delayedCodex = new Promise((resolve) => { releaseCodex = resolve; });
  const service = new RateLimitTelemetryService({
    resolveClaudeInvocation: () => ({ command: "claude", prefixArgs: ["--flag"] }),
    parseClaudeLimits,
    formatClaudeRateLimits,
    formatCodexRateLimits,
    spawnCapture: async (command, args, options) => {
      events.push(["spawn", command, args, options]);
      return { code: 0, stdout: claudeOutput, stderr: "", error: null };
    },
    readCodexRateLimits: async () => {
      events.push(["read-codex"]);
      if (delayCodex) return delayedCodex;
      return { rateLimits: { primary: { usedPercent: 25 } } };
    },
    codexRunning: () => codexRunning,
    historyStore: {
      record: async (...args) => events.push(["record", ...args]),
    },
    workLogUsageStore: {
      projectRateLimits: async (...args) => events.push(["project", ...args]),
    },
    timers: { schedule: (...args) => events.push(["schedule", ...args.slice(0, 1)]) },
    isStopping: () => false,
    nowIso: () => "2026-08-05T00:00:00.000Z",
    logger: { error: (...args) => events.push(["error", ...args]) },
  });
  return {
    service,
    events,
    delayCodex: () => { delayCodex = true; },
    releaseCodex,
  };
}

test("RateLimitTelemetryService probes Claude without sessions, tools or prompts", async () => {
  const state = fixture();
  await state.service.readClaude();
  const spawn = state.events.find(([name]) => name === "spawn");
  assert.equal(spawn[1], "claude");
  assert.deepEqual(spawn[2], [
    "--flag",
    "--safe-mode", "--no-session-persistence",
    "--print", "--output-format", "text", "--permission-mode", "dontAsk", "/usage",
  ]);
  assert.deepEqual(spawn[3], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
});

test("RateLimitTelemetryService records Codex and Claude snapshots in one cycle", async () => {
  const state = fixture();
  await state.service.poll();

  const records = state.events.filter(([name]) => name === "record");
  assert.equal(records.length, 2);
  assert.equal(records.every((record) => record[2] === "2026-08-05T00:00:00.000Z"), true);
  assert.equal(records.some((record) => record[3] === "claude"), true);
  assert.equal(state.events.filter(([name]) => name === "project").length, 1);
  assert.equal(state.events.at(-1)[0], "schedule");
});

test("RateLimitTelemetryService skips Codex when its transport is down", async () => {
  const state = fixture({ codexRunning: false });
  await state.service.poll();

  assert.equal(state.events.some(([name]) => name === "read-codex"), false);
  assert.equal(state.events.filter(([name]) => name === "record").length, 1);
});

test("RateLimitTelemetryService coalesces concurrent polling", async () => {
  const state = fixture();
  state.delayCodex();
  const first = state.service.poll();
  const second = state.service.poll();
  assert.equal(first, second);
  assert.equal(state.events.filter(([name]) => name === "read-codex").length, 1);
  state.releaseCodex({ rateLimits: { primary: { usedPercent: 30 } } });
  await first;
  assert.equal(state.events.filter(([name]) => name === "schedule").length, 1);
});

test("RateLimitTelemetryService returns a bounded Claude failure", async () => {
  const state = fixture();
  state.service.spawnCapture = async () => ({
    code: 2,
    stdout: "",
    stderr: "authorization required",
    error: null,
  });
  await assert.rejects(state.service.readClaude(), /authorization required/u);
});
