import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCodexAppServerCompatibilityCanary } from "../../src/composition/codex-app-server-canary.mjs";

const FAKE_APP_SERVER = path.resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "codex-update-canary-app-server.mjs",
);

test("compatibility canary executes health, MCP, cancel, next-turn and restart/resume", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-canary-test-"));
  const dataDir = path.join(root, "data");
  const sourceHome = path.join(root, "source-codex-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const result = await runCodexAppServerCompatibilityCanary({ path: process.execPath }, {
    dataDir,
    executableArgs: [FAKE_APP_SERVER],
    environment: { ...process.env, CODEX_HOME: sourceHome },
    protectDirectory: async () => {},
    rpcTimeoutMs: 3_000,
    totalTimeoutMs: 15_000,
    logger: { error() {} },
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.healthRead, true);
  assert.equal(result.evidence.mcpReadCount, 1);
  assert.equal(result.evidence.restartResume, true);
  assert.deepEqual(Object.keys(result.evidence.turnIds), [
    "ordinary", "mcp", "interrupted", "afterCancel", "afterResume",
  ]);
  assert.deepEqual(await readdir(path.join(dataDir, "codex-executable-canary")), []);
});

test("compatibility canary timeout is bounded and removes isolated runtime", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-canary-timeout-"));
  const dataDir = path.join(root, "data");
  const sourceHome = path.join(root, "source-codex-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  await assert.rejects(runCodexAppServerCompatibilityCanary({ path: process.execPath }, {
    dataDir,
    executableArgs: [FAKE_APP_SERVER, "--hang-health"],
    environment: { ...process.env, CODEX_HOME: sourceHome },
    protectDirectory: async () => {},
    rpcTimeoutMs: 200,
    totalTimeoutMs: 1_000,
    logger: { error() {} },
  }), /timed out/u);
  assert.deepEqual(await readdir(path.join(dataDir, "codex-executable-canary")), ["last-failure.json"]);
});

test("compatibility canary keeps asynchronous turn SLA separate from RPC timeout", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-canary-turn-sla-"));
  const dataDir = path.join(root, "data");
  const sourceHome = path.join(root, "source-codex-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const result = await runCodexAppServerCompatibilityCanary({ path: process.execPath }, {
    dataDir,
    executableArgs: [FAKE_APP_SERVER, "--delay-turn-ms=150"],
    environment: { ...process.env, CODEX_HOME: sourceHome },
    protectDirectory: async () => {},
    rpcTimeoutMs: 50,
    turnTimeoutMs: 500,
    cancelTimeoutMs: 500,
    totalTimeoutMs: 5_000,
    logger: { error() {} },
  });

  assert.equal(result.ok, true);
  assert.ok(result.evidence.protocolEvents.some((event) => event.event === "turn-accepted"));
  assert.deepEqual(await readdir(path.join(dataDir, "codex-executable-canary")), []);
});

test("compatibility canary waits for process close before restart", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-canary-close-"));
  const dataDir = path.join(root, "data");
  const sourceHome = path.join(root, "source-codex-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let activeProcesses = 0;
  let overlap = false;

  const result = await runCodexAppServerCompatibilityCanary({ path: process.execPath }, {
    dataDir,
    executableArgs: [FAKE_APP_SERVER],
    environment: { ...process.env, CODEX_HOME: sourceHome },
    protectDirectory: async () => {},
    rpcTimeoutMs: 1_000,
    turnTimeoutMs: 2_000,
    totalTimeoutMs: 10_000,
    spawnImpl: (command, args, options) => {
      if (activeProcesses > 0) overlap = true;
      activeProcesses += 1;
      const child = spawn(command, args, options);
      child.once("close", () => { activeProcesses -= 1; });
      return child;
    },
    stopProcess: async (pid) => {
      setTimeout(() => {
        try { process.kill(pid); } catch {}
      }, 75);
      return true;
    },
    logger: { error() {} },
  });

  assert.equal(result.ok, true);
  assert.equal(overlap, false);
});

test("compatibility canary preserves bounded secret-free failure evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-canary-evidence-"));
  const dataDir = path.join(root, "data");
  const sourceHome = path.join(root, "source-codex-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{\"secret\":\"must-not-leak\"}\n", "utf8");
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  await assert.rejects(runCodexAppServerCompatibilityCanary({
    path: process.execPath,
    version: "test-version",
    sha256: "test-sha",
    publisher: "test-publisher",
  }, {
    dataDir,
    executableArgs: [FAKE_APP_SERVER, "--hang-health"],
    environment: { ...process.env, CODEX_HOME: sourceHome },
    protectDirectory: async () => {},
    rpcTimeoutMs: 50,
    turnTimeoutMs: 500,
    totalTimeoutMs: 1_000,
    logger: { error() {} },
  }), /timed out/u);

  const failure = JSON.parse(await readFile(
    path.join(dataDir, "codex-executable-canary", "last-failure.json"),
    "utf8",
  ));
  assert.equal(failure.phase, "health");
  assert.equal(failure.candidate.version, "test-version");
  assert.match(failure.error.message, /timed out/u);
  assert.doesNotMatch(JSON.stringify(failure), /must-not-leak/u);
  assert.deepEqual(
    await readdir(path.join(dataDir, "codex-executable-canary")),
    ["last-failure.json"],
  );
});

test("compatibility canary rejects an elicitation not bound to its isolated MCP turn", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-canary-elicitation-"));
  const dataDir = path.join(root, "data");
  const sourceHome = path.join(root, "source-codex-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  await assert.rejects(runCodexAppServerCompatibilityCanary({ path: process.execPath }, {
    dataDir,
    executableArgs: [FAKE_APP_SERVER, "--wrong-elicitation-server"],
    environment: { ...process.env, CODEX_HOME: sourceHome },
    protectDirectory: async () => {},
    rpcTimeoutMs: 500,
    turnTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    logger: { error() {} },
  }), /unbound MCP elicitation/u);

  const entries = await readdir(path.join(dataDir, "codex-executable-canary"));
  assert.deepEqual(entries, ["last-failure.json"]);
});

test("compatibility canary rejects a terminal but unsuccessful ordinary turn", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-canary-failed-turn-"));
  const dataDir = path.join(root, "data");
  const sourceHome = path.join(root, "source-codex-home");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  await assert.rejects(runCodexAppServerCompatibilityCanary({ path: process.execPath }, {
    dataDir,
    executableArgs: [FAKE_APP_SERVER, "--fail-ordinary"],
    environment: { ...process.env, CODEX_HOME: sourceHome },
    protectDirectory: async () => {},
    rpcTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    logger: { error() {} },
  }), /status failed/u);
  assert.deepEqual(await readdir(path.join(dataDir, "codex-executable-canary")), ["last-failure.json"]);
});
