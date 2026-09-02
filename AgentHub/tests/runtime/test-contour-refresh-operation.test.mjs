import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  beginTestContourOperation,
  readTestContourOperationDocument,
  testContourOperationReadback,
  transitionTestContourOperation,
} from "../../src/runtime/test-contour-operation-state.mjs";
import {
  readyTestContourHealth,
  startTestContour,
  TEST_CONTOUR_SPARK_MODEL,
  testContourPaths,
  verifyTestContour,
} from "../../src/runtime/test-contour-manager.mjs";

const fixture = path.resolve(import.meta.dirname, "..", "fixtures", "test-contour-operation-process.mjs");

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
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, live: true, ready: true, status: "ready" }));
      return;
    }
    const identity = server.testContourIdentity;
    if (request.url === "/test-contour-identity.js" && identity) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ kind: "agent-hub-test-contour-runtime", ...identity }));
      return;
    }
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
  await writeFile(paths.sourceFile, JSON.stringify({
    branch: "dev",
    headCommit,
    sourceRoot: root,
    releaseId,
  }), "utf8");
  await writeFile(paths.stateFile, JSON.stringify({
    contourId: "test-contour-refresh",
    managerPid: process.pid,
    runtimePid: process.pid,
    releaseId,
    operationId,
    source: { branch: "dev", headCommit },
    model: TEST_CONTOUR_SPARK_MODEL,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/`,
  }), "utf8");
  server.testContourIdentity = {
    contourId: "test-contour-refresh",
    releaseId,
    operationId,
    port: server.address().port,
  };
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
      launchCandidate: async ({ candidate, operation, onManagerSpawn }) => {
        await onManagerSpawn({ pid: process.pid });
        return {
          contourId: "test-contour-refresh",
          managerPid: process.pid,
          runtimePid: process.pid,
          releaseId: candidate.releaseId,
          operationId: operation.operationId,
          source: { branch: candidate.branch, headCommit: candidate.headCommit },
          model: TEST_CONTOUR_SPARK_MODEL,
          port: 8877,
          url: "http://localhost:8877/",
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

test("same-source refresh coalesces without stopping the ready runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-coalesce-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-coalesce-source-"));
  const server = await healthServer();
  await writeRunningContour(root, server, { headCommit: "head-same" });
  let prepared = false;
  let stopped = false;
  try {
    const result = await startTestContour({
      root,
      sourceRoot,
      entryFile: "unused-test-entry.mjs",
      refresh: true,
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

test("ready runtime is finalized after refresh owner crash without a duplicate restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-recover-ready-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-contour-recover-source-"));
  const server = await healthServer();
  const operation = await beginTestContourOperation(root, {
    source: { branch: "dev", headCommit: "head-recovered", sourceRoot },
    target: { root, contourId: "test-contour-refresh", port: server.address().port },
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
  const server = await healthServer();
  const port = server.address().port;
  server.testContourIdentity = {
    contourId: "shared-contour",
    releaseId: "shared-release",
    operationId: "shared-operation",
    port,
  };
  try {
    assert.equal(await readyTestContourHealth(port, {
      expectedIdentity: {
        contourId: "isolated-contour",
        releaseId: "isolated-release",
        operationId: "isolated-operation",
        port,
      },
    }), null);
    assert.equal((await readyTestContourHealth(port, {
      expectedIdentity: server.testContourIdentity,
    }))?.ready, true);
  } finally {
    await closeServer(server);
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
    assert.equal(calls[0].options.root, root);
    assert.equal(calls[0].options.port, port);
    assert.equal(calls[1].options.url, `http://127.0.0.1:${port}/`);
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
        releaseId,
      }), "utf8"),
      writeFile(path.join(releaseRoot, "agent-hub-main.mjs"), "export {};\n", "utf8"),
    ]);
    const result = await startTestContour({
      root,
      sourceRoot,
      port,
      model: TEST_CONTOUR_SPARK_MODEL,
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
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(`${root}-operation.lock`, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});
