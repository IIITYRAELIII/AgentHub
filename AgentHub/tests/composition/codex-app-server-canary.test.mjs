import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  assert.deepEqual(await readdir(path.join(dataDir, "codex-executable-canary")), []);
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
  assert.deepEqual(await readdir(path.join(dataDir, "codex-executable-canary")), []);
});
