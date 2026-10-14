import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { RunRecoveryCoordinator } from "../../src/application/run-recovery-coordinator.mjs";
import { ProviderRunTerminalStore } from "../../src/infrastructure/persistence/provider-run-terminal-store.mjs";
import {
  ClaudeCompletionService,
  CodexCompletionService,
} from "../../src/providers/provider-completion-services.mjs";
import { ProviderCancellationService } from "../../src/providers/provider-turn-services.mjs";
import {
  holdManualTestContourLock,
  readManualTestContourLockStatus,
  releaseManualTestContourLock,
} from "../../src/runtime/test-contour-manual-lock.mjs";
import {
  startTestContour,
  stopTestContour,
  verifyTestContour,
} from "../../src/runtime/test-contour-manager.mjs";

const fixture = path.resolve(import.meta.dirname, "../fixtures/test-contour-manual-lock-process.mjs");
const EXPECTED = Object.freeze({
  operationId: "operation-manual-1",
  headCommit: "a".repeat(40),
  releaseId: "release-manual-1",
});
const OWNER_TURN = Object.freeze({
  provider: "codex",
  threadId: "thread-manual-test",
  turnId: "turn-manual-test",
});

async function createOwnerLifecycle(dataDir, identity = OWNER_TURN) {
  await mkdir(dataDir, { recursive: true });
  const database = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  try {
    database.exec(`
      CREATE TABLE runtime_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE provider_turn_terminals (
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (provider, thread_id, turn_id)
      ) WITHOUT ROWID;
    `);
    database.prepare("INSERT INTO runtime_state VALUES ('main', ?, ?)").run(JSON.stringify({
      activeRuns: [{ ...identity, status: "running" }],
    }), new Date().toISOString());
  } finally {
    database.close();
  }
}

function removeActiveOwnerLifecycle(dataDir) {
  const database = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  try {
    database.prepare("UPDATE runtime_state SET value_json = ?, updated_at = ? WHERE key = 'main'")
      .run(JSON.stringify({ activeRuns: [] }), new Date().toISOString());
  } finally {
    database.close();
  }
}

function recordTerminalOwnerLifecycle(dataDir, identity = OWNER_TURN, status = "aborted") {
  const database = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  try {
    database.prepare("INSERT INTO provider_turn_terminals VALUES (?, ?, ?, ?, ?)")
      .run(identity.provider, identity.threadId, identity.turnId, status, new Date().toISOString());
  } finally {
    database.close();
  }
}

function ownerArguments(dataDir, identity = OWNER_TURN) {
  return {
    ownerProvider: identity.provider,
    ownerThreadId: identity.threadId,
    ownerTurnId: identity.turnId,
    ownerRuntimeDataDir: dataDir,
  };
}

