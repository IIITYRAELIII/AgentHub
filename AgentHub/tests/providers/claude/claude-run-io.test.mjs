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
  claudeRunOwnerPath,
  claudeRunOutputPath,
  cleanupOrphanedClaudeRunOutputs,
  openClaudeRunOutput,
  ownedProcessTreeFromSnapshot,
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
    const activeOwner = claudeRunOwnerPath(directory, "active");
    const orphan = claudeRunOutputPath(directory, "orphan");
    const orphanError = claudeRunErrorPath(directory, "orphan");
    const orphanOwner = claudeRunOwnerPath(directory, "orphan");
    await Promise.all([
      writeFile(active, "active", "utf8"),
      writeFile(activeError, "active error", "utf8"),
      writeFile(activeOwner, "active owner", "utf8"),
      writeFile(orphan, "orphan", "utf8"),
      writeFile(orphanError, "orphan error", "utf8"),
      writeFile(orphanOwner, "orphan owner", "utf8"),
      writeFile(path.join(runs, "keep.txt"), "unrelated", "utf8"),
    ]);
    const removed = await cleanupOrphanedClaudeRunOutputs(directory, [active, activeError, activeOwner]);
    assert.deepEqual(removed.map((file) => path.basename(file)).sort(), [
      "orphan.err.log",
      "orphan.jsonl",
      "orphan.owner.json",
    ]);
    assert.deepEqual((await readdir(runs)).sort(), [
      "active.err.log",
      "active.jsonl",
      "active.owner.json",
      "keep.txt",
    ]);
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

test("Windows process-tree stop bounds a taskkill helper which never settles", async () => {
  const killer = new EventEmitter();
  let killed = 0;
  killer.kill = () => { killed += 1; };
  const started = Date.now();
  assert.equal(await stopProcessTree(4328, {
    platform: "win32",
    spawnImpl: () => killer,
    timeoutMs: 20,
  }), false);
  assert.ok(Date.now() - started < 500);
  assert.equal(killed, 1);
});

test("POSIX process stop can target one exact non-group-leader PID", async () => {
  const signals = [];
  assert.equal(await stopProcessTree(4329, {
    platform: "linux",
    processGroup: false,
    killImpl: (pid, signal) => { signals.push([pid, signal]); },
  }), true);
  assert.deepEqual(signals, [[4329, "SIGTERM"]]);
});

test("owned process-tree discovery survives root exit and rejects a reused root PID", () => {
  const root = {
    pid: 100,
    creationTime: "2026-01-01T00:00:00.000Z",
    executablePath: "claude",
    commandLine: "claude",
    startedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    exitedAtMs: Date.parse("2026-01-01T00:00:03.000Z"),
  };
  const descendant = { pid: 102, parentPid: 100, creationTime: "2026-01-01T00:00:01.000Z", executablePath: "node", commandLine: "worker" };
  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [root], [descendant], {
    platform: "win32",
    rootExited: true,
  }), [descendant]);
  assert.equal(ownedProcessTreeFromSnapshot(
    { ...root, startedAtMs: undefined, exitedAtMs: undefined },
    [],
    [{ ...descendant, creationTime: "2026-01-01T01:00:00.000Z" }],
    { platform: "win32", rootExited: true },
  ), null, "a disappeared root without a lifetime leaves its unknown child unresolved, not an empty tree");
  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [], [{
    ...descendant,
    creationTime: "2026-01-01T00:00:04.000Z",
  }], { platform: "win32", rootExited: true }), [], "a child created after the root exit is foreign");
  assert.equal(ownedProcessTreeFromSnapshot(root, [root], [
    { ...root, parentPid: 1, creationTime: "root-two" },
    descendant,
  ], { platform: "win32" }), null);
  // The root PID is held again: a child created before the current holder may
  // still belong to an earlier foreign holder, so ancestry through the root is
  // unresolved rather than owned or an empty terminal tree.
  const reusedRootHolder = { ...root, parentPid: 1, creationTime: "2026-01-01T00:00:02.000Z" };
  assert.equal(ownedProcessTreeFromSnapshot(root, [], [reusedRootHolder, descendant], {
    platform: "win32",
    rootExited: true,
  }), null);
  // A child created at or after the current holder was spawned by that holder:
  // it is proven foreign, so the tree is truthfully empty.
  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [], [reusedRootHolder, {
    ...descendant,
    creationTime: "2026-01-01T00:00:02.500Z",
  }], { platform: "win32", rootExited: true }), []);
  // A descendant captured earlier with its exact fingerprint is still owned.
  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [descendant], [reusedRootHolder, descendant], {
    platform: "win32",
    rootExited: true,
  }), [descendant]);
});

