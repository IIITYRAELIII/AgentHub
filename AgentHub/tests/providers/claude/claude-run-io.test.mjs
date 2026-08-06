import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ClaudeOutputReader,
  claudeRunDirectory,
  claudeRunErrorPath,
  claudeRunOutputPath,
  cleanupOrphanedClaudeRunOutputs,
  openClaudeRunOutput,
  processFingerprintMatches,
  processIsAlive,
  readProcessFingerprint,
  removeClaudeRunOutput,
  spawnClaudeWorker,
  stopProcessTree,
} from "../../../src/providers/claude/claude-run-io.mjs";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-run-io-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("run output paths live in a dedicated directory", () => {
  assert.equal(
    claudeRunOutputPath(path.join("C:", "data"), "turn-1"),
    path.join("C:", "data", "claude-runs", "turn-1.jsonl"),
  );
  assert.equal(
    claudeRunErrorPath(path.join("C:", "data"), "turn-1"),
    path.join("C:", "data", "claude-runs", "turn-1.err.log"),
  );
});

test("openClaudeRunOutput creates writable handles and removal cleans them up", async () => {
  await withTempDir(async (directory) => {
    const output = await openClaudeRunOutput(directory, "turn-2");
    await output.outputHandle.write("{\"type\":\"result\"}\n");
    await Promise.all([output.outputHandle.close(), output.errorHandle.close()]);
    const reader = new ClaudeOutputReader(output.outputPath);
    assert.deepEqual(await reader.read(), ["{\"type\":\"result\"}"]);
    await removeClaudeRunOutput(output);
    assert.deepEqual(await new ClaudeOutputReader(output.outputPath).read(), []);
  });
});

test("reader returns only complete lines and keeps a split tail", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "turn.jsonl");
    await writeFile(file, "{\"a\":1}\n{\"b\":2}\n{\"c\":", "utf8");
    const reader = new ClaudeOutputReader(file);
    assert.deepEqual(await reader.read(), ["{\"a\":1}", "{\"b\":2}"]);
    assert.deepEqual(await reader.read(), []);
    await appendFile(file, "3}\n", "utf8");
    assert.deepEqual(await reader.read(), ["{\"c\":3}"]);
  });
});

test("reader preserves UTF-8 characters split between polling reads", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "turn.jsonl");
    const expected = '{"text":"🙂 проверка"}';
    const bytes = Buffer.from(`${expected}\n`, "utf8");
    const emojiStart = bytes.indexOf(Buffer.from("🙂", "utf8"));
    const splitAt = emojiStart + 2;
    await writeFile(file, bytes.subarray(0, splitAt));
    const reader = new ClaudeOutputReader(file);
    assert.deepEqual(await reader.read(), []);
    await appendFile(file, bytes.subarray(splitAt));
    assert.deepEqual(await reader.read(), [expected]);
  });
});

test("reader resumes from a saved offset after a bot restart", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "turn.jsonl");
    await writeFile(file, "первая\nвторая\n", "utf8");
    const before = new ClaudeOutputReader(file);
    assert.deepEqual(await before.read(), ["первая", "вторая"]);
    await appendFile(file, "третья\n", "utf8");
    const after = new ClaudeOutputReader(file, { offset: before.offset });
    assert.deepEqual(await after.read(), ["третья"]);
  });
});

test("reader restarts from the beginning when the file was recreated", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "turn.jsonl");
    await writeFile(file, "старая\nстрока\n", "utf8");
    const reader = new ClaudeOutputReader(file);
    await reader.read();
    await writeFile(file, "новая\n", "utf8");
    assert.deepEqual(await reader.read(), ["новая"]);
  });
});

test("reader tolerates a missing file", async () => {
  await withTempDir(async (directory) => {
    assert.deepEqual(await new ClaudeOutputReader(path.join(directory, "нет.jsonl")).read(), []);
  });
});

test("spawn failure reaches the handler instead of crashing the bot", async () => {
  await withTempDir(async (directory) => {
    const output = await openClaudeRunOutput(directory, "turn-spawn");
    const missing = path.join(directory, "definitely-missing-cli.exe");
    const failure = new Promise((resolve) => {
      spawnClaudeWorker({
        command: missing,
        args: [],
        cwd: directory,
        stdout: output.outputHandle.fd,
        stderr: output.errorHandle.fd,
        onError: resolve,
      });
    });
    // Настоящее файловое ожидание между запуском и проверкой: именно оно
    // раньше пропускало событие ошибки мимо обработчика.
    await Promise.all([output.outputHandle.close(), output.errorHandle.close()]);
    const error = await failure;
    assert.equal(error.code, "ENOENT");
  });
});

