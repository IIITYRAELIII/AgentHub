import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  botReplacementInvocation,
  directWindowsLauncherInvocation,
  independentWindowsLauncherInvocation,
  launchReplacementAndWait,
  waitForReplacementLock,
} from "../../src/runtime/runtime-restart.mjs";

test("runtime restart follows the external launcher to the newest release", () => {
  const result = botReplacementInvocation({
    environment: {
      SystemRoot: "C:\\Windows",
      AGENT_HUB_LAUNCHER: "C:\\Runtime\\AgentHub.RuntimeHost.exe",
    },
    platform: "win32",
    nodeExecutable: "node.exe",
    botFile: "C:\\Old\\agent-hub-server.mjs",
    agentHubRoot: "C:\\Old",
  });
  assert.equal(result.command, path.resolve("C:\\Runtime\\AgentHub.RuntimeHost.exe"));
  assert.deepEqual(result.args, ["--spawn-independent"]);
  assert.equal(result.options.cwd, path.resolve("C:\\Runtime"));
});

test("legacy configured launchers migrate to the sibling RuntimeHost executable", () => {
  const result = independentWindowsLauncherInvocation({
    environment: { SystemRoot: "C:\\Windows" },
    launcher: "C:\\Runtime Path\\launch.ps1",
  });
  assert.equal(result.command, path.resolve("C:\\Runtime Path\\AgentHub.RuntimeHost.exe"));
  assert.deepEqual(result.args, ["--spawn-independent"]);
  assert.equal(result.options.detached, undefined);
});

test("direct RuntimeHost fallback remains hidden and does not invoke a script host", () => {
  const result = directWindowsLauncherInvocation({
    environment: { SystemRoot: "C:\\Windows" },
    launcher: "C:\\Runtime Path\\AgentHub.RuntimeHost.exe",
  });
  assert.equal(result.command, path.resolve("C:\\Runtime Path\\AgentHub.RuntimeHost.exe"));
  assert.deepEqual(result.args, []);
  assert.equal(result.options.windowsHide, true);
});

test("replacement readiness requires a new process lock", async () => {
  const locks = [
    JSON.stringify({ pid: 42, instanceToken: "old", ready: true }),
    JSON.stringify({ pid: 84, instanceToken: "new", ready: true }),
  ];
  const lock = await waitForReplacementLock({
    lockFile: "bot.lock",
    currentPid: 42,
    timeoutMs: 100,
    pollMs: 1,
    readFileImpl: async () => locks.shift() ?? "",
    delayImpl: async () => {},
    isAlive: (pid) => pid === 84,
  });
  assert.equal(lock?.pid, 84);
});

test("replacement readiness ignores a lock owned by a dead process", async () => {
  const locks = [
    JSON.stringify({ pid: 84, instanceToken: "dead", ready: true }),
    JSON.stringify({ pid: 85, instanceToken: "live", ready: true }),
  ];
  const lock = await waitForReplacementLock({
    lockFile: "bot.lock",
    currentPid: 42,
    timeoutMs: 100,
    pollMs: 1,
    readFileImpl: async () => locks.shift() ?? "",
    delayImpl: async () => {},
    isAlive: (pid) => pid === 85,
  });
  assert.equal(lock?.pid, 85);
});

test("replacement retries WMI and then uses direct fallback until a bot owns the lock", async () => {
  let launches = 0;
  const result = await launchReplacementAndWait({
    invocation: { command: "wmi", args: [], options: {} },
    fallbackInvocation: { command: "direct", args: [], options: {} },
    lockFile: "bot.lock",
    currentPid: 42,
    attempts: 2,
    ownershipTimeoutMs: 1,
    readinessTimeoutMs: 1,
    spawnImpl: () => {
      launches += 1;
      return { once() {}, unref() {} };
    },
    readFileImpl: async () => launches >= 3
      ? JSON.stringify({ pid: 84, instanceToken: "ready", ready: true })
      : "",
    delayImpl: async () => {},
    isAlive: (pid) => pid === 84,
  });
  assert.equal(launches, 3);
  assert.equal(result.usedFallback, true);
  assert.equal(result.lock.pid, 84);
});

test("replacement waits for the first owner to become ready without launching duplicates", async () => {
  let launches = 0;
  const locks = [
    JSON.stringify({ pid: 84, instanceToken: "slow", ready: false }),
    JSON.stringify({ pid: 84, instanceToken: "slow", ready: false }),
    JSON.stringify({ pid: 84, instanceToken: "slow", ready: true }),
  ];
  const result = await launchReplacementAndWait({
    invocation: { command: "runtime", args: [], options: {} },
    lockFile: "bot.lock",
    currentPid: 42,
    attempts: 2,
    ownershipTimeoutMs: 100,
    readinessTimeoutMs: 100,
    spawnImpl: () => {
      launches += 1;
      return { once() {}, unref() {} };
    },
    readFileImpl: async () => locks.shift() ?? locks.at(-1) ?? "",
    delayImpl: async () => {},
    isAlive: (pid) => pid === 84,
  });
  assert.equal(launches, 1);
  assert.equal(result.lock.instanceToken, "slow");
  assert.equal(result.lock.ready, true);
});

test("replacement readiness timeout terminates the captured owner tree and releases its lock", async () => {
  const events = [];
  let ownerAlive = true;
  let launcherAlive = true;
  let lock = JSON.stringify({ pid: 84, instanceToken: "replacement", ready: false });
  await assert.rejects(launchReplacementAndWait({
    invocation: { command: "runtime", args: [], options: {} },
    lockFile: "bot.lock",
    currentPid: 42,
    attempts: 1,
    ownershipTimeoutMs: 1,
    readinessTimeoutMs: 1,
    spawnImpl: () => ({ pid: 73, once() {}, unref() {} }),
    readFileImpl: async () => lock,
    unlinkImpl: async () => {
      events.push("unlock");
      lock = "";
    },
    stopTree: async (pid) => {
      events.push(`stop:${pid}`);
      if (pid === 84) ownerAlive = false;
      if (pid === 73) launcherAlive = false;
      return true;
    },
    delayImpl: async () => {},
    isAlive: (pid) => pid === 84 ? ownerAlive : pid === 73 ? launcherAlive : false,
  }), (error) => {
    assert.match(error.message, /did not become ready/);
    assert.deepEqual(error.replacementCleanup, {
      confirmed: true,
      launchedPid: 73,
      ownerPid: 84,
      instanceToken: "replacement",
    });
    return true;
  });
  assert.deepEqual(events, ["stop:84", "stop:73", "unlock"]);
});

test("legacy restart keeps the current bot entry point", () => {
  const result = botReplacementInvocation({
    environment: {},
    platform: "win32",
    nodeExecutable: "node.exe",
    botFile: "C:\\AgentHub\\agent-hub-server.mjs",
    agentHubRoot: "C:\\AgentHub",
  });
  assert.equal(result.command, "node.exe");
  assert.deepEqual(result.args, [path.resolve("C:\\AgentHub\\agent-hub-server.mjs")]);
});
