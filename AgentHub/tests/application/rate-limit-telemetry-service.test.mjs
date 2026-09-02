import assert from "node:assert/strict";
import test from "node:test";

import { RateLimitTelemetryService } from "../../src/application/rate-limit-telemetry-service.mjs";
import { parseClaudeLimits } from "../../src/providers/claude/claude.mjs";
import {
  formatClaudeRateLimits,
  formatCodexRateLimits,
} from "../../src/interfaces/telegram/status.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture({
  codexRunning = true,
  codexPollingEnabled = true,
  claudePollingEnabled = true,
  claudeOutput = "Current session: 10% used · resets Aug 5, 5:00pm (Asia/Yekaterinburg)",
} = {}) {
  const events = [];
  let nowMs = 1_000;
  const delayedAccount = deferred();
  const delayedCodex = deferred();
  let delayAccount = false;
  let delayCodex = false;
  const service = new RateLimitTelemetryService({
    resolveClaudeInvocation: () => ({ command: "claude", prefixArgs: ["--flag"] }),
    parseClaudeLimits,
    formatClaudeRateLimits,
    formatCodexRateLimits,
    spawnCapture: async (command, args, options) => {
      events.push(["spawn", command, args, options]);
      return { code: 0, stdout: claudeOutput, stderr: "", error: null };
    },
    readCodexAccount: async () => {
      events.push(["read-account"]);
      if (delayAccount) return delayedAccount.promise;
      return { account: { type: "chatgpt", email: "first@example.test", planType: "pro" } };
    },
    readClaudeAccount: async () => {
      events.push(["read-claude-account"]);
      return { key: "anthropic:account-1", label: "claude@example.test", type: "oauth", planType: "max" };
    },
    readCodexRateLimits: async () => {
      events.push(["read-codex"]);
      if (delayCodex) return delayedCodex.promise;
      return { rateLimits: { primary: { usedPercent: 25 } } };
    },
    codexRunning: () => codexRunning,
    codexPollingEnabled,
    claudePollingEnabled,
    historyStore: {
      record: async (...args) => events.push(["record", ...args]),
      read: async (...args) => {
        events.push(["read-history", ...args]);
        return { fresh: true };
      },
    },
    workLogUsageStore: {
      projectRateLimits: async (...args) => events.push(["project", ...args]),
    },
    timers: { schedule: (...args) => events.push(["schedule", ...args.slice(0, 1)]) },
    isStopping: () => false,
    clock: () => nowMs,
    nowIso: () => "2026-08-05T00:00:00.000Z",
    logger: { error: (...args) => events.push(["error", ...args]) },
  });
  return {
    service,
    events,
    delayAccount: () => { delayAccount = true; },
    delayCodex: () => { delayCodex = true; },
    releaseAccount: delayedAccount.resolve,
    rejectAccount: delayedAccount.reject,
    releaseCodex: delayedCodex.resolve,
    rejectCodex: delayedCodex.reject,
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
  assert.deepEqual(records.find((record) => record[3] === "claude")[4], {
    key: "anthropic:account-1",
    label: "claude@example.test",
    type: "oauth",
    planType: "max",
  });
  const codex = records.find((record) => record[3] === "codex");
  assert.deepEqual(codex[4], {
    account: { type: "chatgpt", email: "first@example.test", planType: "pro" },
  });
  assert.equal(state.events.filter(([name]) => name === "project").length, 1);
  assert.equal(state.events.at(-1)[0], "schedule");
});

test("RateLimitTelemetryService skips Codex when its transport is down", async () => {
  const state = fixture({ codexRunning: false });
  await state.service.poll();

  assert.equal(state.events.some(([name]) => name === "read-codex"), false);
  assert.equal(state.events.some(([name]) => name === "read-account"), false);
  assert.equal(state.events.filter(([name]) => name === "record").length, 1);
});

