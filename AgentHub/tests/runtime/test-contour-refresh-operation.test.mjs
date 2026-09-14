import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { canonicalPath } from "../../src/infrastructure/filesystem/config.mjs";

import {
  beginTestContourOperation,
  readTestContourOperationDocument,
  testContourOperationReadback,
  transitionTestContourOperation,
} from "../../src/runtime/test-contour-operation-state.mjs";
import {
  readTestContourStatus,
  readyTestContourHealth,
  startTestContour,
  TEST_CONTOUR_SPARK_MODEL,
  testContourSmokeAgentPolicy,
  testContourPaths,
  verifyTestContour,
} from "../../src/runtime/test-contour-manager.mjs";

const fixture = path.resolve(import.meta.dirname, "..", "fixtures", "test-contour-operation-process.mjs");
const healthFixture = path.resolve(import.meta.dirname, "..", "fixtures", "test-contour-health-process.mjs");

function child(root, label, headCommit, eventFile) {
  const handle = spawn(process.execPath, [fixture, root, label, headCommit, eventFile], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true,
  });
  handle.receivedMessages = [];
  handle.on("message", (value) => handle.receivedMessages.push(value));
  return handle;
}

function message(processHandle, type, timeoutMs = 5_000) {
  const queuedIndex = processHandle.receivedMessages.findIndex((value) => value?.type === type);
  if (queuedIndex >= 0) {
    return Promise.resolve(processHandle.receivedMessages.splice(queuedIndex, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child message: ${type}`));
    }, timeoutMs);
    const receive = (value) => {
      if (value?.type !== type) return;
      const index = processHandle.receivedMessages.indexOf(value);
      if (index >= 0) processHandle.receivedMessages.splice(index, 1);
      cleanup();
      resolve(value);
    };
    const exit = (code, signal) => {
      cleanup();
      reject(new Error(`Child exited before ${type}: ${signal ?? code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      processHandle.off("message", receive);
      processHandle.off("exit", exit);
    };
    processHandle.on("message", receive);
    processHandle.on("exit", exit);
  });
}

function exited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null
    ? Promise.resolve([processHandle.exitCode, processHandle.signalCode])
    : once(processHandle, "exit");
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function healthServer() {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      const identity = server.testContourIdentity;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        live: true,
        ready: true,
        status: "ready",
        ...(identity ? {
          testContourRuntime: {
            ...identity,
            expectedPort: identity.port,
            actualPort: server.address().port,
            pid: process.pid,
          },
        } : {}),
      }));
      return;
    }
    const identity = server.testContourIdentity;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(identity
      ? `<html data-test-contour="" data-test-contour-id="${identity.contourId}" data-test-contour-release="${identity.releaseId}" data-test-contour-operation="${identity.operationId ?? ""}" data-test-contour-port="${identity.port}"><body>old-runtime-visible</body></html>`
      : "<html><body>old-runtime-visible</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function writeRunningContour(root, server, {
  releaseId = "release-old",
  headCommit = "head-old",
  operationId = null,
  model = TEST_CONTOUR_SPARK_MODEL,
  runtimeNonce = `nonce-${releaseId}`,
  operationSourceRoot = root,
} = {}) {
  const paths = testContourPaths(root);
  await mkdir(root, { recursive: true });
  await writeFile(paths.markerFile, JSON.stringify({
    kind: "agent-hub-test-contour",
    id: "test-contour-refresh",
  }), "utf8");
  await writeFile(path.join(root, "current.json"), JSON.stringify({
    current: releaseId,
    previous: null,
    updatedAt: new Date().toISOString(),
  }), "utf8");
  let effectiveOperationId = operationId;
  if (!effectiveOperationId) {
    const started = await beginTestContourOperation(root, {
      source: { branch: "dev", headCommit, sourceRoot: operationSourceRoot },
      target: {
        root,
        contourId: "test-contour-refresh",
        port: server.address().port,
        model,
      },
    });
    const ready = await transitionTestContourOperation(root, {
      operationId: started.operationId,
      ownerToken: started.ownerToken,
      phase: "ready",
      status: "ready",
      patch: { releaseId },
    });
    effectiveOperationId = ready.operationId;
  }
  await writeFile(paths.sourceFile, JSON.stringify({
    branch: "dev",
    headCommit,
    sourceRoot: operationSourceRoot,
    contourId: "test-contour-refresh",
    operationId: effectiveOperationId,
    port: server.address().port,
    model,
    releaseId,
  }), "utf8");
  await writeFile(paths.stateFile, JSON.stringify({
    contourId: "test-contour-refresh",
    managerPid: process.pid,
    runtimePid: process.pid,
    releaseId,
    operationId: effectiveOperationId,
    runtimeNonce,
    source: { branch: "dev", headCommit },
    model,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/`,
  }), "utf8");
  server.testContourIdentity = {
    contourId: "test-contour-refresh",
    releaseId,
    operationId: effectiveOperationId,
    port: server.address().port,
    model,
    runtimeNonce,
  };
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(path.join(paths.dataDir, "bot.lock"), JSON.stringify({
    pid: process.pid,
    releaseId,
    ready: true,
  }), "utf8");
  return paths;
}

test("two Test Contour processes serialize and newer source deterministically supersedes older", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-processes-"));
  const eventFile = path.join(root, "events.log");
  const first = child(root, "first", "head-1", eventFile);
  let second = null;
  try {
    await message(first, "waiting");
    const firstAcquired = await message(first, "acquired");
    second = child(root, "second", "head-2", eventFile);
    await message(second, "waiting");
    first.send({ type: "release" });
    await message(first, "done");
    const secondAcquired = await message(second, "acquired");
    second.send({ type: "release" });
    await message(second, "done");
    await Promise.all([exited(first), exited(second)]);

    const events = (await readFile(eventFile, "utf8")).trim().split(/\r?\n/u);
    assert.deepEqual(events.map((item) => item.split(":")[0]), ["first", "first", "second", "second"]);
    const document = await readTestContourOperationDocument(root);
    assert.equal(document.current.operationId, secondAcquired.operationId);
    assert.equal(document.current.source.headCommit, "head-2");
    assert.equal(document.current.target.contourId, "fixture-contour");
    assert.equal(document.current.target.port, 8877);
    assert.equal(document.current.status, "ready");
    assert.equal(document.history[0].operationId, firstAcquired.operationId);
    assert.equal(document.history[0].status, "superseded");
    assert.equal(testContourOperationReadback(document, {
      expectedOperationId: firstAcquired.operationId,
      expectedHeadCommit: "head-1",
    }).outcome, "superseded");
    assert.equal(testContourOperationReadback(document, {
      expectedOperationId: secondAcquired.operationId,
      expectedHeadCommit: "head-2",
    }).outcome, "exact");
    assert.equal(testContourOperationReadback(document, {
      expectedOperationId: "unknown-operation",
    }).outcome, "not_found");
    assert.ok(document.current.revision > document.history[0].revision);
  } finally {
    first.kill("SIGKILL");
    second?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-operation.lock`, { recursive: true, force: true });
  }
});

