import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicationAwareReadiness, resumeRuntimePublicationCompletion } from "../../src/runtime/runtime-publication-completion.mjs";
import { publicationRunStore } from "../../src/infrastructure/persistence/publication-run-store.mjs";
import { publicationCheckpointStore } from "../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { withPublicationLock } from "../../src/infrastructure/process/publication-lock.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
