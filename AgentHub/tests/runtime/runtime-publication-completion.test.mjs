import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publicationAwareReadiness, resumeRuntimePublicationCompletion } from "../../src/runtime/runtime-publication-completion.mjs";
import { publicationRunStore } from "../../src/infrastructure/persistence/publication-run-store.mjs";
import { publicationCheckpointStore } from "../../src/infrastructure/persistence/publication-checkpoint.mjs";
import {
  PUBLICATION_STAGE_DELEGATION_ENV,
  withPublicationLock,
} from "../../src/infrastructure/process/publication-lock.mjs";

const publicationLockUrl = pathToFileURL(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/infrastructure/process/publication-lock.mjs",
)).href;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function removeFixtureRoot(root) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["ENOTEMPTY", "EPERM", "EBUSY"].includes(error?.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-resume-"));
  t.after(() => removeFixtureRoot(root));
  const journal = publicationRunStore({ runtimeRoot: root });
  const checkpoint = publicationCheckpointStore(path.join(root, "publication-checkpoint.json"));
  const identity = { runtimeRoot: root, worktreeRoot: path.join(root, "clone"), revision: "a".repeat(40), release: { workspaceId: "workspace" } };
  await journal.start(identity, []);
  await journal.updateProgress({
    expectedReleaseId: "release-1", finalizationCommandId: "original-finalization-command",
    publicationState: { revision: identity.revision, generation: "original-generation" },
  });
  await journal.finish("awaiting_restart");
  await checkpoint.write({ completedLabels: ["build", "deploy", "git"] });
  return { root, journal, checkpoint, identity };
}

async function defaultRuntimeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-default-resume-"));
  const runtimeRoot = path.join(root, "AgentHub");
  t.after(() => removeFixtureRoot(root));
  const journal = publicationRunStore({ runtimeRoot });
  const checkpoint = publicationCheckpointStore(path.join(runtimeRoot, "publication-checkpoint.json"));
  const identity = {
    runtimeRoot,
    worktreeRoot: path.join(root, "clone"),
    revision: "b".repeat(40),
    release: { workspaceId: "workspace" },
  };
  await journal.start(identity, []);
  await journal.updateProgress({
    expectedReleaseId: "release-ready",
    finalizationCommandId: "default-finalization-command",
    publicationState: { revision: identity.revision, generation: "default-generation" },
  });
  await journal.finish("awaiting_restart");
  await checkpoint.write({ completedLabels: ["build", "deploy"] });
  return { root, runtimeRoot, journal, checkpoint, identity };
}

