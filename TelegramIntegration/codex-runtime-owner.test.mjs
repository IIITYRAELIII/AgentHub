import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCodexRolloutProcesses,
  resolveCodexObservedExecutionOwner,
} from "./codex-runtime-owner.mjs";
import { TASK_EXECUTION_OWNERS } from "./task-catalog.mjs";

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

test("Integration is excluded and ambiguous external clients stay EXT", () => {
  const processes = [
    { processId: 50, parentProcessId: 5, name: "codex.exe", commandLine: "codex.exe app-server --stdio" },
    { processId: 5, parentProcessId: 1, name: "node.exe", commandLine: "node bot.mjs" },
    { processId: 60, parentProcessId: 6, name: "codex.exe", commandLine: "codex.exe app-server" },
    { processId: 6, parentProcessId: 1, name: "Code.exe", commandLine: "Code.exe" },
  ];
  assert.equal(classifyCodexRolloutProcesses(snapshot([50, 60], processes), {
    integrationPid: 50,
  }), TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(classifyCodexRolloutProcesses(snapshot([60, 70], [
    ...processes,
    { processId: 70, parentProcessId: 7, name: "codex.exe", commandLine: "codex.exe app-server" },
    { processId: 7, parentProcessId: 1, name: "ChatGPT.exe", commandLine: "ChatGPT.exe" },
  ])), TASK_EXECUTION_OWNERS.EXTERNAL);
});

test("per-turn VSC evidence wins without a process probe", async () => {
  let calls = 0;
  const owner = await resolveCodexObservedExecutionOwner({
    running: true,
    activeVscodeTurnIds: ["turn-vsc"],
  }, {
    turnId: "turn-vsc",
    rolloutPath: "C:\\rollout.jsonl",
    platform: "win32",
    probe: async () => { calls += 1; return {}; },
  });
  assert.equal(owner, TASK_EXECUTION_OWNERS.VSCODE);
  assert.equal(calls, 0);
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