test("dead Test Contour operation owner releases the process lease and records crash recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-owner-crash-"));
  const eventFile = path.join(root, "events.log");
  const crashed = child(root, "crashed", "head-crashed", eventFile);
  let recovered = null;
  try {
    const crashedOperation = await message(crashed, "acquired");
    crashed.kill("SIGKILL");
    await exited(crashed);
    recovered = child(root, "recovered", "head-recovered", eventFile);
    await message(recovered, "waiting");
    const recoveredOperation = await message(recovered, "acquired");
    recovered.send({ type: "release" });
    await message(recovered, "done");
    await exited(recovered);

    const document = await readTestContourOperationDocument(root);
    assert.equal(document.current.operationId, recoveredOperation.operationId);
    assert.equal(document.current.status, "ready");
    const interrupted = document.history.find((item) => item.operationId === crashedOperation.operationId);
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.reason, "owner-crash");
  } finally {
    crashed.kill("SIGKILL");
    recovered?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-operation.lock`, { recursive: true, force: true });
  }
});

test("refresh keeps the old browser runtime readable throughout candidate preparation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-browser-read-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-browser-source-"));
  const server = await healthServer();
  const paths = await writeRunningContour(root, server);
  let preparationStarted;
  let releasePreparation;
  const started = new Promise((resolve) => { preparationStarted = resolve; });
  const gate = new Promise((resolve) => { releasePreparation = resolve; });
  let stopped = false;
  try {
    const refresh = startTestContour({
      root,
      sourceRoot,
      entryFile: "unused-test-entry.mjs",
      refresh: true,
      port: server.address().port,
      model: TEST_CONTOUR_SPARK_MODEL,
      prepareSource: async () => ({ sourceRoot, branch: "dev", headCommit: "head-new" }),
      prepareCandidate: async () => {
        preparationStarted();
        await gate;
        const releaseRoot = path.join(root, "releases", "release-new");
        await mkdir(releaseRoot, { recursive: true });
        return { releaseId: "release-new", releaseRoot, sourceRoot, branch: "dev", headCommit: "head-new" };
      },
      stopRuntime: async () => {
        stopped = true;
        await closeServer(server);
        await rm(paths.stateFile, { force: true });
        return { stopped: true };
      },
      launchCandidate: async ({ candidate, operation, onManagerSpawn, port }) => {
        await onManagerSpawn({ pid: process.pid });
        return {
          contourId: "test-contour-refresh",
          managerPid: process.pid,
          runtimePid: process.pid,
          releaseId: candidate.releaseId,
          operationId: operation.operationId,
          source: { branch: candidate.branch, headCommit: candidate.headCommit },
          model: TEST_CONTOUR_SPARK_MODEL,
          port,
          url: `http://localhost:${port}/`,
          health: { ok: true, live: true, ready: true },
        };
      },
    });
    await started;
    const browserResponse = await fetch(`http://127.0.0.1:${server.address().port}/during-refresh`);
    assert.match(await browserResponse.text(), /old-runtime-visible/u);
    assert.equal(stopped, false);
    releasePreparation();
    const result = await refresh;
    assert.equal(result.refreshOutcome, "refreshed");
    assert.equal(result.source.headCommit, "head-new");
    assert.equal(stopped, true);
    const pointer = JSON.parse(await readFile(path.join(root, "current.json"), "utf8"));
    assert.equal(pointer.current, "release-new");
    const operation = await readTestContourOperationDocument(root);
    assert.equal(operation.current.status, "ready");
    assert.equal(operation.current.phase, "ready");
  } finally {
    releasePreparation?.();
    await closeServer(server);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("same-source refresh coalesces only for the exact ready target identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-coalesce-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-coalesce-source-"));
  const server = await healthServer();
  await writeRunningContour(root, server, { headCommit: "head-same", operationSourceRoot: sourceRoot });
  let prepared = false;
  let stopped = false;
  try {
    const result = await startTestContour({
      root,
      sourceRoot,
      entryFile: "unused-test-entry.mjs",
      refresh: true,
      port: server.address().port,
      model: TEST_CONTOUR_SPARK_MODEL,
      prepareSource: async () => ({ sourceRoot, branch: "dev", headCommit: "head-same" }),
      prepareCandidate: async () => { prepared = true; },
      stopRuntime: async () => { stopped = true; },
    });
    assert.equal(result.refreshOutcome, "coalesced");
    assert.equal(prepared, false);
    assert.equal(stopped, false);
  } finally {
    await closeServer(server);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("same source on a different custom port prepares and cuts over the requested target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-custom-port-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-custom-source-"));
  const server = await healthServer();
  await writeRunningContour(root, server, { headCommit: "head-same", operationSourceRoot: sourceRoot });
  const requestedPort = server.address().port + 1;
  let prepared = false;
  let stopped = false;
  try {
    const result = await startTestContour({
      root,
      sourceRoot,
      entryFile: "unused-test-entry.mjs",
      refresh: true,
      port: requestedPort,
      model: TEST_CONTOUR_SPARK_MODEL,
      prepareSource: async () => ({ sourceRoot, branch: "dev", headCommit: "head-same" }),
      prepareCandidate: async () => {
        prepared = true;
        const releaseRoot = path.join(root, "releases", "release-new-port");
        await mkdir(releaseRoot, { recursive: true });
        return {
          releaseId: "release-new-port",
          releaseRoot,
          sourceRoot,
          branch: "dev",
          headCommit: "head-same",
        };
      },
      stopRuntime: async () => {
        stopped = true;
        await closeServer(server);
        await rm(testContourPaths(root).stateFile, { force: true });
        return { stopped: true };
      },
      launchCandidate: async ({ candidate, operation, onManagerSpawn }) => {
        await onManagerSpawn({ pid: process.pid });
        return {
          contourId: "test-contour-refresh",
          managerPid: process.pid,
          runtimePid: process.pid,
          releaseId: candidate.releaseId,
          operationId: operation.operationId,
          source: { branch: "dev", headCommit: "head-same" },
          model: TEST_CONTOUR_SPARK_MODEL,
          port: requestedPort,
          url: `http://127.0.0.1:${requestedPort}/`,
        };
      },
    });
    assert.equal(result.refreshOutcome, "refreshed");
    assert.equal(result.port, requestedPort);
    assert.equal(prepared, true);
    assert.equal(stopped, true);
  } finally {
    await closeServer(server);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("release preflight fresh-candidate semantics bypass exact-target coalescing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-fresh-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-fresh-source-"));
  const server = await healthServer();
  await writeRunningContour(root, server, { headCommit: "head-same", operationSourceRoot: sourceRoot });
  let prepared = false;
  try {
    await assert.rejects(() => startTestContour({
      root,
      sourceRoot,
      entryFile: "unused-test-entry.mjs",
      refresh: true,
      forceFreshCandidate: true,
      port: server.address().port,
      model: TEST_CONTOUR_SPARK_MODEL,
      prepareSource: async () => ({ sourceRoot, branch: "dev", headCommit: "head-same" }),
      prepareCandidate: async () => {
        prepared = true;
        throw new Error("fresh candidate prepared");
      },
    }), /fresh candidate prepared/u);
    assert.equal(prepared, true);
  } finally {
    await closeServer(server);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("ready runtime is finalized after refresh owner crash without a duplicate restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-recover-ready-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-recover-source-"));
  const server = await healthServer();
  const operation = await beginTestContourOperation(root, {
    source: { branch: "dev", headCommit: "head-recovered", sourceRoot },
    target: {
      root,
      contourId: "test-contour-refresh",
      port: server.address().port,
      model: TEST_CONTOUR_SPARK_MODEL,
    },
    ownerPid: 2_147_483_000,
    isProcessAlive: () => false,
  });
  await transitionTestContourOperation(root, {
    operationId: operation.operationId,
    ownerToken: operation.ownerToken,
    phase: "starting",
    patch: { releaseId: "release-recovered", previousReleaseId: "release-old" },
  });
  await writeRunningContour(root, server, {
    releaseId: "release-recovered",
    headCommit: "head-recovered",
    operationId: operation.operationId,
    operationSourceRoot: sourceRoot,
  });
  await writeFile(path.join(root, "current.json"), JSON.stringify({
    current: "release-old",
    previous: null,
    updatedAt: new Date().toISOString(),
  }), "utf8");
  let prepared = false;
  let stopped = false;
  try {
    const result = await startTestContour({
      root,
      sourceRoot,
      entryFile: "unused-test-entry.mjs",
      refresh: true,
      port: server.address().port,
      model: TEST_CONTOUR_SPARK_MODEL,
      prepareSource: async () => ({ sourceRoot, branch: "dev", headCommit: "head-recovered" }),
      prepareCandidate: async () => { prepared = true; },
      stopRuntime: async () => { stopped = true; },
    });
    assert.equal(result.refreshOutcome, "coalesced");
    assert.equal(prepared, false);
    assert.equal(stopped, false);
    const document = await readTestContourOperationDocument(root);
    assert.equal(document.current.status, "ready");
    assert.equal(document.current.recoveredAfterOwnerCrash, true);
    const pointer = JSON.parse(await readFile(path.join(root, "current.json"), "utf8"));
    assert.equal(pointer.current, "release-recovered");
  } finally {
    await closeServer(server);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("readiness rejects a healthy server from another contour identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-identity-root-"));
  const server = await healthServer();
  const port = server.address().port;
  server.testContourIdentity = {
    contourId: "shared-contour",
    releaseId: "shared-release",
    operationId: "shared-operation",
    port,
    model: TEST_CONTOUR_SPARK_MODEL,
    runtimeNonce: "shared-runtime-nonce",
  };
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({
      pid: process.pid,
      releaseId: "shared-release",
      ready: true,
    }), "utf8");
    assert.equal(await readyTestContourHealth(port, {
      root,
      expectedIdentity: {
        contourId: "isolated-contour",
        releaseId: "isolated-release",
        operationId: "isolated-operation",
        port,
        model: TEST_CONTOUR_SPARK_MODEL,
        runtimeNonce: "isolated-runtime-nonce",
        runtimePid: process.pid,
      },
    }), null);
    assert.equal(await readyTestContourHealth(port, {
      root,
      expectedIdentity: { ...server.testContourIdentity, runtimePid: process.pid + 1 },
    }), null);
    assert.equal((await readyTestContourHealth(port, {
      root,
      expectedIdentity: { ...server.testContourIdentity, runtimePid: process.pid },
    }))?.ready, true);
  } finally {
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("status distinguishes an exact operation health mismatch from a stopped runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-readiness-reason-"));
  const server = await healthServer();
  try {
    const paths = await writeRunningContour(root, server, { headCommit: "head-readiness" });
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    server.testContourIdentity = {
      ...server.testContourIdentity,
      operationId: "foreign-operation",
    };

    const mismatch = await readTestContourStatus({
      root,
      expectedOperationId: state.operationId,
      expectedHeadCommit: "head-readiness",
    });
    assert.equal(mismatch.readback.outcome, "exact");
    assert.equal(mismatch.running, false);
    assert.equal(mismatch.status, "not-ready");
    assert.deepEqual(mismatch.readiness, {
      ready: false,
      retryable: false,
      reason: "health-operation-mismatch",
    });

    await rm(paths.stateFile, { force: true });
    const stopped = await readTestContourStatus({
      root,
      expectedOperationId: state.operationId,
      expectedHeadCommit: "head-readiness",
    });
    assert.equal(stopped.readback.outcome, "exact");
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(stopped.readiness, {
      ready: false,
      retryable: false,
      reason: "state-missing",
    });
  } finally {
    await closeServer(server);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
    ]);
  }
});

