import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeRunController } from "../../../src/providers/claude/claude-run-controller.mjs";

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
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 60_000,
      processAlive: () => true,
      processFingerprintLookup: async () => null,
      stopProcess: async () => false,
      onReadError: (_run, error) => errors.push(error.message),
      onComplete: async () => { completed += 1; },
    });
    await controller.complete(run);
    controller.pause(run);
    assert.equal(run.claudeSettled, false);
    assert.equal(run.claudeCleanupPending, true);
    assert.equal(run.process, processHandle);
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
