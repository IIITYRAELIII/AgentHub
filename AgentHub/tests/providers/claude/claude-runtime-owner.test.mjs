import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import {
  CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  ClaudeRunAdmissionGate,
  ClaudeRuntimeOwner,
  claudeExternalRuntimeState,
  claudeSessionProcessState,
  readWindowsClaudeProcessSnapshot,
  resetClaudeRuntimeOwnerCache,
} from "../../../src/providers/claude/claude-runtime-owner.mjs";

const execFileAsync = promisify(execFile);

function inventory(generation, owners = [], overrides = {}) {
  return {
    complete: true,
    generation,
    scannedAt: "2026-09-05T08:00:00.000Z",
    owners,
    unreadableCandidateCount: 0,
    ...overrides,
  };
}

function fakeSpawn(produce) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => produce(child));
    return child;
  };
}

test("Claude runtime owner uses exact complete process evidence", async () => {
  resetClaudeRuntimeOwnerCache();
  assert.deepEqual(claudeSessionProcessState(inventory(1, [
    { pid: 77, sessionId: "session-a" },
    { pid: 88, sessionId: "session-b" },
  ]), { sessionId: "session-b", agentHubPid: 77 }), {
    hasLiveProcess: true,
    known: true,
    complete: true,
    owners: [{ pid: 88, sessionId: "session-b" }],
  });
  const absent = await claudeExternalRuntimeState({ sessionId: "session-absent" }, {
    platform: "win32",
    agentHubPid: 77,
    probe: async ({ generation }) => inventory(generation),
  });
  assert.equal(absent.hasLiveProcess, false);
  assert.equal(absent.known, true);
  assert.equal(absent.complete, true);
});

test("Claude runtime owner fails closed for incomplete and non-Windows evidence", async () => {
  const owner = new ClaudeRuntimeOwner({
    platform: "win32",
    probe: async ({ generation }) => inventory(generation, [], {
      complete: false,
      unreadableCandidateCount: 1,
    }),
  });
  const failed = await owner.state({ sessionId: "session-failed" });
  assert.equal(failed.known, false);
  assert.equal(failed.hasLiveProcess, true);
  assert.equal(failed.unreadableCandidateCount, 1);

  assert.deepEqual(await new ClaudeRuntimeOwner({ platform: "linux" }).state({
    sessionId: "session-other-os",
  }), { known: false, hasLiveProcess: true, complete: false });
});

test("Claude runtime owner coalesces one global cadence scan for many sessions", async () => {
  let probeCalls = 0;
  let release;
  const owner = new ClaudeRuntimeOwner({
    platform: "win32",
    now: () => 1_000,
    probe: ({ generation }) => {
      probeCalls += 1;
      return new Promise((resolve) => {
        release = () => resolve(inventory(generation, [
          { pid: 101, sessionId: "session-a" },
        ]));
      });
    },
  });
  const reads = Array.from({ length: 100 }, (_, index) => owner.state({
    sessionId: index === 0 ? "session-a" : `session-${index}`,
  }));
  assert.equal(probeCalls, 1);
  release();
  const [active, ...absent] = await Promise.all(reads);
  assert.equal(active.hasLiveProcess, true);
  assert.equal(absent.every((entry) => entry.hasLiveProcess === false), true);
});

test("fresh launch authority never reuses a cached negative snapshot", async () => {
  let now = 1_000;
  let processAppeared = false;
  let probeCalls = 0;
  const owner = new ClaudeRuntimeOwner({
    platform: "win32",
    now: () => now,
    probe: async ({ generation }) => {
      probeCalls += 1;
      return inventory(generation, processAppeared
        ? [{ pid: 202, sessionId: "session-race" }]
        : []);
    },
  });
  assert.equal((await owner.state({ sessionId: "session-race" })).hasLiveProcess, false);
  processAppeared = true;
  now += 1;
  const fresh = await owner.state({ sessionId: "session-race" }, {
    forceFresh: true,
    notBeforeMs: now,
  });
  assert.equal(fresh.hasLiveProcess, true);
  assert.equal(fresh.generation, 2);
  assert.equal(probeCalls, 2);
});