function waitForMessage(child, type, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    timer.unref?.();
    const receive = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const exit = (code) => {
      cleanup();
      reject(new Error(`Manual lock fixture exited before ${type}: ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", exit);
    };
    child.on("message", receive);
    child.on("exit", exit);
  });
}

function spawnHolder(root, owner, requestId, ownerRuntimeDataDir, expected = EXPECTED, identity = OWNER_TURN) {
  return spawn(process.execPath, [
    fixture,
    root,
    owner,
    requestId,
    expected.operationId,
    expected.headCommit,
    expected.releaseId,
    ownerRuntimeDataDir,
    identity.provider,
    identity.threadId,
    identity.turnId,
  ], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
}

async function disposeRoot(root) {
  await rm(root, { recursive: true, force: true });
  await rm(`${root}-operation.lock`, { recursive: true, force: true });
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  const exit = once(child, "exit");
  child.kill();
  await exit;
}

function terminalLifecycle(run, store) {
  let active = true;
  const taskRuns = {
    add() {},
    remove() { active = false; },
    values() { return active ? [run] : []; },
    get size() { return active ? 1 : 0; },
  };
  const lifecycle = new ManagedRunLifecycleService({
    taskRuns,
    currentTarget: () => run,
    findProject: () => ({ name: "Test" }),
    codexSettings: () => ({}),
    currentPreferences: () => ({ model: "test", reasoningEffort: "test" }),
    normalizeCodexModel: (value) => value,
    modelLabel: (value) => value,
    persistTaskDiff: async () => {},
    syncRun() {},
    invalidateCatalog() {},
    saveState: async () => {},
    scheduleProgressStart() {},
    clearSelectedDiff() {},
    clearApprovals() {},
    pauseObservation() {},
    pauseClaude() {},
    stopTyping() {},
    prepareAdmission: async () => null,
    revokeAdmission() {},
    beforeCompletion: async () => {},
    completionAborted: async () => {},
    afterCompletion: async () => {},
    recordProviderTerminal: (terminal) => store.record(terminal),
  });
  return { lifecycle, taskRuns };
}

async function completeProviderRun(run, expectedStatus, lifecycle) {
  if (run.provider === "codex") {
    const service = new CodexCompletionService({
      runForTask: () => run,
      consumeTracker: () => ({ usage: {}, reported: false }),
      waitForCompletion: async () => null,
      finalizeDelivery: () => lifecycle.complete(run),
      finishProgress: async () => {},
      completedAnswer: async () => "terminal",
      rememberSeenTurn: async () => {},
      rememberLastMessage() {},
      temporaryFiles: new Map(),
      speechButtons: new Map(),
    });
    await service.completeManaged(run, {
      eventTurn: {
        id: run.turnId,
        status: expectedStatus === "aborted" ? "cancelled" : expectedStatus,
        ...(expectedStatus === "failed" ? { error: { message: "provider failed" } } : {}),
      },
    });
    return;
  }

  if (expectedStatus === "aborted") {
    const cancellation = new ProviderCancellationService({
      interruptCodex: async () => {},
      runForTask: () => run,
      completeRun: () => lifecycle.complete(run),
      readCodexSnapshot: async () => null,
      finishObserved: async () => {},
      completeManaged: async () => {},
      taskExternalActivity: async () => ({ state: "active" }),
      stopClaudeRun: async () => true,
      processIsAlive: () => false,
      claudeCancellationKey: (value) => `${value.provider}\0${value.threadId}`,
      saveState: async () => {},
      cancelledClaudeTasks: new Map(),
    });
    await cancellation.cancelClaude(run);
  }
  const service = new ClaudeCompletionService({
    runForTask: () => run,
    isSelectedRun: () => false,
    reindexRun() {},
    setSelectedThread() {},
    saveState: async () => {},
    finishProgress: async () => {},
    persistHistory: async () => {},
    projectWorkLog: async () => {},
    finalizeDelivery: () => lifecycle.complete(run),
    temporaryFiles: new Map(),
  });
  await service.completeManaged(run, expectedStatus === "aborted"
    ? { spawnError: new Error("cancelled process ended") }
    : {
        result: expectedStatus === "failed"
          ? { is_error: true, result: "provider failed" }
          : { result: "completed" },
        exitCode: expectedStatus === "failed" ? 1 : 0,
      });
}

async function completeObservedProviderRun(run, expectedStatus, lifecycle) {
  if (run.provider === "codex") {
    const service = new CodexCompletionService({
      runForTask: () => run,
      consumeTracker: () => ({ usage: {}, reported: false }),
      waitForCompletion: async () => null,
      finalizeDelivery: () => lifecycle.complete(run),
      finishProgress: async () => {},
      completedAnswer: async () => "terminal",
      rememberSeenTurn: async () => {},
      rememberLastMessage() {},
      temporaryFiles: new Map(),
      speechButtons: new Map(),
    });
    await service.completeObserved(run, {
      snapshot: { status: expectedStatus === "aborted" ? "cancelled" : expectedStatus },
      answer: "terminal",
      deliver: false,
      completedTurnId: run.turnId,
      tracker: { usage: {}, reported: false },
    });
    return;
  }
  const service = new ClaudeCompletionService({
    runForTask: () => run,
    isSelectedRun: () => false,
    reindexRun() {},
    setSelectedThread() {},
    saveState: async () => {},
    finishProgress: async () => {},
    persistHistory: async () => {},
    projectWorkLog: async () => {},
    finalizeDelivery: () => lifecycle.complete(run),
    temporaryFiles: new Map(),
  });
  await service.completeObserved(run, {
    snapshot: {
      status: expectedStatus,
      cancelled: expectedStatus === "aborted",
    },
    answer: "terminal",
    deliver: false,
  });
}

test("manual hold blocks refresh stop and existing verify until exact release", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-operations-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-source-"));
  const ownerRuntimeDataDir = path.join(root, "owner-runtime-data");
  await createOwnerLifecycle(ownerRuntimeDataDir);
  const child = spawnHolder(root, "S2", "manual-operations-1", ownerRuntimeDataDir);
  let operationResults = Promise.resolve([]);
  t.after(async () => {
    await stopChild(child);
    await operationResults;
    await Promise.all([disposeRoot(root), rm(sourceRoot, { recursive: true, force: true })]);
  });
  const acquired = (await waitForMessage(child, "acquired")).acquired;
  assert.equal((await readManualTestContourLockStatus({ root })).status, "held");

  let refreshEntered = false;
  let verifyEntered = false;
  const refresh = startTestContour({
    root,
    sourceRoot,
    refresh: true,
    prepareSource: async () => {
      refreshEntered = true;
      throw new Error("refresh-entered");
    },
  });
  const stop = stopTestContour({ root });
  const verify = verifyTestContour({
    root,
    sourceRoot,
    withAgent: false,
    startContour: async () => {
      verifyEntered = true;
      throw new Error("verify-entered");
    },
  });
  operationResults = Promise.allSettled([refresh, stop, verify]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshEntered, false);
  assert.equal(verifyEntered, false);

  const releasedMessage = waitForMessage(child, "released");
  const childExit = once(child, "exit");
  const unlocked = await releaseManualTestContourLock({
    root,
    requestId: acquired.requestId,
    acquisitionId: acquired.acquisitionId,
    releaseToken: acquired.releaseToken,
  });
  assert.equal(unlocked.status, "released");
  assert.equal((await releasedMessage).result.status, "released");
  await childExit;
  const results = await operationResults;
  assert.match(results[0].reason.message, /refresh-entered/u);
  assert.equal(results[1].status, "fulfilled");
  assert.match(results[2].reason.message, /verify-entered/u);
  assert.equal(refreshEntered, true);
  assert.equal(verifyEntered, true);
  assert.equal((await readManualTestContourLockStatus({ root })).status, "available");
});

test("manual acquisition is idempotent and rejects competing or stale unlock identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-identity-"));
  const ownerRuntimeDataDir = path.join(root, "owner-runtime-data");
  await createOwnerLifecycle(ownerRuntimeDataDir);
  const first = spawnHolder(root, "S2", "manual-identity-1", ownerRuntimeDataDir);
  const children = [first];
  t.after(async () => {
    await Promise.all(children.map((child) => stopChild(child)));
    await disposeRoot(root);
  });
  const acquired = (await waitForMessage(first, "acquired")).acquired;
  const repeated = await holdManualTestContourLock({
    root,
    owner: "S2",
    requestId: "manual-identity-1",
    expectedOperationId: EXPECTED.operationId,
    expectedHeadCommit: EXPECTED.headCommit,
    expectedReleaseId: EXPECTED.releaseId,
    ...ownerArguments(ownerRuntimeDataDir),
  });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.acquisitionId, acquired.acquisitionId);
  assert.equal(repeated.releaseToken, acquired.releaseToken);
  await assert.rejects(holdManualTestContourLock({
    root,
    owner: "S3",
    requestId: "manual-identity-2",
    expectedOperationId: EXPECTED.operationId,
    expectedHeadCommit: EXPECTED.headCommit,
    expectedReleaseId: EXPECTED.releaseId,
    ...ownerArguments(ownerRuntimeDataDir),
  }), /manually locked by S2/u);
  await assert.rejects(releaseManualTestContourLock({
    root,
    requestId: acquired.requestId,
    acquisitionId: acquired.acquisitionId,
    releaseToken: "wrong-token",
  }), /does not match/u);

  const releasedMessage = waitForMessage(first, "released");
  await releaseManualTestContourLock({
    root,
    requestId: acquired.requestId,
    acquisitionId: acquired.acquisitionId,
    releaseToken: acquired.releaseToken,
  });
  await releasedMessage;
  const repeatedRelease = await releaseManualTestContourLock({
    root,
    requestId: acquired.requestId,
    acquisitionId: acquired.acquisitionId,
    releaseToken: acquired.releaseToken,
  });
  assert.equal(repeatedRelease.reused, true);
  const repeatedAcquire = await holdManualTestContourLock({
    root,
    owner: "S2",
    requestId: "manual-identity-1",
    expectedOperationId: EXPECTED.operationId,
    expectedHeadCommit: EXPECTED.headCommit,
    expectedReleaseId: EXPECTED.releaseId,
    ...ownerArguments(ownerRuntimeDataDir),
  });
  assert.equal(repeatedAcquire.status, "released");
  assert.equal(repeatedAcquire.reused, true);

  const second = spawnHolder(root, "S3", "manual-identity-2", ownerRuntimeDataDir);
  children.push(second);
  const secondAcquired = (await waitForMessage(second, "acquired")).acquired;
  await releaseManualTestContourLock({
    root,
    requestId: acquired.requestId,
    acquisitionId: acquired.acquisitionId,
    releaseToken: acquired.releaseToken,
  });
  assert.equal((await readManualTestContourLockStatus({ root })).acquisitionId, secondAcquired.acquisitionId);
  const secondReleased = waitForMessage(second, "released");
  const secondExit = once(second, "exit");
  await releaseManualTestContourLock({
    root,
    requestId: secondAcquired.requestId,
    acquisitionId: secondAcquired.acquisitionId,
    releaseToken: secondAcquired.releaseToken,
  });
  await secondReleased;
  await secondExit;
});

test("confirmed owner death and cancellation release the canonical contour lock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-death-"));
  const ownerRuntimeDataDir = path.join(root, "owner-runtime-data");
  await createOwnerLifecycle(ownerRuntimeDataDir);
  const dead = spawnHolder(root, "S2", "manual-death-1", ownerRuntimeDataDir);
  t.after(() => disposeRoot(root));
  const acquired = (await waitForMessage(dead, "acquired")).acquired;
  const deadExit = once(dead, "exit");
  dead.kill();
  await deadExit;
  assert.equal((await readManualTestContourLockStatus({ root })).status, "stale");
  const reconciled = await holdManualTestContourLock({
    root,
    owner: "S2",
    requestId: acquired.requestId,
    expectedOperationId: EXPECTED.operationId,
    expectedHeadCommit: EXPECTED.headCommit,
    expectedReleaseId: EXPECTED.releaseId,
    ...ownerArguments(ownerRuntimeDataDir),
  });
  assert.equal(reconciled.status, "released");
  assert.equal(reconciled.releaseReason, "owner-dead");

  const cancelled = spawnHolder(root, "S3", "manual-cancel-1", ownerRuntimeDataDir);
  const cancelledAcquired = (await waitForMessage(cancelled, "acquired")).acquired;
  const failed = waitForMessage(cancelled, "failed");
  const cancelledExit = once(cancelled, "exit");
  cancelled.send({ type: "cancel" });
  assert.match((await failed).message, /fixture-cancelled/u);
  await cancelledExit;
  const terminal = await releaseManualTestContourLock({
    root,
    requestId: cancelledAcquired.requestId,
    acquisitionId: cancelledAcquired.acquisitionId,
    releaseToken: cancelledAcquired.releaseToken,
  });
  assert.equal(terminal.status, "released");
  assert.equal(terminal.releaseReason, "cancelled");
  assert.equal((await readManualTestContourLockStatus({ root })).status, "available");
});

test("manual locks for different contour roots do not block each other", async (t) => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-root-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-root-b-"));
  const firstOwnerRuntimeDataDir = path.join(firstRoot, "owner-runtime-data");
  const secondOwnerRuntimeDataDir = path.join(secondRoot, "owner-runtime-data");
  await Promise.all([
    createOwnerLifecycle(firstOwnerRuntimeDataDir),
    createOwnerLifecycle(secondOwnerRuntimeDataDir),
  ]);
  const first = spawnHolder(firstRoot, "S2", "manual-root-a", firstOwnerRuntimeDataDir);
  const second = spawnHolder(secondRoot, "S3", "manual-root-b", secondOwnerRuntimeDataDir);
  t.after(async () => {
    await Promise.all([stopChild(first), stopChild(second)]);
    await Promise.all([disposeRoot(firstRoot), disposeRoot(secondRoot)]);
  });
  const [firstAcquired, secondAcquired] = await Promise.all([
    waitForMessage(first, "acquired").then((message) => message.acquired),
    waitForMessage(second, "acquired").then((message) => message.acquired),
  ]);
  assert.equal((await readManualTestContourLockStatus({ root: firstRoot })).owner, "S2");
  assert.equal((await readManualTestContourLockStatus({ root: secondRoot })).owner, "S3");
  const firstReleased = waitForMessage(first, "released");
  const secondReleased = waitForMessage(second, "released");
  const firstExit = once(first, "exit");
  const secondExit = once(second, "exit");
  await Promise.all([
    releaseManualTestContourLock({
      root: firstRoot,
      requestId: firstAcquired.requestId,
      acquisitionId: firstAcquired.acquisitionId,
      releaseToken: firstAcquired.releaseToken,
    }),
    releaseManualTestContourLock({
      root: secondRoot,
      requestId: secondAcquired.requestId,
      acquisitionId: secondAcquired.acquisitionId,
      releaseToken: secondAcquired.releaseToken,
    }),
  ]);
  await Promise.all([firstReleased, secondReleased]);
  await Promise.all([firstExit, secondExit]);
});

test("manual acquisition rejects a version that changed before the lock was acquired", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-version-race-"));
  const ownerRuntimeDataDir = path.join(root, "owner-runtime-data");
  await createOwnerLifecycle(ownerRuntimeDataDir);
  t.after(() => disposeRoot(root));
  await assert.rejects(holdManualTestContourLock({
    root,
    owner: "S2",
    requestId: "manual-version-race",
    expectedOperationId: EXPECTED.operationId,
    expectedHeadCommit: EXPECTED.headCommit,
    expectedReleaseId: EXPECTED.releaseId,
    ...ownerArguments(ownerRuntimeDataDir),
    readStatus: async () => ({
      running: true,
      status: "ready",
      planned: false,
      state: {
        operationId: EXPECTED.operationId,
        releaseId: "newer-release",
        source: { headCommit: "b".repeat(40) },
      },
      readback: { outcome: "exact" },
    }),
  }), /expected headCommit/u);
  assert.equal((await readManualTestContourLockStatus({ root })).status, "available");
});

test("manual acquisition requires the exact owner turn to be active", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-owner-inactive-"));
  const ownerRuntimeDataDir = path.join(root, "owner-runtime-data");
  await createOwnerLifecycle(ownerRuntimeDataDir);
  removeActiveOwnerLifecycle(ownerRuntimeDataDir);
  t.after(() => disposeRoot(root));
  await assert.rejects(holdManualTestContourLock({
    root,
    owner: "S2",
    requestId: "manual-owner-inactive",
    expectedOperationId: EXPECTED.operationId,
    expectedHeadCommit: EXPECTED.headCommit,
    expectedReleaseId: EXPECTED.releaseId,
    ...ownerArguments(ownerRuntimeDataDir),
    readStatus: async () => { throw new Error("version check must not run for an inactive owner"); },
  }), /requires an active owner turn; lifecycle is unknown/u);
  assert.equal((await readManualTestContourLockStatus({ root })).status, "available");
});

test("terminal owner turn releases a surviving foreground helper without timeout stealing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manual-contour-owner-terminal-"));
  const ownerRuntimeDataDir = path.join(root, "owner-runtime-data");
  await createOwnerLifecycle(ownerRuntimeDataDir);
  const child = spawnHolder(root, "S2", "manual-owner-terminal", ownerRuntimeDataDir);
  t.after(async () => {
    await stopChild(child);
    await disposeRoot(root);
  });
  await waitForMessage(child, "acquired");
  const released = waitForMessage(child, "released");
  const childExit = once(child, "exit");
  removeActiveOwnerLifecycle(ownerRuntimeDataDir);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(child.exitCode, null);
  assert.equal((await readManualTestContourLockStatus({ root })).status, "held");
  recordTerminalOwnerLifecycle(ownerRuntimeDataDir, OWNER_TURN, "aborted");
  const terminal = (await released).result;
  await childExit;
  assert.equal(terminal.status, "released");
  assert.equal(terminal.releaseReason, "owner-terminal:aborted");
  assert.equal((await readManualTestContourLockStatus({ root })).status, "available");
});

test("real Codex and Claude terminal paths release a surviving manual holder", async (t) => {
  const resources = [];
  t.after(async () => {
    for (const { child, root } of resources) {
      await stopChild(child);
      await disposeRoot(root);
    }
  });
  for (const provider of ["codex", "claude"]) {
    for (const expectedStatus of ["completed", "failed", "aborted"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agent-hub-manual-${provider}-${expectedStatus}-`));
      const ownerRuntimeDataDir = path.join(root, "owner-runtime-data");
      const identity = {
        provider,
        threadId: `${provider}-${expectedStatus}-thread`,
        turnId: `${provider}-${expectedStatus}-turn`,
      };
      await createOwnerLifecycle(ownerRuntimeDataDir, identity);
      const store = new ProviderRunTerminalStore({ dataDir: ownerRuntimeDataDir });
      const child = spawnHolder(
        root,
        provider,
        `${provider}-${expectedStatus}-request`,
        ownerRuntimeDataDir,
        EXPECTED,
        identity,
      );
      resources.push({ child, root });
      await waitForMessage(child, "acquired");
      const released = waitForMessage(child, "released");
      const childExit = once(child, "exit");
      const run = {
        ...identity,
        status: "running",
        responseText: "",
        process: provider === "claude" && expectedStatus === "aborted" ? {} : null,
      };
      const { lifecycle } = terminalLifecycle(run, store);
      await completeProviderRun(run, expectedStatus, lifecycle);
      const result = (await released).result;
      await childExit;
      assert.equal(result.releaseReason, `owner-terminal:${expectedStatus}`, `${provider} ${expectedStatus}`);
      assert.equal(store.get(identity).status, expectedStatus, `${provider} ${expectedStatus}`);
    }
  }
});

