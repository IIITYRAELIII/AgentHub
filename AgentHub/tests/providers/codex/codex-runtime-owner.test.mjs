import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCodexHookProcess,
  classifyCodexRolloutProcesses,
  codexObservedRuntimeActive,
  codexRolloutRuntimeState,
  detectCodexHookExecutionOwner,
  resolveCodexTaskActivity,
  resolveCodexObservedExecutionOwner,
} from "../../../src/providers/codex/codex-runtime-owner.mjs";
import { TASK_EXECUTION_OWNERS } from "../../../src/domain/task-execution-owner.mjs";

function snapshot(rootProcessIds, processes) {
  return { rootProcessIds, processes };
}

test("rollout process ancestry distinguishes VSC, Desktop and CLI", () => {
  assert.equal(classifyCodexRolloutProcesses(snapshot([20], [
    { processId: 20, parentProcessId: 10, name: "codex.exe", commandLine: "codex.exe app-server" },
    { processId: 10, parentProcessId: 1, name: "Code.exe", commandLine: "Code.exe" },
  ])), TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(classifyCodexRolloutProcesses(snapshot([30], [
    { processId: 30, parentProcessId: 11, name: "codex.exe", commandLine: "codex.exe app-server" },
    { processId: 11, parentProcessId: 1, name: "ChatGPT.exe", commandLine: "ChatGPT.exe" },
  ])), TASK_EXECUTION_OWNERS.DESKTOP);
  assert.equal(classifyCodexRolloutProcesses(snapshot([40], [
    { processId: 40, parentProcessId: 12, name: "codex.exe", commandLine: "codex.exe resume thread" },
    { processId: 12, parentProcessId: 1, name: "pwsh.exe", commandLine: "pwsh.exe" },
  ])), TASK_EXECUTION_OWNERS.CLI);
});

test("hook caller ancestry identifies the client that started this exact turn", async () => {
  const desktopSnapshot = snapshot([90], [
    { processId: 90, parentProcessId: 30, name: "node.exe", commandLine: "node codex-stop-hook-launcher.mjs" },
    { processId: 30, parentProcessId: 11, name: "codex.exe", commandLine: "codex.exe app-server" },
    { processId: 11, parentProcessId: 1, name: "ChatGPT.exe", commandLine: "ChatGPT.exe" },
  ]);
  assert.equal(classifyCodexHookProcess(desktopSnapshot), TASK_EXECUTION_OWNERS.DESKTOP);
  assert.equal(await detectCodexHookExecutionOwner({
    platform: "win32",
    processId: 90,
    probe: async (processId) => {
      assert.equal(processId, 90);
      return desktopSnapshot;
    },
  }), TASK_EXECUTION_OWNERS.DESKTOP);
});

test("captured turn owner wins over ambiguous rollout file holders", async () => {
  let probes = 0;
  const owner = await resolveCodexObservedExecutionOwner({ running: true }, {
    turnId: "turn-app",
    rolloutPath: "C:\\shared-rollout.jsonl",
    platform: "win32",
    capturedOwner: TASK_EXECUTION_OWNERS.DESKTOP,
    probe: async () => { probes += 1; return {}; },
  });
  assert.equal(owner, TASK_EXECUTION_OWNERS.DESKTOP);
  assert.equal(probes, 0);
});

test("Agent Hub is excluded and ambiguous external clients stay EXT", () => {
  const processes = [
    { processId: 50, parentProcessId: 5, name: "codex.exe", commandLine: "codex.exe app-server --stdio" },
    { processId: 5, parentProcessId: 1, name: "node.exe", commandLine: "node agent-hub-main.mjs" },
    { processId: 60, parentProcessId: 6, name: "codex.exe", commandLine: "codex.exe app-server" },
    { processId: 6, parentProcessId: 1, name: "Code.exe", commandLine: "Code.exe" },
  ];
  assert.equal(classifyCodexRolloutProcesses(snapshot([50, 60], processes), {
    agentHubPid: 50,
  }), TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(classifyCodexRolloutProcesses(snapshot([60, 70], [
    ...processes,
    { processId: 70, parentProcessId: 7, name: "codex.exe", commandLine: "codex.exe app-server" },
    { processId: 7, parentProcessId: 1, name: "ChatGPT.exe", commandLine: "ChatGPT.exe" },
  ])), TASK_EXECUTION_OWNERS.EXTERNAL);
});

test("hook caller ancestry recognizes current and legacy Agent Hub entrypoints", () => {
  for (const entrypoint of ["agent-hub-main.mjs", "agent-hub-server.mjs"]) {
    assert.equal(classifyCodexHookProcess(snapshot([90], [
      { processId: 90, parentProcessId: 30, name: "node.exe", commandLine: "node codex-stop-hook-launcher.mjs" },
      { processId: 30, parentProcessId: 11, name: "codex.exe", commandLine: "codex.exe app-server" },
      { processId: 11, parentProcessId: 1, name: "node.exe", commandLine: `node ${entrypoint}` },
    ])), TASK_EXECUTION_OWNERS.HUB);
  }
});

test("rollout runtime state distinguishes a dead client from a live holder", async () => {
  assert.deepEqual(codexRolloutRuntimeState(snapshot([], []), { agentHubPid: 50 }), {
    hasLiveProcess: false,
    owner: TASK_EXECUTION_OWNERS.EXTERNAL,
  });
  assert.equal(await codexObservedRuntimeActive({ running: true }, {
    turnId: "dead-turn",
    rolloutPath: "C:\\dead-rollout.jsonl",
    platform: "win32",
    capturedOwner: TASK_EXECUTION_OWNERS.VSCODE,
    nowMs: 1,
    probe: async () => snapshot([], []),
  }), false);
  assert.equal(await codexObservedRuntimeActive({ running: true }, {
    turnId: "live-turn",
    rolloutPath: "C:\\live-rollout.jsonl",
    platform: "win32",
    capturedOwner: TASK_EXECUTION_OWNERS.VSCODE,
    nowMs: 1,
    probe: async () => snapshot([60], [
      { processId: 60, parentProcessId: 6, name: "codex.exe", commandLine: "codex.exe app-server" },
      { processId: 6, parentProcessId: 1, name: "Code.exe", commandLine: "Code.exe" },
    ]),
  }), true);
});

test("task activity does not preserve a dead Hub turn as external after App Server restart", async () => {
  const result = await resolveCodexTaskActivity({
    activity: {
      running: true,
      activeTurnIds: ["interrupted-hub-turn"],
      lastActivityAtMs: 100,
    },
  }, {
    turnId: "interrupted-hub-turn",
    rolloutPath: "C:\\interrupted-hub-rollout.jsonl",
    platform: "win32",
    capturedOwner: TASK_EXECUTION_OWNERS.HUB,
    nowMs: 1_000,
    probe: async () => snapshot([], []),
  });
  assert.deepEqual(result, { state: "inactive", executionOwner: null });
});

test("task activity keeps an authoritative active App Server status", async () => {
  const result = await resolveCodexTaskActivity({
    threadStatus: { type: "active" },
    activity: { running: false },
  }, {
    platform: "win32",
  });
  assert.deepEqual(result, {
    state: "active",
    executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
  });
});

test("an unavailable rollout process probe does not falsely stop a turn", async () => {
  assert.equal(await codexObservedRuntimeActive({ running: true }, {
    turnId: "unknown-turn",
    rolloutPath: "C:\\unknown-rollout.jsonl",
    platform: "win32",
    capturedOwner: TASK_EXECUTION_OWNERS.VSCODE,
    nowMs: 1,
    probe: async () => { throw new Error("probe unavailable"); },
  }), true);
});

test("a recently active unowned rollout is not stopped before the grace period", async () => {
  let probes = 0;
  assert.equal(await codexObservedRuntimeActive({ running: true, lastActivityAtMs: 100 }, {
    turnId: "unowned-turn",
    rolloutPath: "C:\\unowned-rollout.jsonl",
    platform: "win32",
    nowMs: 1_000,
    probe: async () => { probes += 1; return snapshot([], []); },
  }), true);
  assert.equal(probes, 0);
});

test("a stale unowned rollout stops when no client process holds it", async () => {
  assert.equal(await codexObservedRuntimeActive({ running: true, lastActivityAtMs: 100 }, {
    turnId: "stale-unowned-turn",
    rolloutPath: "C:\\stale-unowned-rollout.jsonl",
    platform: "win32",
    nowMs: 100_000,
    probe: async () => snapshot([], []),
  }), false);
});

test("a stale session-wide VSC marker is not presented as current client evidence", async () => {
  const owner = await resolveCodexObservedExecutionOwner({
    running: true,
    activeVscodeTurnIds: ["resumed-turn"],
  }, {
    turnId: "resumed-turn",
    rolloutPath: "C:\\resumed-rollout.jsonl",
    platform: "win32",
    nowMs: 100_000,
    probe: async () => snapshot([], []),
  });
  assert.equal(owner, TASK_EXECUTION_OWNERS.EXTERNAL);
});

test("a fresh exact VSC client id survives a lagging empty process snapshot", async () => {
  const owner = await resolveCodexObservedExecutionOwner({
    running: true,
    activeVscodeTurnIds: ["fresh-vsc-turn"],
    lastActivityAtMs: 99_500,
  }, {
    turnId: "fresh-vsc-turn",
    rolloutPath: "C:\\fresh-vsc-rollout.jsonl",
    platform: "win32",
    nowMs: 100_000,
    probe: async () => snapshot([], []),
  });
  assert.equal(owner, TASK_EXECUTION_OWNERS.VSCODE);
});

test("per-turn VSC evidence is preserved when a process probe is unavailable", async () => {
  let calls = 0;
  const owner = await resolveCodexObservedExecutionOwner({
    running: true,
    activeVscodeTurnIds: ["turn-vsc"],
  }, {
    turnId: "turn-vsc",
    rolloutPath: "C:\\rollout.jsonl",
    platform: "linux",
    probe: async () => { calls += 1; return {}; },
  });
  assert.equal(owner, TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(calls, 0);
});

test("Desktop process evidence overrides a generic VSC client marker", async () => {
  const owner = await resolveCodexObservedExecutionOwner({
    running: true,
    activeVscodeTurnIds: ["turn-from-desktop"],
  }, {
    turnId: "turn-from-desktop",
    rolloutPath: "C:\\desktop-with-client-id.jsonl",
    platform: "win32",
    nowMs: 1,
    probe: async () => snapshot([30], [
      { processId: 30, parentProcessId: 11, name: "codex.exe", commandLine: "codex.exe app-server" },
      { processId: 11, parentProcessId: 1, name: "ChatGPT.exe", commandLine: "ChatGPT.exe" },
    ]),
  });
  assert.equal(owner, TASK_EXECUTION_OWNERS.DESKTOP);
});

test("a current process signal can identify Desktop or CLI without originator", async () => {
  const activity = { running: true, activeVscodeTurnIds: [], lastActivityAtMs: 123 };
  const desktop = await resolveCodexObservedExecutionOwner(activity, {
    rolloutPath: "C:\\desktop-rollout.jsonl",
    platform: "win32",
    nowMs: 1,
    probe: async () => snapshot([30], [
      { processId: 30, parentProcessId: 11, name: "codex.exe", commandLine: "codex.exe app-server" },
      { processId: 11, parentProcessId: 1, name: "ChatGPT.exe", commandLine: "ChatGPT.exe" },
    ]),
  });
  const cli = await resolveCodexObservedExecutionOwner(activity, {
    rolloutPath: "C:\\cli-rollout.jsonl",
    platform: "win32",
    nowMs: 1,
    probe: async () => snapshot([40], [
      { processId: 40, parentProcessId: 12, name: "codex.exe", commandLine: "codex.exe resume thread" },
      { processId: 12, parentProcessId: 1, name: "pwsh.exe", commandLine: "pwsh.exe" },
    ]),
  });
  assert.equal(desktop, TASK_EXECUTION_OWNERS.DESKTOP);
  assert.equal(cli, TASK_EXECUTION_OWNERS.CLI);
});

test("process probes are cached and concurrent calls are coalesced", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const probe = async () => {
    calls += 1;
    await gate;
    return snapshot([40], [
      { processId: 40, parentProcessId: 12, name: "codex.exe", commandLine: "codex.exe resume thread" },
      { processId: 12, parentProcessId: 1, name: "pwsh.exe", commandLine: "pwsh.exe" },
    ]);
  };
  const activity = { running: true, activeVscodeTurnIds: [] };
  const options = {
    rolloutPath: "C:\\coalesced-rollout.jsonl",
    platform: "win32",
    nowMs: 100,
    probe,
  };
  const first = resolveCodexObservedExecutionOwner(activity, options);
  const second = resolveCodexObservedExecutionOwner(activity, options);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    TASK_EXECUTION_OWNERS.CLI,
    TASK_EXECUTION_OWNERS.CLI,
  ]);
  assert.equal(await resolveCodexObservedExecutionOwner(activity, {
    ...options,
    nowMs: 101,
  }), TASK_EXECUTION_OWNERS.CLI);
  assert.equal(calls, 1);
});