function restoreEnvironment(previous) {
  for (const key of ["LOCALAPPDATA", "XDG_STATE_HOME", "AGENT_HUB_PUBLICATION_SESSION", PUBLICATION_STAGE_DELEGATION_ENV]) {
    if (previous[key] == null) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

async function captureReleasedPublicationMarkers(runtimeRoot) {
  let markers = null;
  await withPublicationLock(async () => {
    markers = {
      AGENT_HUB_PUBLICATION_SESSION: process.env.AGENT_HUB_PUBLICATION_SESSION,
      [PUBLICATION_STAGE_DELEGATION_ENV]: process.env[PUBLICATION_STAGE_DELEGATION_ENV],
    };
  }, {
    lockTarget: path.join(runtimeRoot, "publication"),
    timeoutMs: 1_000,
  });
  return markers;
}

function readyRuntimeHooks({ identity, events }) {
  return {
    readRuntimeStatus: async () => ({
      current: "release-ready",
      runningRelease: "release-ready",
      running: true,
      ready: true,
      pid: 321,
    }),
    verifyRestart: async ({ expectedReleaseId, readStatus }) => {
      assert.equal(expectedReleaseId, "release-ready");
      assert.equal((await readStatus({ runtimeRoot: identity.runtimeRoot })).pid, 321);
      events.push("verified");
    },
    createAdapter: ({ repositoryRoot, runtimeRoot }) => {
      assert.equal(repositoryRoot, identity.worktreeRoot);
      assert.equal(runtimeRoot, identity.runtimeRoot);
      return {
        finalizePublication: async (recovered) => {
          events.push("finalized");
          assert.equal(recovered.finalizationCommandId, "default-finalization-command");
          assert.equal(recovered.publication.generation, "default-generation");
          return { status: "completed" };
        },
      };
    },
  };
}

async function assertDefaultRecoveryCompletes({ runtimeRoot, journal, checkpoint, identity }) {
  const events = [];
  const result = await resumeRuntimePublicationCompletion({
    runtimeRoot,
    journal,
    checkpoint,
    ...readyRuntimeHooks({ identity, events }),
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(events, ["verified", "finalized"]);
  assert.equal((await journal.read()).status, "succeeded");
  const state = JSON.parse(await readFile(path.join(runtimeRoot, "publication-state.json"), "utf8"));
  assert.equal(state.generation, "default-generation");
  assert.equal(state.revision, identity.revision);
  assert.equal(await checkpoint.read(), null);
}

async function startLockHolder({ runtimeRoot, readyFile, releaseFile }) {
  const script = `
    import { access, writeFile } from "node:fs/promises";
    import { withPublicationLock } from ${JSON.stringify(publicationLockUrl)};
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    await withPublicationLock(async () => {
      await writeFile(${JSON.stringify(readyFile)}, "ready", "utf8");
      for (;;) {
        if (await access(${JSON.stringify(releaseFile)}).then(() => true, () => false)) return;
        await delay(25);
      }
    }, {
      lockTarget: ${JSON.stringify(path.join(runtimeRoot, "publication"))},
      timeoutMs: 1_000,
    });
  `;
  const child = execFile(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const childDone = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`lock holder exited with ${signal ?? `code ${code}`}`));
    });
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await readFile(readyFile, "utf8").then(() => true, () => false)) return { child, childDone };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  throw new Error("lock holder did not acquire publication lock");
}

test("readiness resumes durable finalization without input and coalesces duplicate resume signals", async (t) => {
  const { root, journal, checkpoint } = await fixture(t);
  const queued = [];
  const events = [];
  const finalizationCommandIds = [];
  let finalizations = 0;
  const resume = () => resumeRuntimePublicationCompletion({
    runtimeRoot: root,
    journal,
    checkpoint,
    lock: async (operation) => operation(),
    readRuntimeStatus: async () => ({
      current: "release-1", runningRelease: "release-1", running: true, ready: true, pid: 123,
    }),
    verifyRestart: async () => events.push("verified"),
    createAdapter: () => ({
      finalizePublication: async ({ finalizationCommandId }) => {
        finalizations += 1;
        finalizationCommandIds.push(finalizationCommandId);
        events.push(`finalized:${finalizations}`);
        return { status: finalizations === 1 ? "retry_required" : "completed" };
      },
    }),
  });
  const markReady = publicationAwareReadiness({
    markReady: async () => events.push("ready"),
    resume,
    retryDelayMs: 25,
    maxFinalizationAttempts: 2,
    schedule: (operation, delayMs) => queued.push({ operation, delayMs }),
  });
  await Promise.all([markReady(), markReady()]);
  assert.deepEqual(events, ["ready", "ready"]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].delayMs, 0);
  await queued.shift().operation();
  assert.equal((await journal.read()).status, "awaiting_finalization");
  assert.deepEqual(events, ["ready", "ready", "verified", "finalized:1"]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].delayMs, 25);
  await markReady();
  assert.equal(queued.length, 1);
  await queued.shift().operation();
  assert.equal((await journal.read()).status, "succeeded");
  assert.equal(await checkpoint.read(), null);
  assert.deepEqual(events, [
    "ready", "ready", "verified", "finalized:1", "ready", "verified", "finalized:2",
  ]);
  assert.equal(finalizationCommandIds.length, 2);
  assert.notEqual(finalizationCommandIds[0], finalizationCommandIds[1]);
  await markReady();
  assert.equal(queued.length, 0);
  assert.equal(finalizations, 2);

  const blockedQueue = [];
  const errors = [];
  let blockedAttempts = 0;
  const blocked = publicationAwareReadiness({
    markReady: async () => {},
    maxFinalizationAttempts: 2,
    retryDelayMs: 25,
    schedule: (operation, delayMs) => blockedQueue.push({ operation, delayMs }),
    resume: async () => {
      blockedAttempts += 1;
      return { status: "awaiting_finalization" };
    },
    onError: (error) => errors.push(error.message),
  });
  await blocked();
  await blockedQueue.shift().operation();
  await blockedQueue.shift().operation();
  assert.equal(blockedAttempts, 2);
  assert.equal(blockedQueue.length, 0);
  assert.deepEqual(errors, [
    "Publication completion remains awaiting_finalization after 2 automatic attempts",
  ]);
});

