import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeRunController } from "../../../src/providers/claude/claude-run-controller.mjs";
import { ownedProcessTreeFromSnapshot } from "../../../src/providers/claude/claude-run-io.mjs";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-controller-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

test("ClaudeRunController owns detached output, stream parsing and completion", async () => {
  await withTempDir(async (directory) => {
    const events = [];
    let resolveCompletion;
    const completed = new Promise((resolve) => { resolveCompletion = resolve; });
    const run = { turnId: "turn-one", threadId: "session-one" };
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      isCurrentRun: (candidate) => candidate === run,
      onStreamEvent: (_run, parsed) => events.push(parsed),
      onComplete: (_run, result) => resolveCompletion(result),
      processFingerprintLookup: async (pid) => ({
        pid,
        creationTime: "2026-07-30T10:00:00.000Z",
        executablePath: process.execPath,
        commandLine: "node worker",
      }),
    });
    const payload = JSON.stringify({
      type: "result",
      result: "готово",
      session_id: "session-one",
      usage: {},
    });
    await controller.start(run, {
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(`${payload}\n`)})`],
      cwd: directory,
      env: process.env,
    });
    const completion = await completed;
    assert.equal(completion.result.result, "готово");
    assert.equal(events.at(-1).result.result, "готово");
    assert.equal(run.claudeSettled, true);
    assert.equal(run.claudeProcessFingerprint.creationTime, "2026-07-30T10:00:00.000Z");
  });
});

// Имитация Claude CLI с потоковым вводом: первый ход «работает», пока не
// придёт control_request interrupt, затем завершает его результатом
// error_during_execution, а следующее сообщение из stdin отвечает эхом.
const FAKE_STREAM_CLI = `
const NL = String.fromCharCode(10);
let buffer = "";
let interrupted = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));
function emit(value) { process.stdout.write(JSON.stringify(value) + NL); }
function handle(message) {
  if (message.type === "user" && !interrupted) {
    emit({ type: "system", subtype: "init", session_id: "session-steer" });
    return;
  }
  if (message.type === "control_request") {
    interrupted = true;
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    emit({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "session-steer", usage: {} });
    return;
  }
  if (message.type === "user") {
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "эхо: " + message.message.content }] } });
    emit({ type: "result", subtype: "success", result: "эхо: " + message.message.content, session_id: "session-steer", usage: {} });
  }
}
`;

test("ClaudeRunController steers a running turn through interrupt and continuation", async () => {
  await withTempDir(async (directory) => {
    const events = [];
    let resolveCompletion;
    const completed = new Promise((resolve) => { resolveCompletion = resolve; });
    const run = { turnId: "turn-steer", threadId: "session-steer" };
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      isCurrentRun: (candidate) => candidate === run,
      onStreamEvent: (_run, parsed) => events.push(parsed.event),
      onComplete: (_run, result) => resolveCompletion(result),
      processFingerprintLookup: async (pid) => ({ pid, creationTime: "t", executablePath: process.execPath, commandLine: "node" }),
    });
    await controller.start(run, {
      command: process.execPath,
      args: ["-e", FAKE_STREAM_CLI],
      cwd: directory,
      env: process.env,
      input: "Первое задание",
    });
    assert.ok(run.claudeInput, "stream input keeps an open stdin channel");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const steered = controller.steer(run, "Уточнение");
    assert.equal(steered.turnId, "turn-steer");
    assert.equal(run.claudeSteer.state, "interrupting");
    const completion = await completed;
    assert.equal(completion.result.subtype, "success");
    assert.equal(completion.result.result, "эхо: Уточнение");
    assert.equal(run.claudeSettled, true);
    assert.equal(run.claudeInput, null);
    // Результат прерванного хода не считается результатом хода и не уходит наблюдателям.
    assert.deepEqual(
      events.filter((event) => event.type === "result").map((event) => event.subtype),
      ["success"],
    );
    assert.equal(events.some((event) => event.type === "control_response"), true);
  });
});

test("ClaudeRunController refuses to steer without an open input channel", async () => {
  await withTempDir(async (directory) => {
    const controller = new ClaudeRunController({ dataDir: directory });
    assert.throws(() => controller.steer({ turnId: "t" }, "x"), /not steerable/u);
    assert.throws(() => controller.steer({ turnId: "t", claudeInput: {}, claudeInputClosed: true }, "x"), /not steerable/u);
    assert.throws(() => controller.steer({ turnId: "t", claudeInput: {} }, "   "), /not steerable/u);
  });
});

test("ClaudeRunController drops the input channel when reattaching after a restart", async () => {
  await withTempDir(async (directory) => {
    const outputPath = path.join(directory, "reattach.jsonl");
    await writeFile(outputPath, `${JSON.stringify({ type: "result", result: "ок", session_id: "s", usage: {} })}\n`, "utf8");
    await writeFile(path.join(directory, "reattach.err.log"), "", "utf8");
    const run = {
      turnId: "turn-reattach",
      threadId: "s",
      pid: process.pid,
      claudeProcessFingerprint: { pid: process.pid, creationTime: "t", executablePath: process.execPath, commandLine: "node" },
      claudeOutputPath: outputPath,
      claudeErrorPath: path.join(directory, "reattach.err.log"),
      claudeInput: { write() {}, end() {} },
    };
    let processAlive = true;
    const controller = new ClaudeRunController({
      dataDir: directory,
      isCurrentRun: (candidate) => candidate === run,
      onComplete: () => {},
      processAlive: () => processAlive,
      processFingerprintLookup: async () => ({ ...run.claudeProcessFingerprint }),
      processTreeLookup: async () => (processAlive ? [{ ...run.claudeProcessFingerprint, parentPid: 1 }] : []),
      stopProcess: async (pid) => {
        assert.equal(pid, process.pid);
        processAlive = false;
        return true;
      },
    });
    await controller.attachAfterRestart(run);
    assert.equal(run.claudeInput, null);
    assert.equal(run.claudeInputClosed, true);
  });
});

test("ClaudeRunController reattaches from a saved offset and finalizes a result", async () => {
  await withTempDir(async (directory) => {
    const outputPath = path.join(directory, "saved.jsonl");
    const errorPath = path.join(directory, "saved.err.log");
    await writeFile(outputPath, `${JSON.stringify({
      type: "result",
      result: "после рестарта",
      session_id: "session-two",
      usage: {},
    })}\n`, "utf8");
    await writeFile(errorPath, "", "utf8");
    let completion;
    const run = {
      turnId: "turn-two",
      threadId: "session-two",
      pid: process.pid,
      claudeProcessFingerprint: {
        pid: process.pid,
        creationTime: "2026-07-30T10:00:00.000Z",
        executablePath: process.execPath,
        commandLine: "node agent-hub",
      },
      claudeOutputPath: outputPath,
      claudeErrorPath: errorPath,
    };
    let processAlive = true;
    const controller = new ClaudeRunController({
      dataDir: directory,
      isCurrentRun: (candidate) => candidate === run,
      onComplete: (_run, value) => { completion = value; },
      processAlive: () => processAlive,
      processFingerprintLookup: async () => ({ ...run.claudeProcessFingerprint }),
      processTreeLookup: async () => (processAlive ? [{ ...run.claudeProcessFingerprint, parentPid: 1 }] : []),
      stopProcess: async (pid) => {
        assert.equal(pid, process.pid);
        processAlive = false;
        return true;
      },
    });
    const alive = await controller.attachAfterRestart(run);
    assert.equal(alive, true);
    assert.equal(completion.result.result, "после рестарта");
    assert.equal(run.claudeSettled, true);
  });
});

test("ClaudeRunController records an observed restored-process exit before finalizing", async () => {
  await withTempDir(async (directory) => {
    const outputPath = path.join(directory, "restored-exit.jsonl");
    const errorPath = path.join(directory, "restored-exit.err.log");
    await writeFile(outputPath, "", "utf8");
    await writeFile(errorPath, "", "utf8");
    const fingerprint = {
      pid: 4328,
      creationTime: "2026-07-30T10:00:00.000Z",
      executablePath: process.execPath,
      commandLine: "node restored-worker",
    };
    const run = {
      turnId: "turn-restored-exit",
      threadId: "session-restored-exit",
      pid: fingerprint.pid,
      claudeProcessFingerprint: fingerprint,
      claudeProcessStartedAtMs: Date.parse(fingerprint.creationTime),
      claudeOwnedProcessTree: [fingerprint],
      claudeOutputPath: outputPath,
      claudeErrorPath: errorPath,
    };
    const state = { alive: true, completed: 0, persisted: 0 };
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 60_000,
      completionExitGraceMs: 0,
      isCurrentRun: (candidate) => candidate === run,
      processAlive: () => state.alive,
      processFingerprintLookup: async () => (state.alive ? { ...fingerprint } : null),
      processTreeLookup: async (_root, _known, { rootExited }) => {
        if (state.alive) return [{ ...fingerprint, parentPid: 1 }];
        return rootExited ? [] : null;
      },
      onPersist: async () => { state.persisted += 1; },
      onComplete: async () => { state.completed += 1; },
      onReadError: () => {},
    });

    assert.equal(await controller.attachAfterRestart(run), true);
    controller.pause(run);
    await writeFile(outputPath, `${JSON.stringify({
      type: "result",
      result: "после наблюдённого выхода",
      session_id: run.threadId,
      usage: {},
    })}\n`, "utf8");
    state.alive = false;
    await controller.drain(run);

    assert.equal(state.completed, 1);
    assert.equal(run.claudeSettled, true);
    assert.equal(run.claudeExited, true);
    assert.equal(Number.isFinite(run.claudeProcessExitedAtMs), true);
    assert.ok(state.persisted >= 2, "attach and observed exit are both persisted");
  });
});

test("ClaudeRunController rejects a reused PID on reattach and cancel", async () => {
  await withTempDir(async (directory) => {
    const run = {
      turnId: "turn-reused",
      threadId: "session-reused",
      pid: 4321,
      claudeProcessFingerprint: {
        pid: 4321,
        creationTime: "2026-07-30T10:00:00.000Z",
        executablePath: "C:\\Claude\\claude.exe",
        commandLine: "claude --resume session-reused",
      },
    };
    let stopCalls = 0;
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: () => true,
      processFingerprintLookup: async () => ({
        ...run.claudeProcessFingerprint,
        creationTime: "2026-07-30T10:05:00.000Z",
      }),
      stopProcess: async () => {
        stopCalls += 1;
        return true;
      },
    });

    assert.equal(await controller.attachAfterRestart(run), false);
    assert.equal(await controller.stop(run), false);
    assert.equal(stopCalls, 0);
  });
});

test("ClaudeRunController fails safe when process fingerprint is unavailable", async () => {
  await withTempDir(async (directory) => {
    const run = {
      turnId: "turn-unsupported",
      threadId: "session-unsupported",
      pid: 4322,
      claudeProcessFingerprint: {
        pid: 4322,
        creationTime: "known-start",
      },
    };
    let stopCalls = 0;
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: () => true,
      processFingerprintLookup: async () => null,
      stopProcess: async () => {
        stopCalls += 1;
        return true;
      },
    });

    assert.equal(await controller.attachAfterRestart(run), false);
    assert.equal(await controller.stop(run), false);
    assert.equal(stopCalls, 0);
  });
});

test("ClaudeRunController stops its own live child when WMI fingerprint is temporarily unavailable", async () => {
  await withTempDir(async (directory) => {
    const run = {
      turnId: "turn-current-child",
      threadId: "session-current-child",
      pid: 4324,
      process: { pid: 4324, exitCode: null },
      claudeProcessFingerprint: null,
    };
    const stopped = [];
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: () => true,
      processFingerprintLookup: async () => null,
      stopProcess: async (pid) => {
        stopped.push(pid);
        return true;
      },
    });
    assert.equal(await controller.stop(run), true);
    assert.deepEqual(stopped, [4324]);
  });
});

test("ClaudeRunController does not treat an exited child handle as current PID ownership", async () => {
  await withTempDir(async (directory) => {
    const run = {
      turnId: "turn-exited-child",
      threadId: "session-exited-child",
      pid: 4327,
      process: { pid: 4327, exitCode: null, signalCode: "SIGTERM" },
      claudeProcessFingerprint: { pid: 4327, creationTime: "original" },
    };
    let stopCalls = 0;
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: () => true,
      processFingerprintLookup: async () => ({ pid: 4327, creationTime: "reused" }),
      stopProcess: async () => { stopCalls += 1; return true; },
    });
    assert.equal(await controller.stop(run), false);
    assert.equal(stopCalls, 0);
  });
});

test("ClaudeRunController retains exact ownership when terminal tree cleanup fails", async () => {
  await withTempDir(async (directory) => {
    const processHandle = { pid: 4326, exitCode: null };
    const run = {
      turnId: "turn-cleanup-failure",
      threadId: "session-cleanup-failure",
      pid: processHandle.pid,
      process: processHandle,
      claudeResult: { type: "result", result: "done", session_id: "session-cleanup-failure" },
    };
    const errors = [];
    let completed = 0;
    let stopCalls = 0;
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 60_000,
      processAlive: () => true,
      processFingerprintLookup: async () => null,
      stopProcess: async () => { stopCalls += 1; return false; },
      onReadError: (_run, error) => errors.push(error.message),
      onComplete: async () => { completed += 1; },
    });
    await controller.complete(run);
    controller.pause(run);
    assert.equal(run.claudeSettled, false);
    assert.equal(run.claudeCleanupPending, true);
    assert.equal(run.process, processHandle);
    assert.equal(run.claudeStopUnknown, true);
    await controller.complete(run);
    assert.equal(stopCalls, 1, "a failed effect with unknown boundary cannot dispatch a second killer");
    assert.equal(completed, 0);
    assert.match(errors[0], /Cannot stop completed Claude process tree 4326/u);
  });
});

test("ClaudeRunController bounds one unknown stop and resumes only after that attempt settles", async () => {
  await withTempDir(async (directory) => {
    const fingerprint = { pid: 4330, creationTime: "owned" };
    const run = {
      turnId: "turn-pending-stop",
      threadId: "session-pending-stop",
      pid: fingerprint.pid,
      process: { pid: fingerprint.pid, exitCode: null, signalCode: null },
      claudeProcessFingerprint: fingerprint,
      claudeOwnedProcessTree: [fingerprint],
      claudeResult: { type: "result", result: "done", session_id: "session-pending-stop" },
    };
    let alive = true;
    let stopCalls = 0;
    let persistedUnknownAtStop = false;
    let releaseStop;
    const stop = new Promise((resolve) => { releaseStop = resolve; });
    let completed = 0;
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      completionExitGraceMs: 0,
      completionStopTimeoutMs: 20,
      processAlive: () => alive,
      processFingerprintLookup: async () => ({ ...fingerprint }),
      processTreeLookup: async () => (alive ? [{ ...fingerprint, parentPid: 1 }] : []),
      onPersist: async (value) => { persistedUnknownAtStop ||= value.claudeStopUnknown === true; },
      stopProcess: async () => {
        assert.equal(run.claudeStopUnknown, true, "the durable unknown fence precedes the stop effect");
        stopCalls += 1;
        return stop;
      },
      onComplete: async () => { completed += 1; },
    });
    const started = Date.now();
    await controller.complete(run);
    assert.ok(Date.now() - started < 500, "completion is bounded around the stop call itself");
    assert.equal(run.claudeCleanupPending, true);
    assert.equal(run.claudeStopUnknown, true);
    assert.equal(run.claudeSettled, false);
    assert.equal(stopCalls, 1);
    assert.equal(persistedUnknownAtStop, true);
    await controller.complete(run);
    assert.equal(stopCalls, 1, "an unknown stop outcome cannot start a second killer");
    alive = false;
    releaseStop(true);
    for (let attempt = 0; attempt < 50 && completed === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed, 1);
    assert.equal(stopCalls, 1);
    assert.equal(run.claudeSettled, true);
    assert.equal(run.claudeStopUnknown, false);
  });
});

test("ClaudeRunController retries only a proven pre-effect stop-intent persistence failure", async () => {
  await withTempDir(async (directory) => {
    const fingerprint = { pid: 4331, creationTime: "owned" };
    const run = {
      turnId: "turn-stop-intent-retry",
      threadId: "session-stop-intent-retry",
      pid: fingerprint.pid,
      process: { pid: fingerprint.pid, exitCode: null, signalCode: null },
      claudeProcessFingerprint: fingerprint,
      claudeOwnedProcessTree: [fingerprint],
      claudeResult: { type: "result", result: "done", session_id: "session-stop-intent-retry" },
    };
    let alive = true;
    let persists = 0;
    let stops = 0;
    let completed = 0;
    const controller = new ClaudeRunController({
      dataDir: directory,
      completionExitGraceMs: 0,
      completionStopTimeoutMs: 100,
      processAlive: () => alive,
      processFingerprintLookup: async () => ({ ...fingerprint }),
      processTreeLookup: async () => (alive ? [{ ...fingerprint, parentPid: 1 }] : []),
      onPersist: async () => {
        persists += 1;
        if (persists === 1) throw new Error("injected pre-effect persistence failure");
      },
      stopProcess: async () => {
        stops += 1;
        alive = false;
        return true;
      },
      onComplete: async () => { completed += 1; },
    });

    await controller.complete(run);
    assert.equal(stops, 0, "no stop effect may precede durable intent");
    assert.equal(run.claudeStopUnknown, false);
    assert.equal(run.claudeStopAttempt, null);
    assert.equal(run.claudeCleanupPending, true);
    for (let attempt = 0; attempt < 50 && completed === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stops, 1);
    assert.equal(completed, 1);
    assert.equal(run.claudeStopUnknown, false);
  });
});

test("ClaudeRunController does not promote a sidecar PID without a closed lifetime or live ancestry", async () => {
  await withTempDir(async (directory) => {
    const ownerPath = path.join(directory, "turn.owner.json");
    await writeFile(ownerPath, JSON.stringify({
      token: "token",
      pid: 17,
      startedAtMs: Date.parse("2026-09-23T10:00:00.000Z"),
    }), "utf8");
    const foreign = {
      pid: 17,
      parentPid: 999,
      creationTime: "2026-09-23T11:00:00.000Z",
      executablePath: "foreign.exe",
      commandLine: "foreign",
    };
    const root = { pid: 10, parentPid: 1, creationTime: "2026-09-23T09:59:59.000Z" };
    const run = {
      pid: root.pid,
      claudeExited: false,
      claudeProcessFingerprint: root,
      claudeProcessOwnerPath: ownerPath,
      claudeProcessOwnerToken: "token",
      claudeOwnedProcessTree: [],
    };
    const stopped = [];
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: (pid) => pid === foreign.pid,
      processFingerprintLookup: async () => null,
      processTreeFingerprintLookup: async (pid) => (pid === foreign.pid ? foreign : null),
      processTreeLookup: async (rootFingerprint, known, options) => ownedProcessTreeFromSnapshot(
        rootFingerprint,
        known,
        [foreign],
        { ...options, platform: "win32" },
      ),
      stopProcess: async (pid) => { stopped.push(pid); return true; },
    });

    assert.equal(await controller.stop(run), false);
    assert.deepEqual(stopped, []);
    assert.equal(run.claudeOwnedProcessTree.some((item) => item.creationTime === foreign.creationTime), false);
  });
});

test("ClaudeRunController retains a launch-verified sidecar provider inside the durable root lifetime", async () => {
  await withTempDir(async (directory) => {
    const ownerPath = path.join(directory, "turn.owner.json");
    await writeFile(ownerPath, JSON.stringify({
      token: "token",
      pid: 18,
      startedAtMs: Date.parse("2026-09-23T10:00:00.000Z"),
    }), "utf8");
    const provider = {
      pid: 18,
      parentPid: 999,
      creationTime: "2026-09-23T10:00:00.500Z",
      executablePath: "claude.exe",
      commandLine: "claude",
    };
    const root = { pid: 11, parentPid: 1, creationTime: "2026-09-23T09:59:59.000Z" };
    const run = {
      pid: root.pid,
      claudeExited: true,
      claudeProcessStartedAtMs: Date.parse("2026-09-23T09:59:59.000Z"),
      claudeProcessExitedAtMs: Date.parse("2026-09-23T10:05:00.000Z"),
      claudeProcessFingerprint: root,
      claudeProcessOwnerPath: ownerPath,
      claudeProcessOwnerToken: "token",
      claudeOwnedProcessTree: [{ ...provider, launchLineageVerified: true }],
    };
    const stopped = [];
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: (pid) => pid === provider.pid,
      processFingerprintLookup: async () => null,
      processTreeFingerprintLookup: async (pid) => (pid === provider.pid ? provider : null),
      processTreeLookup: async (rootFingerprint, known, options) => ownedProcessTreeFromSnapshot(
        rootFingerprint,
        known,
        [provider],
        { ...options, platform: "win32" },
      ),
      stopProcess: async (pid) => { stopped.push(pid); return true; },
    });

    assert.equal(await controller.stop(run), true);
    assert.deepEqual(stopped, [provider.pid]);
  });
});

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function persistenceRetryFixture() {
  const fingerprint = { pid: 4341, creationTime: "owned" };
  const run = {
    turnId: "turn-stop-intent-backoff",
    threadId: "session-stop-intent-backoff",
    pid: fingerprint.pid,
    process: { pid: fingerprint.pid, exitCode: null, signalCode: null },
    claudeProcessFingerprint: fingerprint,
    claudeOwnedProcessTree: [fingerprint],
    claudeResult: { type: "result", result: "done", session_id: "session-stop-intent-backoff" },
  };
  const state = { alive: true, persists: 0, stops: 0, completed: 0, current: true };
  return { fingerprint, run, state };
}

test("ClaudeRunController keeps retrying repeated pre-effect intent failures until storage recovers", async () => {
  await withTempDir(async (directory) => {
    const { fingerprint, run, state } = persistenceRetryFixture();
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      completionExitGraceMs: 0,
      completionStopTimeoutMs: 100,
      isCurrentRun: () => state.current,
      processAlive: () => state.alive,
      processFingerprintLookup: async () => ({ ...fingerprint }),
      processTreeLookup: async () => (state.alive ? [{ ...fingerprint, parentPid: 1 }] : []),
      onPersist: async () => {
        state.persists += 1;
        if (state.persists <= 3) throw new Error("injected transient pre-effect persistence failure");
      },
      stopProcess: async () => {
        state.stops += 1;
        state.alive = false;
        return true;
      },
      onComplete: async () => { state.completed += 1; },
      onReadError: () => {},
    });

    await controller.complete(run);
    assert.equal(state.stops, 0, "no stop effect may precede durable intent");
    // No manual second completion: recovery must come from the controller's own retry.
    assert.equal(await waitUntil(() => state.completed === 1), true, "storage recovery must finish cleanup autonomously");
    state.current = false;
    controller.pause(run);
    assert.equal(state.stops, 1);
    assert.equal(run.claudeStopUnknown, false);
    assert.equal(run.claudeCleanupPending, false);
  });
});

test("ClaudeRunController keeps a permanent pre-effect intent failure fail-closed without any stop", async () => {
  await withTempDir(async (directory) => {
    const { fingerprint, run, state } = persistenceRetryFixture();
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      completionExitGraceMs: 0,
      completionStopTimeoutMs: 100,
      isCurrentRun: () => state.current,
      processAlive: () => state.alive,
      processFingerprintLookup: async () => ({ ...fingerprint }),
      processTreeLookup: async () => (state.alive ? [{ ...fingerprint, parentPid: 1 }] : []),
      onPersist: async () => {
        state.persists += 1;
        throw new Error("injected permanent persistence failure");
      },
      stopProcess: async () => { state.stops += 1; return true; },
      onComplete: async () => { state.completed += 1; },
      onReadError: () => {},
    });

    await controller.complete(run);
    assert.equal(await waitUntil(() => state.persists >= 6, 1_500), true, "retries continue past the first attempt");
    state.current = false;
    controller.pause(run);
    assert.equal(state.stops, 0);
    assert.equal(state.completed, 0);
    assert.equal(run.claudeCleanupPending, true);
    assert.equal(run.claudeStopUnknown, false);
  });
});

async function liveCaptureFixture(directory, { saveFailures = 0, permanentSaveFailure = false } = {}) {
  const ownerPath = path.join(directory, "turn.owner.json");
  const outputPath = path.join(directory, "turn.jsonl");
  await writeFile(outputPath, "", "utf8");
  await writeFile(ownerPath, JSON.stringify({
    token: "token",
    pid: 19,
    startedAtMs: Date.parse("2026-09-23T10:00:00.000Z"),
  }), "utf8");
  const root = {
    pid: 12,
    parentPid: 1,
    creationTime: "2026-09-23T09:59:59.000Z",
    executablePath: "node.exe",
    commandLine: "wrapper",
  };
  const provider = {
    pid: 19,
    parentPid: root.pid,
    creationTime: "2026-09-23T10:00:00.500Z",
    executablePath: "claude.exe",
    commandLine: "claude",
  };
  const run = {
    turnId: "turn-live-capture",
    threadId: "session-live-capture",
    pid: root.pid,
    process: { pid: root.pid, exitCode: null, signalCode: null },
    claudeExited: false,
    claudeOutputPath: outputPath,
    claudeReadOffset: 0,
    claudeProcessStartedAtMs: Date.parse("2026-09-23T09:59:59.000Z"),
    claudeProcessFingerprint: root,
    claudeProcessOwnerPath: ownerPath,
    claudeProcessOwnerToken: "token",
    claudeOwnedProcessTree: [root],
  };
  const serialize = (value) => JSON.stringify(value, (key, item) => (key === "process" ? undefined : item));
  // `saved` is the last durably persisted run, as a restarted Hub would restore it.
  const world = { snapshot: [root, provider], stopped: [], persisted: 0, persistCalls: 0, saved: serialize(run) };
  const byPid = () => new Map(world.snapshot.map((item) => [item.pid, item]));
  const makeController = () => new ClaudeRunController({
    dataDir: directory,
    pollIntervalMs: 60_000,
    processAlive: (pid) => byPid().has(pid),
    processFingerprintLookup: async (pid) => byPid().get(pid) ?? null,
    processTreeFingerprintLookup: async (pid) => byPid().get(pid) ?? null,
    processTreeLookup: async (rootFingerprint, known, options) => ownedProcessTreeFromSnapshot(
      rootFingerprint,
      known,
      world.snapshot,
      { ...options, platform: "win32" },
    ),
    stopProcess: async (pid) => {
      world.stopped.push(pid);
      world.snapshot = world.snapshot.filter((item) => item.pid !== pid);
      return true;
    },
    onPersist: async (value) => {
      world.persistCalls += 1;
      if (permanentSaveFailure || world.persistCalls <= saveFailures) throw new Error("injected run persistence failure");
      world.persisted += 1;
      world.saved = serialize(value);
    },
    onReadError: () => {},
  });
  const controller = makeController();
  // Root and wrapper exited later: only the orphaned provider remains visible.
  const orphan = (target = run) => {
    target.claudeExited = true;
    target.process = { pid: root.pid, exitCode: 0, signalCode: null };
    target.claudeProcessExitedAtMs = Date.parse("2026-09-23T10:05:00.000Z");
    return target;
  };
  const restartedRun = () => orphan(JSON.parse(world.saved));
  return { run, root, provider, world, controller, makeController, orphan, restartedRun };
}

test("ClaudeRunController captures provider lineage from a live poll and stops the later orphan", {
  skip: process.platform !== "win32",
}, async () => {
  await withTempDir(async (directory) => {
    const { run, provider, world, controller, orphan } = await liveCaptureFixture(directory);
    await controller.drain(run);
    controller.pause(run);
    const captured = run.claudeOwnedProcessTree.find((item) => item.pid === provider.pid);
    assert.equal(captured?.launchLineageVerified, true, "the ordinary poll captures live provider ancestry");
    assert.equal(captured?.creationTime, provider.creationTime);
    assert.ok(world.persisted >= 1, "captured lineage is persisted for restart recovery");

    orphan();
    world.snapshot = [provider];
    assert.equal(await controller.stop(run), true);
    assert.deepEqual(world.stopped, [provider.pid]);
  });
});

test("ClaudeRunController never stops a foreign PID reusing a captured provider inside the root lifetime", {
  skip: process.platform !== "win32",
}, async () => {
  await withTempDir(async (directory) => {
    const { run, provider, world, controller, orphan } = await liveCaptureFixture(directory);
    await controller.drain(run);
    controller.pause(run);
    assert.equal(run.claudeOwnedProcessTree.some((item) => item.launchLineageVerified === true), true);

    orphan();
    const foreign = {
      pid: provider.pid,
      parentPid: 999,
      creationTime: "2026-09-23T10:02:00.000Z",
      executablePath: "foreign.exe",
      commandLine: "foreign",
    };
    world.snapshot = [foreign];
    await controller.stop(run);
    assert.deepEqual(world.stopped, [], "a PID reused inside the lifetime window is not the captured provider");
  });
});

test("ClaudeRunController keeps saving a captured provider lineage until it is durable across restart", {
  skip: process.platform !== "win32",
}, async () => {
  await withTempDir(async (directory) => {
    const { run, provider, world, makeController, controller, restartedRun } = await liveCaptureFixture(directory, { saveFailures: 1 });
    await controller.drain(run);
    controller.pause(run);
    assert.equal(run.claudeOwnedProcessTree.some((item) => item.launchLineageVerified === true), true);
    assert.equal(world.persisted, 0, "the first durable save of the captured lineage failed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await controller.drain(run);
    controller.pause(run);
    assert.equal(world.persisted, 1, "a later ordinary poll saves the same captured identity");

    const restarted = restartedRun();
    world.snapshot = [provider];
    assert.equal(await makeController().stop(restarted), true);
    assert.deepEqual(world.stopped, [provider.pid], "the restarted run owns the exact orphan provider");
  });
});

test("ClaudeRunController keeps a never-saved provider lineage fail-closed after restart", {
  skip: process.platform !== "win32",
}, async () => {
  await withTempDir(async (directory) => {
    const { run, provider, world, makeController, controller, restartedRun } = await liveCaptureFixture(directory, { permanentSaveFailure: true });
    await controller.drain(run);
    controller.pause(run);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await controller.drain(run);
    controller.pause(run);
    assert.ok(world.persistCalls >= 2, "saving the captured lineage is retried");
    assert.equal(world.persisted, 0);

    const foreign = { pid: provider.pid, parentPid: 999, creationTime: "2026-09-23T10:02:00.000Z", executablePath: "foreign.exe", commandLine: "foreign" };
    world.snapshot = [foreign];
    await makeController().stop(restartedRun());
    assert.deepEqual(world.stopped, [], "without durable identity a reused PID is never stopped");
  });
});

test("ClaudeRunController retries a pre-effect intent rejection that lands after the stop deadline", async () => {
  await withTempDir(async (directory) => {
    const { fingerprint, run, state } = persistenceRetryFixture();
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      completionExitGraceMs: 0,
      completionStopTimeoutMs: 20,
      isCurrentRun: () => state.current,
      processAlive: () => state.alive,
      processFingerprintLookup: async () => ({ ...fingerprint }),
      processTreeLookup: async () => (state.alive ? [{ ...fingerprint, parentPid: 1 }] : []),
      onPersist: async () => {
        state.persists += 1;
        if (state.persists === 1) {
          // Rejects well after completionStopTimeoutMs, when complete() already returned.
          await new Promise((resolve) => setTimeout(resolve, 80));
          throw new Error("injected late pre-effect persistence failure");
        }
      },
      stopProcess: async () => {
        state.stops += 1;
        state.alive = false;
        return true;
      },
      onComplete: async () => { state.completed += 1; },
      onReadError: () => {},
    });

    await controller.complete(run);
    assert.equal(state.stops, 0);
    assert.equal(await waitUntil(() => state.completed === 1), true, "a late pre-effect rejection must not strand cleanup");
    state.current = false;
    controller.pause(run);
    assert.equal(state.stops, 1);
    assert.equal(run.claudeCleanupPending, false);
  });
});

test("ClaudeRunController never stops a live PID named only by an uncaptured sidecar lifetime", async () => {
  await withTempDir(async (directory) => {
    const ownerPath = path.join(directory, "turn.owner.json");
    await writeFile(ownerPath, JSON.stringify({
      token: "token",
      pid: 19,
      startedAtMs: Date.parse("2026-09-23T10:00:00.000Z"),
      exitedAtMs: Date.parse("2026-09-23T10:03:00.000Z"),
    }), "utf8");
    // Capture never happened; PID 19 now belongs to a foreign process created inside the window.
    const foreign = { pid: 19, parentPid: 999, creationTime: "2026-09-23T10:02:59.995Z", executablePath: "foreign.exe", commandLine: "foreign" };
    const root = { pid: 12, parentPid: 1, creationTime: "2026-09-23T09:59:59.000Z" };
    const run = {
      pid: root.pid,
      claudeExited: true,
      process: { pid: root.pid, exitCode: 0, signalCode: null },
      claudeProcessStartedAtMs: Date.parse("2026-09-23T09:59:59.000Z"),
      claudeProcessExitedAtMs: Date.parse("2026-09-23T10:05:00.000Z"),
      claudeProcessFingerprint: root,
      claudeProcessOwnerPath: ownerPath,
      claudeProcessOwnerToken: "token",
      claudeOwnedProcessTree: [root],
    };
    const stopped = [];
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: (pid) => pid === foreign.pid,
      processFingerprintLookup: async (pid) => (pid === foreign.pid ? foreign : null),
      processTreeFingerprintLookup: async (pid) => (pid === foreign.pid ? foreign : null),
      processTreeLookup: async (rootFingerprint, known, options) => ownedProcessTreeFromSnapshot(
        rootFingerprint, known, [foreign], { ...options, platform: "win32" },
      ),
      stopProcess: async (pid) => { stopped.push(pid); return true; },
      onReadError: () => {},
    });
    await controller.stop(run);
    assert.deepEqual(stopped, [], "a token and a creation time inside the lifetime never authorize a stop");
  });
});

test("ClaudeRunController never stops a prior PID holder's child through an uncaptured provider anchor", async () => {
  await withTempDir(async (directory) => {
    const ownerPath = path.join(directory, "turn.owner.json");
    await writeFile(ownerPath, JSON.stringify({
      token: "token",
      pid: 101,
      startedAtMs: Date.parse("2026-09-23T10:00:02.000Z"),
      exitedAtMs: Date.parse("2026-09-23T10:00:04.000Z"),
    }), "utf8");
    // Provider identity was never captured. PID 101 is held now; an earlier holder left a child inside the window.
    const currentHolder = { pid: 101, parentPid: 999, creationTime: "2026-09-23T10:00:03.995Z", executablePath: "foreign.exe", commandLine: "holder" };
    const priorHolderChild = { pid: 103, parentPid: 101, creationTime: "2026-09-23T10:00:03.000Z", executablePath: "foreign.exe", commandLine: "prior child" };
    const root = { pid: 12, parentPid: 1, creationTime: "2026-09-23T10:00:01.000Z" };
    const run = {
      pid: root.pid,
      claudeExited: true,
      process: { pid: root.pid, exitCode: 0, signalCode: null },
      claudeProcessStartedAtMs: Date.parse("2026-09-23T10:00:01.000Z"),
      claudeProcessExitedAtMs: Date.parse("2026-09-23T10:00:05.000Z"),
      claudeProcessFingerprint: root,
      claudeProcessOwnerPath: ownerPath,
      claudeProcessOwnerToken: "token",
      claudeOwnedProcessTree: [root],
    };
    const snapshot = [currentHolder, priorHolderChild];
    const byPid = new Map(snapshot.map((item) => [item.pid, item]));
    const stopped = [];
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: (pid) => byPid.has(pid),
      processFingerprintLookup: async (pid) => byPid.get(pid) ?? null,
      processTreeFingerprintLookup: async (pid) => byPid.get(pid) ?? null,
      processTreeLookup: async (rootFingerprint, known, options) => ownedProcessTreeFromSnapshot(
        rootFingerprint, known, snapshot, { ...options, platform: "win32" },
      ),
      stopProcess: async (pid) => { stopped.push(pid); return true; },
      onReadError: () => {},
    });
    await controller.stop(run);
    assert.deepEqual(stopped, [], "neither the current holder nor a prior holder's child is stopped");
  });
});

// Completion through complete(): the classifier decides each unknown child against
// the recorded lifetime and the current holder of a reused anchor PID (root or
// uncaptured provider).
function anchorCompletionFixture(directory, { known, snapshot, current = false, pollIntervalMs = 60_000 }) {
  const at = (seconds) => Date.parse(`2026-09-23T10:00:0${seconds}Z`);
  const root = { pid: 100, parentPid: 1, creationTime: "2026-09-23T10:00:01.000Z", executablePath: "node.exe", commandLine: "wrapper" };
  const run = {
    turnId: "turn-anchor-complete",
    threadId: "session-anchor-complete",
    pid: root.pid,
    process: { pid: root.pid, exitCode: 0, signalCode: null },
    claudeExited: true,
    claudeOutputPath: path.join(directory, "absent-output.jsonl"),
    claudeProcessStartedAtMs: at("1.000"),
    claudeProcessExitedAtMs: at("4.000"),
    claudeProcessFingerprint: root,
    claudeOwnedProcessTree: [root, ...known],
    claudeResult: { type: "result", result: "done", session_id: "session-anchor-complete" },
  };
  const state = { rows: [...snapshot], stopped: [], completed: 0, reads: 0, current };
  const find = (pid) => state.rows.find((item) => item.pid === pid) ?? null;
  const controller = new ClaudeRunController({
    dataDir: directory,
    pollIntervalMs,
    completionExitGraceMs: 0,
    completionStopTimeoutMs: 50,
    isCurrentRun: () => state.current,
    processAlive: (pid) => Boolean(find(pid)),
    processFingerprintLookup: async (pid) => find(pid),
    processTreeFingerprintLookup: async (pid) => find(pid),
    processTreeLookup: async (rootFingerprint, knownFingerprints, options) => {
      state.reads += 1;
      return ownedProcessTreeFromSnapshot(rootFingerprint, knownFingerprints, state.rows, { ...options, platform: "win32" });
    },
    stopProcess: async (pid) => {
      state.stopped.push(pid);
      state.rows = state.rows.filter((item) => item.pid !== pid);
      return true;
    },
    onComplete: async () => { state.completed += 1; },
    onReadError: () => {},
  });
  return { controller, run, state };
}

async function completeWithSnapshot(directory, options) {
  const { controller, run, state } = anchorCompletionFixture(directory, options);
  await controller.complete(run);
  return { run, stopped: state.stopped, completed: state.completed };
}

const reusedRootHolder = { pid: 100, parentPid: 999, creationTime: "2026-09-23T10:00:03.995Z", executablePath: "foreign.exe", commandLine: "holder" };

test("ClaudeRunController completion keeps a reused root with an earlier child unresolved", async () => {
  await withTempDir(async (directory) => {
    const priorChild = { pid: 103, parentPid: 100, creationTime: "2026-09-23T10:00:03.000Z", executablePath: "foreign.exe", commandLine: "prior child" };
    const { run, stopped, completed } = await completeWithSnapshot(directory, { known: [], snapshot: [reusedRootHolder, priorChild] });
    assert.deepEqual(stopped, []);
    assert.equal(completed, 0);
    assert.equal(run.claudeSettled, false);
    assert.equal(run.claudeCleanupPending, true);
  });
});

test("ClaudeRunController completion settles a reused root whose child is the holder's own", async () => {
  await withTempDir(async (directory) => {
    const holderChild = { pid: 103, parentPid: 100, creationTime: "2026-09-23T10:00:03.999Z", executablePath: "foreign.exe", commandLine: "holder child" };
    const { stopped, completed } = await completeWithSnapshot(directory, { known: [], snapshot: [reusedRootHolder, holderChild] });
    assert.deepEqual(stopped, []);
    assert.equal(completed, 1, "a proven-foreign child does not hold completion");
  });
});

test("ClaudeRunController completion stops only an exact captured orphan under a reused root", async () => {
  await withTempDir(async (directory) => {
    const exactOrphan = { pid: 104, parentPid: 100, creationTime: "2026-09-23T10:00:02.500Z", executablePath: "node.exe", commandLine: "worker" };
    const clean = await completeWithSnapshot(directory, { known: [exactOrphan], snapshot: [reusedRootHolder, exactOrphan] });
    assert.deepEqual(clean.stopped, [exactOrphan.pid]);
    assert.equal(clean.completed, 1);

    const priorChild = { pid: 103, parentPid: 100, creationTime: "2026-09-23T10:00:03.000Z", executablePath: "foreign.exe", commandLine: "prior child" };
    const mixed = await completeWithSnapshot(directory, { known: [exactOrphan], snapshot: [reusedRootHolder, exactOrphan, priorChild] });
    assert.deepEqual(mixed.stopped, [exactOrphan.pid], "only the exact target is stopped");
    assert.equal(mixed.completed, 0, "the remaining ambiguity is not a terminal success");
    assert.equal(mixed.run.claudeCleanupPending, true);
  });
});

test("ClaudeRunController completion keeps an occupied uncaptured provider anchor with an earlier child unresolved", async () => {
  await withTempDir(async (directory) => {
    const provider = { pid: 101, startedAtMs: Date.parse("2026-09-23T10:00:02.000Z"), exitedAtMs: Date.parse("2026-09-23T10:00:04.000Z") };
    const providerHolder = { pid: 101, parentPid: 999, creationTime: "2026-09-23T10:00:03.995Z", executablePath: "foreign.exe", commandLine: "holder" };
    const priorChild = { pid: 103, parentPid: 101, creationTime: "2026-09-23T10:00:03.000Z", executablePath: "foreign.exe", commandLine: "prior child" };
    const { run, stopped, completed } = await completeWithSnapshot(directory, { known: [provider], snapshot: [providerHolder, priorChild] });
    assert.deepEqual(stopped, []);
    assert.equal(completed, 0);
    assert.equal(run.claudeSettled, false);
    assert.equal(run.claudeCleanupPending, true);
  });
});

const lateRootHolder = { pid: 100, parentPid: 999, creationTime: "2026-09-23T10:00:06.000Z", executablePath: "foreign.exe", commandLine: "holder" };
const lateProviderHolder = { ...lateRootHolder, pid: 101 };
const providerLifetime = { pid: 101, startedAtMs: Date.parse("2026-09-23T10:00:02.000Z"), exitedAtMs: Date.parse("2026-09-23T10:00:04.000Z") };

test("ClaudeRunController completion excludes children outside a reused anchor's recorded lifetime", async () => {
  await withTempDir(async (directory) => {
    const afterRootExit = { pid: 103, parentPid: 100, creationTime: "2026-09-23T10:00:04.001Z", executablePath: "foreign.exe", commandLine: "late child" };
    const rootCase = await completeWithSnapshot(directory, { known: [], snapshot: [lateRootHolder, afterRootExit] });
    assert.deepEqual(rootCase.stopped, []);
    assert.equal(rootCase.completed, 1, "a child created after the recorded root exit is proven foreign");

    const afterProviderExit = { ...afterRootExit, pid: 102, parentPid: 101 };
    const providerCase = await completeWithSnapshot(directory, { known: [providerLifetime], snapshot: [lateProviderHolder, afterProviderExit] });
    assert.deepEqual(providerCase.stopped, []);
    assert.equal(providerCase.completed, 1, "a child created after the recorded provider exit is proven foreign");

    const exact = { pid: 104, parentPid: 101, creationTime: "2026-09-23T10:00:02.500Z", executablePath: "node.exe", commandLine: "worker" };
    const mixed = await completeWithSnapshot(directory, {
      known: [providerLifetime, exact],
      snapshot: [lateProviderHolder, exact, afterProviderExit],
    });
    assert.deepEqual(mixed.stopped, [exact.pid], "only the exact target is stopped");
    assert.equal(mixed.completed, 1, "an outside-lifetime child leaves no ambiguity after the exact target is gone");
  });
});

test("ClaudeRunController re-checks unresolved ownership on its own timer and completes once it clears", async () => {
  await withTempDir(async (directory) => {
    const priorChild = { pid: 103, parentPid: 101, creationTime: "2026-09-23T10:00:03.000Z", executablePath: "foreign.exe", commandLine: "prior child" };
    const { controller, run, state } = anchorCompletionFixture(directory, {
      known: [providerLifetime],
      snapshot: [lateProviderHolder, priorChild],
      current: true,
      pollIntervalMs: 5,
    });
    await controller.complete(run);
    assert.equal(state.completed, 0);
    assert.equal(run.claudeCleanupPending, true);
    assert.equal(run.claudeOwnershipDiagnostic, "ownership-unresolved:ambiguous-anchor:101:child=103");
    assert.ok(run.claudeDrainTimer, "an unresolved tree keeps one owner re-check scheduled");

    state.rows = state.rows.filter((item) => item.pid !== priorChild.pid);
    assert.equal(await waitUntil(() => state.completed === 1), true, "a cleared ambiguity completes without a manual complete");
    assert.deepEqual(state.stopped, [], "neither the holder nor the prior child is stopped");
    assert.equal(run.claudeCleanupPending, false);
    assert.equal(run.claudeDrainTimer, null);
  });
});

test("ClaudeRunController keeps permanent ambiguity pending with bounded re-checks and no stop", async () => {
  await withTempDir(async (directory) => {
    const priorChild = { pid: 103, parentPid: 100, creationTime: "2026-09-23T10:00:03.000Z", executablePath: "foreign.exe", commandLine: "prior child" };
    const { controller, run, state } = anchorCompletionFixture(directory, {
      known: [],
      snapshot: [lateRootHolder, priorChild],
      current: true,
      pollIntervalMs: 5,
    });
    await controller.complete(run);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Backoff 5, 10, 20, 40, 80 ms: a handful of re-checks, never a busy loop.
    assert.ok(state.reads >= 3 && state.reads <= 12, `bounded re-checks, got ${state.reads} reads`);
    assert.deepEqual(state.stopped, []);
    assert.equal(state.completed, 0);
    assert.equal(run.claudeSettled, false);
    assert.equal(run.claudeCleanupPending, true);
    state.current = false;
    controller.pause(run);
  });
});

test("ClaudeRunController re-checks a transient unavailable tree probe and completes once it recovers", async () => {
  await withTempDir(async (directory) => {
    const root = { pid: 100, creationTime: "2026-09-23T10:00:01.000Z" };
    const run = {
      turnId: "turn-transient-tree-probe",
      threadId: "session-transient-tree-probe",
      pid: root.pid,
      process: { pid: root.pid, exitCode: 0, signalCode: null },
      claudeExited: true,
      claudeOutputPath: path.join(directory, "absent-output.jsonl"),
      claudeProcessFingerprint: root,
      claudeOwnedProcessTree: [root],
      claudeResult: { type: "result", result: "done", session_id: "session-transient-tree-probe" },
    };
    const state = { available: false, completed: 0, reads: 0, current: true };
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      completionExitGraceMs: 0,
      isCurrentRun: () => state.current,
      processAlive: () => false,
      processFingerprintLookup: async () => null,
      processTreeLookup: async () => {
        state.reads += 1;
        return state.available ? [] : null;
      },
      onComplete: async () => { state.completed += 1; },
      onReadError: () => {},
    });

    await controller.complete(run);
    assert.equal(state.completed, 0);
    assert.equal(run.claudeCleanupPending, true);
    assert.equal(run.claudeOwnershipDiagnostic, "tree-probe-unavailable");
    assert.ok(run.claudeDrainTimer, "a transient probe failure keeps one owner re-check scheduled");

    state.available = true;
    assert.equal(await waitUntil(() => state.completed === 1), true);
    assert.equal(state.reads, 2);
    assert.equal(run.claudeCleanupPending, false);
    assert.equal(run.claudeDrainTimer, null);
  });
});

test("ClaudeRunController keeps a persistent tree probe error on bounded re-checks", async () => {
  await withTempDir(async (directory) => {
    const root = { pid: 100, creationTime: "2026-09-23T10:00:01.000Z" };
    const run = {
      turnId: "turn-persistent-tree-probe",
      threadId: "session-persistent-tree-probe",
      pid: root.pid,
      process: { pid: root.pid, exitCode: 0, signalCode: null },
      claudeExited: true,
      claudeOutputPath: path.join(directory, "absent-output.jsonl"),
      claudeProcessFingerprint: root,
      claudeOwnedProcessTree: [root],
      claudeResult: { type: "result", result: "done", session_id: "session-persistent-tree-probe" },
    };
    const state = { completed: 0, reads: 0, current: true };
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      completionExitGraceMs: 0,
      isCurrentRun: () => state.current,
      processAlive: () => false,
      processTreeLookup: async () => {
        state.reads += 1;
        throw new Error("injected process table failure");
      },
      onComplete: async () => { state.completed += 1; },
      onReadError: () => {},
    });

    await controller.complete(run);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(state.reads >= 3 && state.reads <= 12, `bounded re-checks, got ${state.reads} reads`);
    assert.equal(state.completed, 0);
    assert.equal(run.claudeSettled, false);
    assert.equal(run.claudeCleanupPending, true);
    assert.match(run.claudeOwnershipDiagnostic, /^tree-probe-error:/);
    state.current = false;
    controller.pause(run);
  });
});

test("ClaudeRunController re-check after an exact stop never dispatches a second stop", async () => {
  await withTempDir(async (directory) => {
    const exact = { pid: 104, parentPid: 101, creationTime: "2026-09-23T10:00:02.500Z", executablePath: "node.exe", commandLine: "worker" };
    const priorChild = { pid: 103, parentPid: 101, creationTime: "2026-09-23T10:00:03.000Z", executablePath: "foreign.exe", commandLine: "prior child" };
    const { controller, run, state } = anchorCompletionFixture(directory, {
      known: [providerLifetime, exact],
      snapshot: [lateProviderHolder, exact, priorChild],
      current: true,
      pollIntervalMs: 5,
    });
    await controller.complete(run);
    assert.deepEqual(state.stopped, [exact.pid]);
    assert.equal(state.completed, 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(state.stopped, [exact.pid], "re-checks do not stop again");

    state.rows = state.rows.filter((item) => item.pid !== priorChild.pid);
    assert.equal(await waitUntil(() => state.completed === 1), true);
    assert.deepEqual(state.stopped, [exact.pid]);
  });
});

test("ClaudeRunController gives a naturally exiting provider a bounded graceful window", async () => {
  await withTempDir(async (directory) => {
    const marker = path.join(directory, "provider-finalized.txt");
    const run = { turnId: "turn-graceful", threadId: "session-graceful" };
    let stops = 0;
    let resolveCompletion;
    const completed = new Promise((resolve) => { resolveCompletion = resolve; });
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      completionExitGraceMs: 1_500,
      stopProcess: async () => { stops += 1; return true; },
      onComplete: (_run, value) => resolveCompletion(value),
    });
    const payload = JSON.stringify({ type: "result", result: "done", session_id: run.threadId });
    await controller.start(run, {
      command: process.execPath,
      args: ["-e", [
        `process.stdout.write(${JSON.stringify(`${payload}\n`)});`,
        `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"done"),300);`,
      ].join("")],
      cwd: directory,
      env: process.env,
    });
    await completed;
    assert.equal(await readFile(marker, "utf8"), "done");
    assert.equal(stops, 0);
  });
});

test("ClaudeRunController retries a transient fingerprint gap when reattaching", async () => {
  await withTempDir(async (directory) => {
    const fingerprint = { pid: 4325, creationTime: "known-start" };
    const outputPath = path.join(directory, "turn.jsonl");
    await writeFile(outputPath, "", "utf8");
    const run = {
      turnId: "turn-retry-fingerprint",
      threadId: "session-retry-fingerprint",
      pid: fingerprint.pid,
      claudeOutputPath: outputPath,
      claudeProcessFingerprint: fingerprint,
    };
    let calls = 0;
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 60_000,
      processAlive: () => true,
      processFingerprintLookup: async () => {
        calls += 1;
        return calls === 1 ? null : { ...fingerprint };
      },
    });
    assert.equal(await controller.attachAfterRestart(run), true);
    assert.equal(calls, 2);
    controller.pause(run);
  });
});

test("ClaudeRunController cancels only a process with the saved fingerprint", async () => {
  await withTempDir(async (directory) => {
    const fingerprint = {
      pid: 4323,
      creationTime: "2026-07-30T10:00:00.000Z",
      executablePath: "C:\\Claude\\claude.exe",
      commandLine: "claude --resume session-owned",
    };
    const run = {
      turnId: "turn-owned",
      threadId: "session-owned",
      pid: fingerprint.pid,
      claudeProcessFingerprint: fingerprint,
    };
    const stopped = [];
    const controller = new ClaudeRunController({
      dataDir: directory,
      processAlive: () => true,
      processFingerprintLookup: async () => ({ ...fingerprint }),
      processTreeFingerprintLookup: async () => ({ ...fingerprint }),
      stopProcess: async (pid) => {
        stopped.push(pid);
        return true;
      },
    });

    assert.equal(await controller.stop(run), true);
    assert.deepEqual(stopped, [4323]);
  });
});

test("ClaudeRunController preserves stderr when Claude also returns an error result", async () => {
  await withTempDir(async (directory) => {
    let resolveCompletion;
    const completed = new Promise((resolve) => { resolveCompletion = resolve; });
    const run = { turnId: "turn-error", threadId: "session-error" };
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      isCurrentRun: (candidate) => candidate === run,
      onComplete: (_run, value) => resolveCompletion(value),
    });
    const payload = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      result: "",
      is_error: true,
      session_id: "session-error",
      usage: {},
    });
    await controller.start(run, {
      command: process.execPath,
      args: ["-e", [
        `process.stdout.write(${JSON.stringify(`${payload}\n`)});`,
        "process.stderr.write('resume failed in nested cwd');",
        "process.exitCode = 1;",
      ].join("")],
      cwd: directory,
      env: process.env,
    });
    const completion = await completed;
    assert.equal(completion.result.is_error, true);
    assert.equal(completion.errorText, "resume failed in nested cwd");
  });
});