test("foreign healthy process cannot satisfy readiness with a forged root-local lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-foreign-health-"));
  const spawnHealth = (identity) => {
    const handle = spawn(
      process.execPath,
      [healthFixture, JSON.stringify(identity)],
      { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true },
    );
    handle.receivedMessages = [];
    handle.on("message", (value) => handle.receivedMessages.push(value));
    return handle;
  };
  const ownedIdentity = {
    contourId: "candidate-contour",
    releaseId: "candidate-release",
    operationId: "candidate-operation",
    model: TEST_CONTOUR_SPARK_MODEL,
    runtimeNonce: "candidate-runtime-nonce",
  };
  const owned = spawnHealth(ownedIdentity);
  const foreign = spawnHealth({
    contourId: "foreign-contour",
    releaseId: "foreign-release",
    operationId: "foreign-operation",
    model: TEST_CONTOUR_SPARK_MODEL,
    runtimeNonce: "foreign-runtime-nonce",
  });
  try {
    const [ownedReady, foreignReady] = await Promise.all([
      message(owned, "ready"),
      message(foreign, "ready"),
    ]);
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({
      pid: ownedReady.pid,
      releaseId: ownedIdentity.releaseId,
      ready: true,
    }), "utf8");
    assert.notEqual(ownedReady.port, foreignReady.port);
    assert.equal(await readyTestContourHealth(foreignReady.port, {
      root,
      expectedIdentity: {
        ...ownedIdentity,
        port: foreignReady.port,
        runtimePid: ownedReady.pid,
      },
    }), null);
    assert.equal((await readyTestContourHealth(ownedReady.port, {
      root,
      expectedIdentity: {
        ...ownedIdentity,
        port: ownedReady.port,
        runtimePid: ownedReady.pid,
      },
    }))?.ready, true);
  } finally {
    owned.kill("SIGTERM");
    foreign.kill("SIGTERM");
    await Promise.allSettled([exited(owned), exited(foreign)]);
    await rm(root, { recursive: true, force: true });
  }
});