test("readiness schedules completion once after ready without waiting for completion", async () => {
  const ready = deferred();
  const completion = deferred();
  const queued = [];
  const events = [];
  const markReady = publicationAwareReadiness({
    markReady: async () => { await ready.promise; events.push("ready"); },
    schedule: (operation) => queued.push(operation),
    resume: async () => { events.push("resume"); await completion.promise; events.push("completed"); },
  });
  const starting = markReady();
  assert.equal(queued.length, 0);
  ready.resolve();
  await starting;
  assert.deepEqual(events, ["ready"]);
  assert.equal(queued.length, 1);
  const finishing = queued[0]();
  await Promise.resolve();
  assert.deepEqual(events, ["ready", "resume"]);
  await markReady();
  assert.equal(queued.length, 1);
  completion.resolve();
  await finishing;
  assert.equal(events.at(-1), "completed");
});

test("ready runtime completes its durable pending release without publishing operations", async (t) => {
  const { root, journal, checkpoint, identity } = await fixture(t);
  const events = [];
  const status = { current: "release-1", runningRelease: "release-1", running: true, ready: true, pid: 123 };
  const options = {
    runtimeRoot: root, journal, checkpoint,
    lock: async (operation) => operation(),
    readRuntimeStatus: async () => status,
    verifyRestart: async ({ expectedReleaseId, readStatus }) => {
      assert.equal(expectedReleaseId, "release-1");
      assert.equal((await readStatus({ runtimeRoot: root })).pid, 123);
      events.push("verified");
    },
    createAdapter: ({ repositoryRoot, runtimeRoot }) => {
      assert.equal(repositoryRoot, identity.worktreeRoot);
      assert.equal(runtimeRoot, root);
      return { finalizePublication: async (recovered) => {
        events.push("finalized");
        assert.equal(recovered.finalizationCommandId, "original-finalization-command");
        assert.equal(recovered.publication.generation, "original-generation");
        return { status: "completed" };
      } };
    },
  };
  assert.equal((await resumeRuntimePublicationCompletion(options)).status, "succeeded");
  assert.deepEqual(events, ["verified", "finalized"]);
  assert.equal((await journal.read()).status, "succeeded");
  assert.equal((JSON.parse(await readFile(path.join(root, "publication-state.json"), "utf8"))).generation, "original-generation");
  assert.equal(await checkpoint.read(), null);
  assert.equal((await resumeRuntimePublicationCompletion(options)).status, "not_pending");
  assert.deepEqual(events, ["verified", "finalized"]);
});

test("default runtime recovery completes with the default lock and publication-state writer", async (t) => {
  const fixtureState = await defaultRuntimeFixture(t);
  const previous = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    AGENT_HUB_PUBLICATION_SESSION: process.env.AGENT_HUB_PUBLICATION_SESSION,
    [PUBLICATION_STAGE_DELEGATION_ENV]: process.env[PUBLICATION_STAGE_DELEGATION_ENV],
  };
  try {
    process.env.LOCALAPPDATA = fixtureState.root;
    delete process.env.XDG_STATE_HOME;
    delete process.env.AGENT_HUB_PUBLICATION_SESSION;
    delete process.env[PUBLICATION_STAGE_DELEGATION_ENV];
    await assertDefaultRecoveryCompletes(fixtureState);
  } finally {
    restoreEnvironment(previous);
  }
});

