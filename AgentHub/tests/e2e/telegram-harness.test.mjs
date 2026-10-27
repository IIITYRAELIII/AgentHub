import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureE2eFailure,
  childProcessTerminal,
  cleanupE2eTemporaryRoot,
  E2eChildProcessOwner,
  e2eFailureArtifactDirectory,
  e2eTimeoutMs,
} from "../../e2e/telegram-harness.mjs";
import { runIsolatedTestCommand } from "../../test-suite.mjs";

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

test("E2E process owner drains bounded stdout and retains owned process chronology", async () => {
  const owner = new E2eChildProcessOwner();
  const child = owner.start(() => spawn(process.execPath, ["-e",
    "process.stdout.write('x'.repeat(40000)+' secret=SYNTHETIC STDOUT_END');"], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }));
  await once(child, "close");
  const diagnostics = owner.diagnostics();
  assert.equal(child.exitCode, 0);
  assert.ok(diagnostics.stdout.length <= 32_768);
  assert.match(diagnostics.stdout, /STDOUT_END/u);
  assert.doesNotMatch(diagnostics.stdout, /SYNTHETIC/u);
  const generation = diagnostics.generations[0];
  const times = [generation.spawnRequestedAt, generation.spawnedAt, generation.exitedAt, generation.closedAt]
    .map((value) => Date.parse(value));
  assert.ok(times.every(Number.isFinite));
  assert.ok(times.every((value, index) => index === 0 || value >= times[index - 1]));
  await owner.stop();
});

test("E2E failure evidence survives the outer isolated runner cleanup", async (t) => {
  const checkoutRoot = await mkdtemp(path.join(os.tmpdir(), "ah-evidence-checkout-"));
  t.after(() => rm(checkoutRoot, { recursive: true, force: true }));
  const owner = new E2eChildProcessOwner();
  owner.start(() => new FakeChild({ exitCode: 1 }));
  let temporaryRoot;
  let artifactDirectory;
  let failure;
  await assert.rejects(runIsolatedTestCommand("fixture", [], { execute: async (_command, _args, { env }) => {
    temporaryRoot = env.TEMP;
    artifactDirectory = e2eFailureArtifactDirectory(checkoutRoot, path.join(temporaryRoot, "owned-runtime"));
    failure = await captureE2eFailure({ owner, error: new Error("original startup failure"),
      evidenceDirectory: artifactDirectory, stage: "exact recovery restart 3",
      evidence: { startup: { stage: "desktop-control", outcome: "started" } } });
    throw failure;
  } }), (error) => error === failure);
  await assert.rejects(stat(temporaryRoot), { code: "ENOENT" });
  const evidence = JSON.parse(await readFile(path.join(artifactDirectory, "diagnostics.json"), "utf8"));
  assert.equal(evidence.stage, "exact recovery restart 3");
  assert.match(evidence.sections.startup, /desktop-control/u);
  await owner.stop();
});

