import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const controller = new ClaudeRunController({
      dataDir: directory,
      isCurrentRun: (candidate) => candidate === run,
      onComplete: (_run, value) => { completion = value; },
      processFingerprintLookup: async () => ({ ...run.claudeProcessFingerprint }),
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