test("recovery read failure stays unknown until exact Codex or Claude terminal evidence", async (t) => {
  const resources = [];
  t.after(async () => {
    for (const { child, root } of resources) {
      await stopChild(child);
      await disposeRoot(root);
    }
  });
  for (const provider of ["codex", "claude"]) {
    for (const expectedStatus of ["completed", "failed", "aborted"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), `agent-hub-manual-recovery-${provider}-${expectedStatus}-`));
      const ownerRuntimeDataDir = path.join(root, "owner-runtime-data");
      const identity = {
        provider,
        threadId: `${provider}-${expectedStatus}-recovery-thread`,
        turnId: `${provider}-${expectedStatus}-recovery-turn`,
      };
      await createOwnerLifecycle(ownerRuntimeDataDir, identity);
      const store = new ProviderRunTerminalStore({ dataDir: ownerRuntimeDataDir });
      const child = spawnHolder(
        root,
        provider,
        `${provider}-${expectedStatus}-recovery-request`,
        ownerRuntimeDataDir,
        EXPECTED,
        identity,
      );
      resources.push({ child, root });
      await waitForMessage(child, "acquired");
      const run = {
        ...identity,
        id: `${provider}-${expectedStatus}-recovery-run`,
        status: "running",
        responseText: "",
        observer: true,
        process: provider === "claude" && expectedStatus === "aborted" ? {} : null,
      };
      const { lifecycle, taskRuns } = terminalLifecycle(run, store);
      const recovery = new RunRecoveryCoordinator({
        taskRuns,
        providers: {
          get: () => ({ name: provider }),
          call: async (_provider, operation) => {
            if (operation === "readRecoverySnapshot") {
              throw new Error("temporary provider read failure");
            }
            return null;
          },
        },
        runCoordinator: { recoverProviderRun: async () => {} },
        observer: {
          update() {}, schedule() {},
          finish: async () => {}, finishUnknown: async () => {},
        },
        progress: {
          replace: async () => {}, clear: async () => {}, finish: async () => {},
        },
        startTyping() {}, saveState: async () => {},
        safeDeliver: async (_run, send) => send(), sendRunMessage: async () => {},
        completeRun: (value) => lifecycle.complete(value), logError() {},
      });

      await recovery.recoverAll();
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal(child.exitCode, null, `${provider} ${expectedStatus} holder survives unknown recovery`);
      assert.equal((await readManualTestContourLockStatus({ root })).status, "held");
      assert.equal(store.get(identity), null);
      assert.equal(run.providerTerminalStatus, undefined);
      assert.equal(taskRuns.size, 1);

      const released = waitForMessage(child, "released");
      const childExit = once(child, "exit");
      await completeObservedProviderRun(run, expectedStatus, lifecycle);
      const result = (await released).result;
      await childExit;
      assert.equal(result.releaseReason, `owner-terminal:${expectedStatus}`, `${provider} ${expectedStatus}`);
      assert.equal(store.get(identity).status, expectedStatus, `${provider} ${expectedStatus}`);
    }
  }
});