test("Claude run admission binds one fresh proof to the exact run object", async () => {
  const now = Date.parse("2026-09-05T08:00:00.000Z");
  const owner = new ClaudeRuntimeOwner({
    platform: "win32",
    agentHubPid: 1,
    now: () => now,
    probe: async ({ generation }) => inventory(generation, [], {
      scannedAt: new Date(now + 1).toISOString(),
    }),
  });
  const gate = new ClaudeRunAdmissionGate({ runtimeOwner: owner });
  const capability = await gate.prepare({ provider: "claude", threadId: "session-proof" });
  const run = { provider: "claude", threadId: "session-proof" };
  capability.commit(run);

  const ticket = gate.stageLaunch(run);
  assert.throws(
    () => gate.consumeLaunch(run, "codex", ticket),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.equal(gate.consumeLaunch(run, "claude", ticket), true);
  assert.equal(run.externalOwnerProof.sessionId, "session-proof");
  assert.throws(
    () => gate.stageLaunch({ ...run }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.throws(
    () => gate.stageLaunch(run),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
});

test("Claude run admission rejects absence evidence captured before its begin fence", async () => {
  const now = Date.parse("2026-09-05T08:00:00.001Z");
  const owner = new ClaudeRuntimeOwner({
    platform: "win32",
    now: () => now,
    probe: async ({ generation }) => inventory(generation, [], {
      scannedAt: new Date(now - 1).toISOString(),
    }),
  });
  await assert.rejects(
    owner.authorize({ provider: "claude", threadId: "session-stale" }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
});

test("Windows probe bounds timeout, output and diagnostics without dependency text", async () => {
  await assert.rejects(readWindowsClaudeProcessSnapshot({
    generation: 0,
    spawnImpl: () => { throw new Error("secret executable path"); },
  }), (error) => error?.code === "CLAUDE_OWNER_PROBE_UNAVAILABLE"
    && !error.message.includes("secret executable path"));

  await assert.rejects(readWindowsClaudeProcessSnapshot({
    generation: 1,
    timeoutMs: 1,
    spawnImpl: fakeSpawn(() => {}),
  }), (error) => error?.code === "CLAUDE_OWNER_PROBE_TIMEOUT"
    && !error.message.includes("session"));

  await assert.rejects(readWindowsClaudeProcessSnapshot({
    generation: 2,
    outputLimit: 32,
    spawnImpl: fakeSpawn((child) => child.stderr.write("secret-command-line".repeat(4))),
  }), (error) => error?.code === "CLAUDE_OWNER_PROBE_OUTPUT_LIMIT"
    && !error.message.includes("secret-command-line"));

  await assert.rejects(readWindowsClaudeProcessSnapshot({
    generation: 3,
    spawnImpl: fakeSpawn((child) => {
      child.stderr.end("private dependency failure");
      child.emit("close", 2);
    }),
  }), (error) => error?.code === "CLAUDE_OWNER_PROBE_EXIT"
    && !error.message.includes("private dependency failure"));

  await assert.rejects(readWindowsClaudeProcessSnapshot({
    generation: 4,
    spawnImpl: fakeSpawn((child) => {
      child.stdout.end("{not-json");
      child.emit("close", 0);
    }),
  }), (error) => error?.code === "CLAUDE_OWNER_PROBE_SCHEMA");
});

test("PowerShell parser seam requires runtime identity and exact parsed session argv", {
  skip: process.platform !== "win32",
}, async () => {
  const helper = path.resolve(import.meta.dirname, "../../../claude-session-processes.ps1");
  const quotedHelper = helper.replaceAll("'", "''");
  const command = [
    `. '${quotedHelper}';`,
    String.raw`$signature=[pscustomobject]@{command='C:\Runtime\node.exe';prefixArgs=@('C:\Claude\cli.js')};`,
    "$processes=@(",
    String.raw`[pscustomobject]@{ProcessId=10;Name='node.exe';ExecutablePath='C:\Runtime\node.exe';CommandLine='"C:\Runtime\node.exe" "C:\Claude\cli.js" --resume "exact-session"';CreationDate=$null},`,
    String.raw`[pscustomobject]@{ProcessId=10;Name='node.exe';ExecutablePath='C:\Runtime\node.exe';CommandLine='"C:\Runtime\node.exe" "C:\Claude\cli.js" --resume "exact-session"';CreationDate=$null},`,
    String.raw`[pscustomobject]@{ProcessId=11;Name='node.exe';ExecutablePath='C:\Other\node.exe';CommandLine='"C:\Other\node.exe" --session-id exact-session';CreationDate=$null},`,
    String.raw`[pscustomobject]@{ProcessId=12;Name='other.exe';ExecutablePath='C:\Other\other.exe';CommandLine='other.exe --resume exact-session';CreationDate=$null},`,
    String.raw`[pscustomobject]@{ProcessId=13;Name='node.exe';ExecutablePath='C:\Runtime\node.exe';CommandLine='"C:\Runtime\node.exe" "C:\Claude\cli.js" --resume exact-session-prefix';CreationDate=$null},`,
    String.raw`[pscustomobject]@{ProcessId=14;Name='node.exe';ExecutablePath='C:\Runtime\node.exe';CommandLine=$null;CreationDate=$null},`,
    String.raw`[pscustomobject]@{ProcessId=15;Name='claude.exe';ExecutablePath='C:\Other\claude.exe';CommandLine='"C:\Other\claude.exe" --resume exact-session';CreationDate=$null}`,
    ");",
    "Get-ClaudeOwnerSnapshot -Processes $processes -Signature $signature -SnapshotGeneration 7 | ConvertTo-Json -Compress -Depth 5",
  ].join(" ");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout, stderr } = await execFileAsync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
  ], { windowsHide: true, maxBuffer: 64 * 1024 });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.complete, false);
  assert.equal(result.unreadableCandidateCount, 1);
  assert.deepEqual(result.owners, [
    { pid: 10, startTime: null, sessionId: "exact-session" },
    { pid: 13, startTime: null, sessionId: "exact-session-prefix" },
  ]);
});