test("owned process-tree discovery crosses one exited verified provider anchor", () => {
  const root = { pid: 100, creationTime: "root-one", executablePath: "node", commandLine: "wrapper" };
  const provider = { pid: 101, startedAtMs: Date.parse("2026-01-01T00:00:01.000Z"), exitedAtMs: Date.parse("2026-01-01T00:00:03.000Z") };
  const descendant = { pid: 102, parentPid: 101, creationTime: "2026-01-01T00:00:02.000Z", executablePath: "node", commandLine: "worker" };
  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [root, provider], [descendant], {
    platform: "win32",
    rootExited: true,
  }), [descendant]);
  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [root, provider], [{
    ...descendant,
    creationTime: "2026-01-01T00:00:08.000Z",
  }], { platform: "win32", rootExited: true }), []);
  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [root, {
    pid: 101,
    startedAtMs: provider.startedAtMs,
  }], [descendant], { platform: "win32", rootExited: true }), [],
  "a missing exit bound cannot authorize a historical PID anchor");
  assert.equal(claudeRunOwnerPath("data", "turn"), path.join("data", "claude-runs", "turn.owner.json"));
});

test("an occupied uncaptured provider anchor decides each unknown child against the current holder", () => {
  const root = { pid: 100, creationTime: "root-one", executablePath: "node", commandLine: "wrapper" };
  // Recorded window 2.000..4.000 s; the exit time is written after the real exit.
  const provider = { pid: 101, startedAtMs: Date.parse("2026-01-01T00:00:02.000Z"), exitedAtMs: Date.parse("2026-01-01T00:00:04.000Z") };
  const options = { platform: "win32", rootExited: true };
  const currentHolder = { pid: 101, parentPid: 999, creationTime: "2026-01-01T00:00:03.995Z", executablePath: "foreign.exe", commandLine: "holder" };
  const holderChild = { pid: 102, parentPid: 101, creationTime: "2026-01-01T00:00:03.999Z", executablePath: "foreign.exe", commandLine: "holder child" };
  // An earlier foreign holder reused PID 101, spawned this child and exited before the current holder appeared.
  const priorHolderChild = { pid: 103, parentPid: 101, creationTime: "2026-01-01T00:00:03.000Z", executablePath: "foreign.exe", commandLine: "prior child" };

  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [root, provider], [currentHolder, holderChild], options), [],
    "A: a child created after the current holder is that holder's child and is proven foreign");
  assert.equal(ownedProcessTreeFromSnapshot(root, [root, provider], [currentHolder, priorHolderChild], options), null,
    "B: a child created before the current holder has no provable ancestry and leaves the tree unresolved");
  assert.equal(ownedProcessTreeFromSnapshot(root, [root, provider], [{ ...currentHolder, creationTime: "" }, holderChild], options), null,
    "without the holder creation time a reachable unknown child is unresolved");

  // A descendant captured earlier with its exact fingerprint is owned on its own identity.
  const capturedDescendant = { pid: 104, parentPid: 101, creationTime: "2026-01-01T00:00:02.500Z", executablePath: "node", commandLine: "worker" };
  const exactOnly = ownedProcessTreeFromSnapshot(root, [root, provider, capturedDescendant], [currentHolder, holderChild, capturedDescendant], options);
  assert.deepEqual(exactOnly, [capturedDescendant]);
  assert.notEqual(exactOnly.unresolved, true);
  // Mixed exact and ambiguous children: only the exact target is actionable and the tree stays unresolved.
  const mixed = ownedProcessTreeFromSnapshot(root, [root, provider, capturedDescendant], [currentHolder, priorHolderChild, capturedDescendant], options);
  assert.deepEqual(mixed, [capturedDescendant]);
  assert.equal(mixed.unresolved, true);
  assert.equal(ownedProcessTreeFromSnapshot(root, [root, provider, capturedDescendant], [currentHolder, priorHolderChild], options), null,
    "after the exact target is gone the ambiguity remains unresolved");

  // With the PID absent the closed lifetime still anchors descendants created inside it.
  const descendant = { pid: 105, parentPid: 101, creationTime: "2026-01-01T00:00:03.000Z", executablePath: "node", commandLine: "worker" };
  assert.deepEqual(ownedProcessTreeFromSnapshot(root, [root, provider], [descendant], options), [descendant]);
});