test("RateLimitTelemetryService disables background Codex polling", async () => {
  const state = fixture({ codexPollingEnabled: false, claudePollingEnabled: false });
  await state.service.poll();

  assert.equal(state.events.some(([name]) => name === "read-codex"), false);
  assert.equal(state.events.some(([name]) => name === "read-account"), false);
  assert.equal(state.events.some(([name]) => name === "schedule"), false);
  assert.equal(state.events.some(([name]) => name === "record"), false);
});

test("RateLimitTelemetryService skips background Claude polling when disabled", async () => {
  const state = fixture({ claudePollingEnabled: false });
  await state.service.poll();

  assert.equal(state.events.some(([name]) => name === "spawn"), false);
  assert.equal(state.events.filter(([name]) => name === "record").length, 1);
  assert.equal(state.events.some(([name]) => name === "error"), false);
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

test("RateLimitTelemetryService returns stored history while both Codex RPCs remain pending", async () => {
  const state = fixture();
  state.delayAccount();
  state.delayCodex();

  const firstHistory = state.service.history({ range: "24h" });
  const secondHistory = state.service.history({ range: "7d" });

  assert.equal(state.events.filter(([name]) => name === "read-history").length, 2);
  assert.deepEqual(await firstHistory, { fresh: true });
  assert.deepEqual(await secondHistory, { fresh: true });
  assert.equal(state.events.filter(([name]) => name === "read-account").length, 1);
  assert.equal(state.events.filter(([name]) => name === "read-codex").length, 1);

  const manualRefresh = state.service.refreshCodex();
  assert.equal(state.events.filter(([name]) => name === "read-account").length, 1);
  assert.equal(state.events.filter(([name]) => name === "read-codex").length, 1);
  state.releaseAccount({ account: { type: "chatgpt", email: "first@example.test", planType: "pro" } });
  state.releaseCodex({ rateLimits: { primary: { usedPercent: 30 } } });
  assert.deepEqual(await manualRefresh, { rateLimits: { primary: { usedPercent: 30 } } });
  assert.equal(state.events.filter(([name]) => name === "record").length, 1);
});

test("RateLimitTelemetryService keeps explicit refresh forceful after a fresh history sample", async () => {
  const state = fixture();
  assert.deepEqual(await state.service.refreshCodex(), {
    rateLimits: { primary: { usedPercent: 25 } },
  });

  assert.deepEqual(await state.service.history({ range: "24h" }), { fresh: true });
  assert.equal(state.events.filter(([name]) => name === "read-codex").length, 1);

  await state.service.refreshCodex();
  assert.equal(state.events.filter(([name]) => name === "read-codex").length, 2);
});

test("RateLimitTelemetryService handles a rejected background refresh and permits a manual retry", async () => {
  const state = fixture();
  state.delayCodex();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  try {
    assert.deepEqual(await state.service.history({ range: "7d" }), { fresh: true });
    assert.deepEqual(await state.service.history({ range: "24h" }), { fresh: true });
    assert.equal(state.events.filter(([name]) => name === "read-codex").length, 1);

    state.rejectCodex(new Error("offline"));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(state.events.filter((event) => (
      event[0] === "error" && event[1] === "Cannot refresh current Codex rate limits:"
    )).length, 1);

    state.service.readCodexRateLimits = async () => {
      state.events.push(["read-codex"]);
      return { rateLimits: { primary: { usedPercent: 40 } } };
    };
    assert.deepEqual(await state.service.refreshCodex(), {
      rateLimits: { primary: { usedPercent: 40 } },
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("RateLimitTelemetryService tolerates a rejected account RPC during background refresh", async () => {
  const state = fixture();
  state.delayAccount();

  assert.deepEqual(await state.service.history({ range: "7d" }), { fresh: true });
  state.rejectAccount(new Error("account offline"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.events.some((event) => (
    event[0] === "error" && event[1] === "Cannot identify Codex account:"
  )), true);
  assert.equal(state.events.filter(([name]) => name === "record").length, 1);
  assert.deepEqual(state.events.find(([name]) => name === "read-history")?.[1], { range: "7d" });
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