test("verify preserves the requested root and custom port through refresh and smoke", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-verify-root-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-verify-source-"));
  const port = 18_878;
  const calls = [];
  try {
    const result = await verifyTestContour({
      root,
      sourceRoot,
      port,
      withAgent: false,
      model: TEST_CONTOUR_SPARK_MODEL,
      startContour: async (options) => {
        calls.push({ kind: "start", options });
        return {
          url: `http://127.0.0.1:${port}/`,
          model: TEST_CONTOUR_SPARK_MODEL,
          startedAt: new Date().toISOString(),
        };
      },
      smokeRunner: async (options) => {
        calls.push({ kind: "smoke", options });
        return { ok: true, withAgent: false };
      },
    });
    assert.equal(result.smoke.ok, true);
    assert.equal(calls[0].options.root, canonicalPath(root));
    assert.equal(calls[0].options.port, port);
    assert.equal(calls[0].options.sourceKind, "dev");
    assert.equal(calls[1].options.url, `http://127.0.0.1:${port}/`);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("verify reports the recording agent probe as skipped and leaves its journal untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-recording-verify-root-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-recording-verify-source-"));
  let smokeOptions = null;
  try {
    assert.deepEqual(testContourSmokeAgentPolicy({ withAgent: true }), {
      withAgent: true,
      agentProbeSkipped: null,
    });
    const result = await verifyTestContour({
      root,
      sourceRoot,
      withAgent: true,
      startContour: async () => ({
        url: "http://127.0.0.1:18879/",
        model: TEST_CONTOUR_SPARK_MODEL,
        startedAt: new Date().toISOString(),
      }),
      readRecordingConfiguration: async () => ({ root: path.join(root, "recording") }),
      smokeRunner: async (options) => {
        smokeOptions = options;
        return { ok: true, withAgent: options.withAgent };
      },
    });
    assert.equal(smokeOptions.withAgent, false);
    assert.equal(result.journal, null);
    assert.equal(result.agentProbeSkipped, "recording-contour-external-effects-denied");
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("verify forwards explicit release-candidate source without changing the default dev contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-release-verify-root-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-release-verify-source-"));
  let start = null;
  try {
    await verifyTestContour({
      root,
      sourceRoot,
      sourceKind: "release-candidate",
      withAgent: false,
      startContour: async (options) => {
        start = options;
        return {
          url: "http://127.0.0.1:18880/",
          model: TEST_CONTOUR_SPARK_MODEL,
          startedAt: new Date().toISOString(),
        };
      },
      smokeRunner: async () => ({ ok: true, withAgent: false }),
    });
    assert.equal(start.sourceKind, "release-candidate");
    assert.equal(start.refresh, true);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("ordinary start replaces a persisted release candidate with the exact current dev source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-main-to-dev-root-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-main-to-dev-source-"));
  const paths = testContourPaths(root);
  const releaseRoot = path.join(root, "releases", "release-main");
  const port = 18_881;
  let preparedSource = null;
  let launchedCandidate = null;
  try {
    await mkdir(releaseRoot, { recursive: true });
    await Promise.all([
      writeFile(paths.markerFile, JSON.stringify({
        kind: "agent-hub-test-contour",
        id: "contour-main-to-dev",
      }), "utf8"),
      writeFile(path.join(root, "current.json"), JSON.stringify({
        current: "release-main",
        previous: null,
      }), "utf8"),
      writeFile(paths.sourceFile, JSON.stringify({
        kind: "release-candidate",
        branch: "main",
        headCommit: "release-main-head",
        sourceRoot: path.join(sourceRoot, "release-main"),
        contourId: "contour-main-to-dev",
        operationId: "operation-main",
        port,
        model: TEST_CONTOUR_SPARK_MODEL,
        releaseId: "release-main",
      }), "utf8"),
      writeFile(path.join(releaseRoot, "agent-hub-main.mjs"), "export {};\n", "utf8"),
    ]);

    const result = await startTestContour({
      root,
      sourceRoot,
      port,
      model: TEST_CONTOUR_SPARK_MODEL,
      prepareSource: async () => ({ sourceRoot, branch: "dev", headCommit: "dev-head-current" }),
      prepareCandidate: async ({ source }) => {
        preparedSource = source;
        return {
          releaseId: "release-dev",
          releaseRoot: path.join(root, "releases", "release-dev"),
          kind: source.kind,
          branch: source.branch,
          headCommit: source.headCommit,
          sourceRoot: source.sourceRoot,
        };
      },
      stopRuntime: async () => {},
      launchCandidate: async ({ candidate, operation }) => {
        launchedCandidate = candidate;
        return {
          managerPid: process.pid,
          runtimePid: process.pid,
          releaseId: candidate.releaseId,
          operationId: operation.operationId,
          source: { branch: candidate.branch, headCommit: candidate.headCommit },
          contourId: "contour-main-to-dev",
          model: TEST_CONTOUR_SPARK_MODEL,
          port,
          url: `http://127.0.0.1:${port}/`,
        };
      },
    });

    assert.equal(preparedSource.kind, "dev");
    assert.equal(preparedSource.headCommit, "dev-head-current");
    assert.equal(launchedCandidate.releaseId, "release-dev");
    assert.equal(result.refreshOutcome, "refreshed");
    assert.deepEqual(JSON.parse(await readFile(paths.sourceFile, "utf8")), {
      kind: "dev",
      branch: "dev",
      headCommit: "dev-head-current",
      sourceRoot: canonicalPath(sourceRoot),
      contourId: "contour-main-to-dev",
      port,
      model: TEST_CONTOUR_SPARK_MODEL,
      preparedAt: result.operation.createdAt,
      activatedAt: result.source.activatedAt,
      operationId: result.operation.operationId,
      releaseId: "release-dev",
    });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("restart reuses only the persisted release identity on its original port", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-restart-root-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-restart-source-"));
  const paths = testContourPaths(root);
  const releaseId = "release-restart";
  const releaseRoot = path.join(root, "releases", releaseId);
  const port = 18_879;
  const operationId = "operation-restart";
  let launch = null;
  let resolved = 0;
  try {
    await mkdir(releaseRoot, { recursive: true });
    await Promise.all([
      writeFile(paths.markerFile, JSON.stringify({
        kind: "agent-hub-test-contour",
        id: "contour-restart",
      }), "utf8"),
      writeFile(path.join(root, "current.json"), JSON.stringify({
        current: releaseId,
        previous: null,
      }), "utf8"),
      writeFile(paths.sourceFile, JSON.stringify({
        branch: "dev",
        headCommit: "head-restart",
        sourceRoot,
        contourId: "contour-restart",
        operationId,
        port,
        model: TEST_CONTOUR_SPARK_MODEL,
        releaseId,
      }), "utf8"),
      writeFile(path.join(releaseRoot, "agent-hub-main.mjs"), "export {};\n", "utf8"),
    ]);
    const result = await startTestContour({
      root,
      sourceRoot,
      port,
      model: TEST_CONTOUR_SPARK_MODEL,
      prepareSource: async () => {
        resolved += 1;
        return { sourceRoot, branch: "dev", headCommit: "head-restart" };
      },
      launchCandidate: async (options) => {
        launch = options;
        return {
          releaseId,
          operationId,
          port,
          url: `http://127.0.0.1:${port}/`,
        };
      },
    });
    assert.equal(result.releaseId, releaseId);
    assert.equal(launch.operation.operationId, operationId);
    assert.equal(launch.port, port);
    assert.equal(resolved, 1);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});