test("startup cleanup removes only files not owned by restored Claude runs", async () => {
  await withTempDir(async (directory) => {
    const runs = claudeRunDirectory(directory);
    await mkdir(runs, { recursive: true });
    const active = claudeRunOutputPath(directory, "active");
    const activeError = claudeRunErrorPath(directory, "active");
    const orphan = claudeRunOutputPath(directory, "orphan");
    const orphanError = claudeRunErrorPath(directory, "orphan");
    await Promise.all([
      writeFile(active, "active", "utf8"),
      writeFile(activeError, "active error", "utf8"),
      writeFile(orphan, "orphan", "utf8"),
      writeFile(orphanError, "orphan error", "utf8"),
      writeFile(path.join(runs, "keep.txt"), "unrelated", "utf8"),
    ]);
    const removed = await cleanupOrphanedClaudeRunOutputs(directory, [active, activeError]);
    assert.deepEqual(removed.map((file) => path.basename(file)).sort(), ["orphan.err.log", "orphan.jsonl"]);
    assert.deepEqual((await readdir(runs)).sort(), ["active.err.log", "active.jsonl", "keep.txt"]);
  });
});

test("Windows process-tree stop uses taskkill with descendants and force", async () => {
  const killer = new EventEmitter();
  let detached = false;
  killer.unref = () => { detached = true; };
  let invocation = null;
  const stopped = stopProcessTree(4321, {
    platform: "win32",
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      queueMicrotask(() => killer.emit("exit", 0));
      return killer;
    },
  });
  assert.equal(await stopped, true);
  assert.deepEqual(invocation, {
    command: "taskkill.exe",
    args: ["/PID", "4321", "/T", "/F"],
    options: { windowsHide: true, stdio: "ignore" },
  });
  assert.equal(detached, false,
    "the awaited taskkill process must keep Node alive until it reports an exit");
});

test("Windows process-tree stop falls back to the root when taskkill fails", async () => {
  const killer = new EventEmitter();
  killer.unref = () => {};
  const signals = [];
  const stopped = stopProcessTree(4322, {
    platform: "win32",
    spawnImpl: () => {
      queueMicrotask(() => killer.emit("exit", 1));
      return killer;
    },
    killImpl: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  assert.equal(await stopped, true);
  assert.deepEqual(signals, [[4322, 0], [4322, "SIGTERM"]]);
});

test("processIsAlive recognizes the current process and rejects invalid ids", () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(null), false);
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(-1), false);
  assert.equal(processIsAlive("не число"), false);
  assert.equal(processIsAlive(123, () => {
    const error = new Error("denied");
    error.code = "EPERM";
    throw error;
  }), true);
});

test("process fingerprint requires creation time and compares available identity fields", () => {
  const saved = {
    pid: 123,
    creationTime: "2026-07-30T10:00:00.000Z",
    executablePath: "C:\\Tools\\Claude.exe",
    commandLine: "claude --resume session-1",
  };
  assert.equal(processFingerprintMatches(saved, {
    ...saved,
    executablePath: "c:\\tools\\claude.exe",
  }, { platform: "win32" }), true);
  assert.equal(processFingerprintMatches(saved, {
    ...saved,
    creationTime: "2026-07-30T10:01:00.000Z",
  }, { platform: "win32" }), false);
  assert.equal(processFingerprintMatches(saved, {
    ...saved,
    commandLine: "claude --resume another-session",
  }, { platform: "win32" }), false);
  assert.equal(processFingerprintMatches(saved, {
    pid: saved.pid,
    creationTime: saved.creationTime,
  }, { platform: "win32" }), false);
});

test("Windows fingerprint lookup parses creation time, executable and command line", async () => {
  const calls = [];
  const fingerprint = await readProcessFingerprint(777, {
    platform: "win32",
    captureCommandImpl: async (command, args) => {
      calls.push({ command, args });
      return JSON.stringify({
        pid: 777,
        creationTime: "2026-07-30T10:00:00.0000000Z",
        executablePath: "C:\\Program Files\\Claude\\claude.exe",
        commandLine: "\"C:\\Program Files\\Claude\\claude.exe\" --resume session-1",
      });
    },
  });
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(fingerprint, {
    pid: 777,
    creationTime: "2026-07-30T10:00:00.0000000Z",
    executablePath: "C:\\Program Files\\Claude\\claude.exe",
    commandLine: "\"C:\\Program Files\\Claude\\claude.exe\" --resume session-1",
  });
});

test("unsupported process fingerprint lookup fails safe", async () => {
  assert.equal(await readProcessFingerprint(777, { platform: "unsupported-os" }), null);
});