test("default runtime recovery ignores stale inherited publisher ownership", async (t) => {
  const fixtureState = await defaultRuntimeFixture(t);
  const previous = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    AGENT_HUB_PUBLICATION_SESSION: process.env.AGENT_HUB_PUBLICATION_SESSION,
    [PUBLICATION_STAGE_DELEGATION_ENV]: process.env[PUBLICATION_STAGE_DELEGATION_ENV],
  };
  try {
    process.env.LOCALAPPDATA = fixtureState.root;
    delete process.env.XDG_STATE_HOME;
    const stale = await captureReleasedPublicationMarkers(fixtureState.runtimeRoot);
    Object.assign(process.env, stale);
    await assertDefaultRecoveryCompletes(fixtureState);
  } finally {
    restoreEnvironment(previous);
  }
});

test("default runtime recovery waits for a live publisher then owns nested default writes", async (t) => {
  const fixtureState = await defaultRuntimeFixture(t);
  const readyFile = path.join(fixtureState.root, "publisher-ready.txt");
  const releaseFile = path.join(fixtureState.root, "publisher-release.txt");
  const previous = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    AGENT_HUB_PUBLICATION_SESSION: process.env.AGENT_HUB_PUBLICATION_SESSION,
    [PUBLICATION_STAGE_DELEGATION_ENV]: process.env[PUBLICATION_STAGE_DELEGATION_ENV],
  };
  let holder = null;
  try {
    process.env.LOCALAPPDATA = fixtureState.root;
    delete process.env.XDG_STATE_HOME;
    delete process.env.AGENT_HUB_PUBLICATION_SESSION;
    delete process.env[PUBLICATION_STAGE_DELEGATION_ENV];
    holder = await startLockHolder({
      runtimeRoot: fixtureState.runtimeRoot,
      readyFile,
      releaseFile,
    });
    const completion = assertDefaultRecoveryCompletes(fixtureState);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await fixtureState.journal.read()).status, "awaiting_restart");
    await writeFile(releaseFile, "release", "utf8");
    await holder.childDone;
    await completion;
  } finally {
    if (holder) {
      await writeFile(releaseFile, "release", "utf8").catch(() => {});
      await holder.childDone.catch(() => {});
    }
    restoreEnvironment(previous);
  }
});

test("inherited publisher session cannot bypass the live owner and state is reread under its lock", async (t) => {
  const { root, journal, checkpoint } = await fixture(t);
  const permit = deferred();
  const entered = deferred();
  const environment = { AGENT_HUB_PUBLICATION_SESSION: "inherited-old-publisher" };
  let finalizations = 0;
  const pending = resumeRuntimePublicationCompletion({
    runtimeRoot: root, journal, checkpoint, environment,
    lock: (operation, options) => withPublicationLock(operation, {
      ...options,
      lock: async (targets, acquired) => {
        assert.deepEqual(targets, [path.join(root, "publication")]);
        entered.resolve();
        await permit.promise;
        return acquired();
      },
    }),
    createAdapter: () => { finalizations += 1; throw new Error("must not finalize twice"); },
  });
  await entered.promise;
  assert.equal(finalizations, 0);
  assert.equal(environment.AGENT_HUB_PUBLICATION_SESSION, "inherited-old-publisher");
  // The original publisher finishes while recovery is waiting for its lease.
  await journal.finish("succeeded");
  permit.resolve();
  assert.equal((await pending).status, "not_pending");
  assert.equal(finalizations, 0);
});

test("foreign-root pending state and absent state are no-ops", async (t) => {
  const { root, journal } = await fixture(t);
  const lock = () => { throw new Error("unrelated state must not acquire publication ownership"); };
  assert.equal((await resumeRuntimePublicationCompletion({ runtimeRoot: `${root}-other`, journal, lock })).status, "not_pending");
  assert.equal((await resumeRuntimePublicationCompletion({ runtimeRoot: path.join(root, "empty-runtime"), lock })).status, "not_pending");
});

test("background completion failure is reported after readiness without reopening startup", async () => {
  const queued = [];
  const errors = [];
  const markReady = publicationAwareReadiness({
    markReady: async () => {}, schedule: (operation) => queued.push(operation),
    resume: async () => { throw new Error("finalization unavailable"); },
    onError: (error) => errors.push(error.message),
  });
  await markReady();
  await queued[0]();
  assert.deepEqual(errors, ["finalization unavailable"]);
});