test("an occupied anchor resolves unknown children by its recorded lifetime first", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (ms) => new Date(base + ms).toISOString();
  const child = (pid, parentPid, ms) => ({
    pid,
    parentPid,
    creationTime: ms === null ? "not-a-time" : at(ms),
    executablePath: "foreign.exe",
    commandLine: "child",
  });
  const options = { platform: "win32", rootExited: true };
  // Root lifetime 1.000..4.000 s, provider 2.000..4.000 s; each PID is held by a holder created at 6.000 s.
  const root = { pid: 100, creationTime: at(1000), executablePath: "node", commandLine: "wrapper", startedAtMs: base + 1000, exitedAtMs: base + 4000 };
  const provider = { pid: 101, startedAtMs: base + 2000, exitedAtMs: base + 4000 };
  const rootHolder = { pid: 100, parentPid: 999, creationTime: at(6000), executablePath: "foreign.exe", commandLine: "holder" };
  const providerRoot = { ...root, exitedAtMs: base + 8000 };
  const providerHolder = { ...rootHolder, pid: 101 };
  const cases = [
    { name: "root", anchorRoot: root, known: [root], holder: rootHolder, anchorPid: 100, startedAt: 1000 },
    { name: "provider", anchorRoot: providerRoot, known: [providerRoot, provider], holder: providerHolder, anchorPid: 101, startedAt: 2000 },
  ];
  for (const { name, anchorRoot, known, holder, anchorPid, startedAt } of cases) {
    const classify = (ms, holderRow = holder) => ownedProcessTreeFromSnapshot(
      anchorRoot, known, [holderRow, child(102, anchorPid, ms)], options,
    );
    assert.equal(classify(startedAt - 1000), null, `${name}: the start tolerance edge is inside the lifetime`);
    assert.deepEqual(classify(startedAt - 1001), [], `${name}: before the start tolerance is proven foreign`);
    assert.equal(classify(4000), null, `${name}: the recorded exit edge is inside the lifetime`);
    assert.deepEqual(classify(4001), [], `${name}: after the recorded exit is proven foreign`);
    assert.equal(classify(null), null, `${name}: a malformed child time is unresolved, not outside`);
    assert.equal(classify(3000, { ...holder, creationTime: "" }), null, `${name}: an unknown holder time leaves an inside child unresolved`);
    const diagnostics = {};
    ownedProcessTreeFromSnapshot(anchorRoot, known, [holder, child(102, anchorPid, 3000)], { ...options, diagnostics });
    assert.equal(diagnostics.unresolved, `ambiguous-anchor:${anchorPid}:child=102`);
  }
  const exact = { pid: 104, parentPid: 101, creationTime: at(2500), executablePath: "node", commandLine: "worker" };
  const withOutside = ownedProcessTreeFromSnapshot(providerRoot, [providerRoot, provider, exact], [providerHolder, exact, child(102, 101, 4001)], options);
  assert.deepEqual(withOutside, [exact]);
  assert.notEqual(withOutside.unresolved, true, "an outside child adds no ambiguity to an exact target");
  const withInside = ownedProcessTreeFromSnapshot(providerRoot, [providerRoot, provider, exact], [providerHolder, exact, child(102, 101, 3000)], options);
  assert.deepEqual(withInside, [exact]);
  assert.equal(withInside.unresolved, true);

  // An exited root without a recorded lifetime fails closed with an explicit reason.
  const diagnostics = {};
  assert.equal(ownedProcessTreeFromSnapshot({ ...root, startedAtMs: undefined, exitedAtMs: undefined }, [], [child(102, 100, 9000)], {
    ...options,
    diagnostics,
  }), null);
  assert.equal(diagnostics.unresolved, "anchor-lifetime-missing:100:child=102");
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
