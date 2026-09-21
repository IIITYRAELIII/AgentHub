import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  childProcessTerminal,
  E2eChildProcessOwner,
  e2eTimeoutMs,
} from "../../e2e/telegram-harness.mjs";

class FakeChild extends EventEmitter {
  constructor({ pid = 1234, exitCode = null, signalCode = null, onKill = null } = {}) {
    super();
    this.pid = pid;
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    this.onKill = onKill;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    this.onKill?.(this, signal);
    return true;
  }

  finish(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

test("E2E timeout keeps normal platforms unchanged and gives Windows process tests headroom", () => {
  assert.equal(e2eTimeoutMs(8_000, { platform: "linux", environment: {} }), 8_000);
  assert.equal(e2eTimeoutMs(8_000, { platform: "win32", environment: {} }), 24_000);
});

test("E2E timeout multiplier can be overridden for slow or fast environments", () => {
  assert.equal(e2eTimeoutMs(8_000, {
    platform: "win32",
    environment: { TELEGRAM_E2E_TIMEOUT_MULTIPLIER: "1.5" },
  }), 12_000);
  assert.equal(e2eTimeoutMs(8_000, {
    platform: "linux",
    environment: { TELEGRAM_E2E_TIMEOUT_MULTIPLIER: "invalid" },
  }), 8_000);
});

test("E2E process owner recognizes numeric, signal and already-finished children", async () => {
  for (const child of [
    new FakeChild({ exitCode: 0 }),
    new FakeChild({ signalCode: "SIGTERM" }),
  ]) {
    const owner = new E2eChildProcessOwner({ timeoutMs: 1 });
    owner.start(() => child);
    const result = await owner.stop();
    assert.equal(owner.child, null);
    assert.deepEqual(child.kills, []);
    assert.equal(childProcessTerminal(child), true);
    assert.equal(result.exitCode, child.exitCode);
    assert.equal(result.signalCode, child.signalCode);
  }
});

test("E2E process owner subscribes before a synchronous signal exit", async () => {
  let forcedStops = 0;
  const child = new FakeChild({
    onKill(current, signal) {
      current.finish(null, signal);
    },
  });
  const owner = new E2eChildProcessOwner({
    timeoutMs: 1,
    stopPidImpl: async () => { forcedStops += 1; },
  });
  owner.start(() => child);
  owner.recordEndpointOwner({
    pid: 1234,
    releaseId: "release-a",
    instanceId: "instance-a",
    status: "ready",
    token: "must-not-be-copied",
  });
  const result = await owner.stop();
  assert.equal(result.signalCode, "SIGTERM");
  assert.deepEqual(result.exit, { code: null, signal: "SIGTERM" });
  assert.equal(forcedStops, 0);
  assert.deepEqual(owner.diagnostics().generations[0].close, {
    code: null,
    signal: "SIGTERM",
  });
  assert.equal("token" in owner.diagnostics().generations[0].endpointOwner, false);
});

test("E2E process owner retains an unconfirmed child and blocks another generation", async () => {
  const child = new FakeChild();
  const delays = [];
  const owner = new E2eChildProcessOwner({
    timeoutMs: 1,
    delayImpl: async (ms) => { delays.push(ms); },
    stopPidImpl: async () => false,
  });
  owner.start(() => child);
  await assert.rejects(owner.stop(), /did not stop; ownership retained/u);
  assert.equal(owner.child, child);
  assert.throws(() => owner.start(() => new FakeChild({ pid: 5678 })), /is still running/u);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.deepEqual(delays, [1, 1], "grace and forced-stop windows keep the configured bound");
});

test("E2E process owner keeps bounded startup-failure diagnostics", async () => {
  const child = new FakeChild({ pid: null });
  const owner = new E2eChildProcessOwner({ label: "local-control Hub", timeoutMs: 1 });
  owner.start(() => child);
  child.emit("error", Object.assign(new Error("spawn failed with Authorization: secret"), {
    code: "ENOENT",
  }));
  const diagnostics = owner.diagnostics({ stage: "startup" });
  assert.equal(diagnostics.spawnError.code, "ENOENT");
  assert.equal(diagnostics.spawnError.message.includes("secret"), false);
  assert.equal(diagnostics.stage, "startup");
  await owner.stop();
  assert.equal(owner.child, null);
});