test("E2E failure diagnostics distinguish a live stall from a terminated child", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-e2e-failure-owner-"));
  const liveEvidence = `${root}-live-evidence`;
  const exitedEvidence = `${root}-exited-evidence`;
  const artifacts = [root, liveEvidence, exitedEvidence];
  t.after(async () => {
    await Promise.all(artifacts.map((entry) => rm(entry, { recursive: true, force: true })));
  });
  const original = new Error("Timeout waiting for editMessageText call after 24000 ms\nRecent Telegram calls:\n[]");
  const liveOwner = new E2eChildProcessOwner({ label: "Telegram Agent Hub", timeoutMs: 2_000 });
  const live = liveOwner.start(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));
  let liveFailure;
  try {
    liveFailure = await captureE2eFailure({
      owner: liveOwner,
      error: original,
      evidenceDirectory: liveEvidence,
      stage: "forward bundle third-message edit after restart",
      evidence: { state: { activeRuns: [] }, botLock: { pid: live.pid } },
    });
    assert.equal(liveFailure.cause, original);
    assert.match(liveFailure.message, /Recent Telegram calls/u);
    assert.match(liveFailure.message, /"exitCode": null/u);
    assert.match(liveFailure.message, /"exit": null/u);
    assert.match(liveFailure.message, new RegExp(`"pid": ${live.pid}`, "u"));
  } finally {
    await liveOwner.stop();
  }

  const exitedOwner = new E2eChildProcessOwner({ label: "Telegram Agent Hub", timeoutMs: 2_000 });
  const syntheticUrlToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
  const syntheticTelegramUrl = `https://api.telegram.org/bot${syntheticUrlToken}/getUpdates`;
  const script = [
    `process.stdout.write('x'.repeat(40000) + ' ${syntheticTelegramUrl} Bearer SYNTHETIC_SECRET token=SYNTHETIC STDOUT_END')`,
    "process.stderr.write('y'.repeat(40000) + ' 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ secret=SYNTHETIC STDERR_END')",
    "process.exitCode = 7",
  ].join(";");
  let exitedStdout = "";
  const exited = exitedOwner.start(() => spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));
  exited.stdout.setEncoding("utf8");
  exited.stdout.on("data", (chunk) => { exitedStdout += chunk; });
  await once(exited, "close");
  const exitedFailure = await captureE2eFailure({
    owner: exitedOwner,
    error: original,
    evidenceDirectory: exitedEvidence,
    stage: "forward bundle third-message edit after restart",
    stdout: exitedStdout,
    summary: { botLock: { pid: exited.pid }, journalLock: { token: "SYNTHETIC" } },
    evidence: {
      state: { activeRuns: [], token: "SYNTHETIC", endpointUrl: syntheticTelegramUrl },
      messageBindings: [{ chatId: 84, messageId: 1 }],
      botLock: { pid: exited.pid },
      journalLock: { token: "SYNTHETIC" },
      stdout: exitedStdout,
    },
  });
  assert.equal(exitedFailure.cause, original);
  assert.match(exitedFailure.message, /Recent Telegram calls/u);
  assert.match(exitedFailure.message, /"code": 7/u);
  assert.match(exitedFailure.message, /STDERR_END/u);
  assert.match(exitedFailure.message, /STDOUT_END/u);
  assert.doesNotMatch(exitedFailure.message, /SYNTHETIC_SECRET|123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ|token=SYNTHETIC|secret=SYNTHETIC/u);
  assert.doesNotMatch(exitedFailure.message, new RegExp(syntheticUrlToken, "u"));
  assert.match(exitedFailure.message, /\/bot\[redacted-token\]\/getUpdates/u);
  assert.equal(liveFailure.cause.message, exitedFailure.cause.message,
    "without process diagnostics the two failures have the same raw timeout");
  assert.notEqual(liveFailure.message, exitedFailure.message,
    "process diagnostics make the live stall and terminated child attributable");
  assert.notEqual(liveOwner.diagnostics().exit?.code, exitedOwner.diagnostics().exit?.code,
    "the same raw timeout becomes attributable only through process-owner diagnostics");
  assert.ok(exitedOwner.diagnostics().stderr.length <= 32_768);
  const evidence = JSON.parse(await readFile(path.join(exitedEvidence, "diagnostics.json"), "utf8"));
  assert.equal(evidence.sections.state.includes("SYNTHETIC"), false);
  assert.equal(evidence.sections.state.includes(syntheticUrlToken), false);
  assert.match(evidence.sections.state, /\/bot\[redacted-token\]\/getUpdates/u);
  assert.equal(evidence.sections.botLock.includes(String(exited.pid)), true);
  assert.ok(Object.values(evidence.sections).every((value) => value.length <= 32_768));
  assert.match(evidence.sections.stdout, /STDOUT_END/u);

  const successRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-e2e-success-cleanup-"));
  artifacts.push(successRoot);
  await writeFile(path.join(successRoot, "state.json"), "{}", "utf8");
  await cleanupE2eTemporaryRoot(successRoot);
  await assert.rejects(stat(successRoot), (error) => error.code === "ENOENT");
  await assert.doesNotReject(stat(path.join(exitedEvidence, "diagnostics.json")),
    "failure evidence remains after the ordinary temporary root is cleaned");
});
