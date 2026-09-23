import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ProviderLoginService } from "../../src/application/provider-login-service.mjs";
import { processIsAlive, stopProcessTree } from "../../src/providers/claude/claude-run-io.mjs";

const AGENT_HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAKE_CLAUDE = path.join(AGENT_HUB_ROOT, "e2e", "test-contour-claude-cli.mjs");
const MULTIPLEXER = path.join(AGENT_HUB_ROOT, "e2e", "test-contour-codex-multiplexer.mjs");

function contourEnvironment(runtimeRoot) {
  return { ...process.env, AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RUNTIME_ROOT: runtimeRoot };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for the sign-in state"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function loginService(runtimeRoot, stateFile) {
  const environment = contourEnvironment(runtimeRoot);
  const invocation = { command: process.execPath, prefixArgs: [FAKE_CLAUDE, "--state", stateFile] };
  return new ProviderLoginService({
    sendRpc: async () => { throw new Error("Codex is not used by this test"); },
    resolveClaudeInvocation: () => invocation,
    spawnProcess: (command, args, options) => spawn(command, args, { ...options, env: environment }),
    stopProcessTree: async () => false,
    readClaudeLoggedIn: async () => {
      const result = await runProcess(invocation.command, [...invocation.prefixArgs, "auth", "status", "--json"], { env: environment });
      return result.code === 0 && JSON.parse(result.stdout).loggedIn === true;
    },
    claudeUrlWaitMs: 10_000,
    logger: { error() {} },
  });
}

test("the Test Contour Claude CLI completes the real sign-in service only with a synthetic code", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-claude-"));
  const stateFile = path.join(runtimeRoot, "data-fake-claude-auth-state.json");
  const service = loginService(runtimeRoot, stateFile);
  try {
    const started = await service.start("claude");
    assert.equal(started.status, "pending");
    assert.match(started.authUrl, /^https:\/\/127\.0\.0\.1:9\/agent-hub-test-contour\/claude-login\?attempt=/u,
      "the printed link is synthetic loopback, reaching no external host");

    await assert.rejects(service.submitCode("claude", "no-hash", started.attemptId), /code#state/u);
    await service.submitCode("claude", "real-looking-oauth-code#state", started.attemptId);
    await waitFor(() => service.entry("claude").status !== "pending");
    assert.equal(service.entry("claude").status, "failed", "a non-synthetic code never signs in");
    assert.equal(JSON.parse((await runProcess(process.execPath, [FAKE_CLAUDE, "--state", stateFile, "auth", "status", "--json"],
      { env: contourEnvironment(runtimeRoot) })).stdout).loggedIn, false);

    const second = await service.start("claude");
    await service.submitCode("claude", "test-contour-code-1#state-1", second.attemptId);
    await waitFor(() => service.entry("claude").status !== "pending");
    assert.equal(service.entry("claude").status, "succeeded");
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).loggedIn, true);

    const third = await service.start("claude");
    assert.equal(third.status, "pending");
    assert.equal((await service.cancel("claude")).status, "cancelled");
  } finally {
    service.dispose();
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 });
  }
});

test("the Test Contour Claude CLI refuses to run outside its owned contour runtime", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-claude-guard-"));
  try {
    const stateInside = path.join(runtimeRoot, "state.json");
    const { AGENT_HUB_TEST_CONTOUR: _contour, ...plain } = process.env;
    const outside = await runProcess(process.execPath, [FAKE_CLAUDE, "--state", stateInside, "auth", "login"], { env: plain });
    assert.equal(outside.code, 2);
    const foreignState = await runProcess(process.execPath, [FAKE_CLAUDE, "--state", path.join(os.tmpdir(), "elsewhere.json"), "auth", "status"],
      { env: contourEnvironment(runtimeRoot) });
    assert.equal(foreignState.code, 2);
    const unsupported = await runProcess(process.execPath, [FAKE_CLAUDE, "--state", stateInside, "--print", "hi"],
      { env: contourEnvironment(runtimeRoot) });
    assert.equal(unsupported.code, 2);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

const STUB_CHILD = `
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const log = process.env.STUB_LOG;
const backend = process.argv.includes("--require-test-contour") ? "fake" : "real";
if (process.env.STUB_PID_LOG) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  descendant.unref();
  appendFileSync(process.env.STUB_PID_LOG, JSON.stringify({ backend, childPid: process.pid, descendantPid: descendant.pid }) + "\\n");
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(log, backend + " " + message.method + "\\n");
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: { backend } }) + "\\n");
});
`;

test("the Test Contour Codex multiplexer answers account sign-in itself and never forwards it", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-multiplexer-"));
  const stub = path.join(runtimeRoot, "providers-stub.mjs");
  const log = path.join(runtimeRoot, "stub.log");
  const pidLog = path.join(runtimeRoot, "owned-processes.jsonl");
  await writeFile(stub, STUB_CHILD, "utf8");
  await writeFile(log, "", "utf8");
  await writeFile(pidLog, "", "utf8");
  const multiplexer = spawn(process.execPath, [
    MULTIPLEXER,
    "--real-executable", process.execPath,
    "--fake-executable", stub,
    "--fake-state", path.join(runtimeRoot, "fake-state.json"),
    "--routing-state", path.join(runtimeRoot, "routing-state.json"),
    stub,
  ], { cwd: runtimeRoot, env: { ...contourEnvironment(runtimeRoot), STUB_LOG: log, STUB_PID_LOG: pidLog }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  createInterface({ input: multiplexer.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) responses.set(message.id, message);
  });
  const call = async (id, method, params = {}) => {
    multiplexer.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    await waitFor(() => responses.has(id));
    return responses.get(id);
  };
  try {
    await waitFor(() => {
      try {
        return readFileSync(pidLog, "utf8").trim().split(/\r?\n/u).filter(Boolean).length === 2;
      } catch {
        return false;
      }
    });
    const started = await call(1, "account/login/start", { type: "chatgpt" });
    assert.equal(started.result.type, "chatgpt");
    assert.match(started.result.loginId, /^test-contour-login-/u);
    assert.match(started.result.authUrl, /^https:\/\/127\.0\.0\.1:9\/agent-hub-test-contour\/codex-login\?loginId=/u);
    assert.deepEqual((await call(2, "account/login/cancel", { loginId: started.result.loginId })).result, {});
    assert.match((await call(3, "account/logout", {})).error.message, /not available in Test Contour/u);
    assert.deepEqual((await call(4, "account/read", {})).result, { backend: "real" }, "other methods keep their routing");

    const forwarded = (await readFile(log, "utf8")).trim().split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(forwarded, ["real account/read"], "no sign-in request reached either child");
  } finally {
    multiplexer.stdin.end();
    await new Promise((resolve) => multiplexer.once("close", resolve));
    const owned = (await readFile(pidLog, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    const aliveAfterParentClose = owned.flatMap(({ childPid, descendantPid }) => [childPid, descendantPid])
      .filter((pid) => processIsAlive(pid));
    await Promise.all(aliveAfterParentClose.map((pid) => stopProcessTree(pid)));
    await waitFor(() => aliveAfterParentClose.every((pid) => !processIsAlive(pid)));
    await rm(runtimeRoot, { recursive: true, force: true });
    assert.deepEqual(aliveAfterParentClose, [], "multiplexer close waits for every owned child and descendant");
  }
});
