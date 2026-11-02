import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import { packageBindingDigest, packageDigest, packageDirectory, packageFile } from "../../src/infrastructure/filesystem/runtime-package-target.mjs";

async function fixture(t, mutate = () => {}, options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "hb398-attempt-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, "runtime"), data = path.join(root, "data"), scratch = path.join(base, "scratch");
  await mkdir(data, { recursive: true }); await mkdir(scratch);
  const input = { operationId: "same-package-original", tag: "2.1.3" };
  for (const key of ["archive", "descriptor", "installer"]) {
    input[key] = path.join(scratch, key); await writeFile(input[key], `fixed-${key}`);
  }
  const target = { schema: 1, tag: input.tag, releaseId: "target", sourceCommit: "a".repeat(40), version: "2.1.3+build.123" };
  for (const key of ["archive", "descriptor", "installer"]) target[key] = await packageFile(input[key]);
  const host = path.join(root, "AgentHub.RuntimeHost.exe"); await writeFile(host, "unit fixture; never execute");
  async function capture(releaseId) {
    const manifest = path.join(root, "releases", releaseId, "runtime-manifest.json");
    await mkdir(path.dirname(manifest), { recursive: true }); await writeFile(manifest, JSON.stringify({ releaseId }));
    const pointer = JSON.stringify({ current: releaseId }); await writeFile(path.join(root, "current.json"), pointer);
    const lock = { releaseId, pid: process.pid, ready: true, instanceToken: `fixture-${releaseId}` };
    await writeFile(path.join(data, "bot.lock"), JSON.stringify(lock));
    return { operationId: input.operationId, runtimeRoot: root, dataDir: data,
      roots: { runtime: await packageDirectory(root), data: await packageDirectory(data) },
      old: { releaseId, pid: process.pid, hostPid: process.ppid,
        currentSha256: packageDigest(pointer), manifestSha256: packageDigest(await readFile(manifest)),
        instanceSha256: packageDigest(lock.instanceToken), launcher: await packageFile(host) },
      target, scratchRoot: scratch, hostCopy: host };
  }
  const envelope = binding => ({ schema: 1, binding, sha256: packageBindingDigest(binding) });
  const old = envelope(await capture("old"));
  const store = new MaintenanceOperationStore({ dataDir: data });
  const row = { operationId: input.operationId, kind: "restart", streamId: "agent-hub-runtime", threadId: "agent-hub-runtime",
    status: "failed", phase: "failed", outcome: "failed", metadata: { packageInputSha256: packageBindingDigest(input),
      packageHandoff: old, packagePreStopFailure: { schema: 1, phase: "package-backup-preflight", bindingSha256: old.sha256, attempt: 1 }, error: "prior failure" } };
  mutate(row);
  const prior = store.create(row);
  let prepared = envelope(await capture("fresh")), request = null, preparations = 0, saves = 0, schedules = 0;
  const service = new RestartRequestService({ operationStore: store, currentTarget: () => ({}),
    preparePackage: async () => { preparations++; return structuredClone(prepared); },
    getRequest: () => request, setRequest: value => { request = value; },
    blockingWorkCount: () => 1, currentChatId: () => null, updateOffset: () => 17,
    saveState: async () => { saves++; }, scheduleRestart: () => { schedules++; }, isStopping: () => false, ...options });
  const { releaseId, pid, currentSha256, instanceSha256, manifestSha256 } = prepared.binding.old;
  const resume = { input, expectedRevision: prior.revision, expectedBindingSha256: old.sha256,
    expectedCurrent: { releaseId, pid, currentSha256, instanceSha256, manifestSha256 } };
  return { input, old, prior, store, service, resume, get counts() { return { preparations, saves, schedules }; },
    changePrepared: action => { action(prepared.binding); prepared = envelope(prepared.binding); } };
}

test("explicit package continuation preserves failed attempt and binding, fresh current, and same original across replay/reopen", async t => {
  const f = await fixture(t);
  assert.equal(f.store.transition(f.input.operationId, { status: "requested" }, { expectedRevision: f.prior.revision }).reason, "terminal");
  const result = await f.service.resumePackage(f.resume);
  assert.equal(result.accepted, true); assert.equal(result.attempt, 2); assert.equal(result.waiting, true);
  const next = f.store.getReadonly(f.input.operationId);
  assert.equal(next.operationId, f.prior.operationId); assert.equal(next.revision, f.prior.revision + 1);
  assert.deepEqual(next.metadata.packageAttemptHistory, [f.prior]);
  assert.equal(next.metadata.packageHandoff.binding.old.releaseId, "fresh");
  assert.equal(next.completedAt, null); assert.equal(next.outcome, null);
  assert.equal((await f.service.resumePackage(f.resume)).accepted, false);
  assert.deepEqual(f.counts, { preparations: 1, saves: 1, schedules: 0 });
  const reopened = new RestartRequestService({ operationStore: new MaintenanceOperationStore({ dataDir: f.store.dataDir }),
    currentTarget: () => ({}), preparePackage: () => assert.fail("duplicate must not prepare") });
  assert.equal((await reopened.resumePackage(f.resume)).accepted, false);
  assert.deepEqual(f.store.getReadonly(f.input.operationId), next);
});

for (const [label, mutate] of [
  ["UNKNOWN", row => { row.status = "reconciling"; row.outcome = "unknown"; }],
  ["untyped historical failure", row => { delete row.metadata.packagePreStopFailure; }],
  ["native admission", row => { row.metadata.packageNative = { hostPid: 1 }; }],
  ["foreign scope", row => { row.streamId = "foreign"; }],
]) test(`continuation refuses ${label} before preparation or mutation`, async t => {
  const f = await fixture(t, mutate);
  await assert.rejects(f.service.resumePackage(f.resume), /continuation authority/u);
  assert.deepEqual(f.counts, { preparations: 0, saves: 0, schedules: 0 });
  assert.deepEqual(f.store.getReadonly(f.input.operationId), f.prior);
});

test("continuation refuses changed revision, binding, input, current, roots and target", async t => {
  const f = await fixture(t);
  for (const changed of [
    { ...f.resume, expectedRevision: f.prior.revision + 1 },
    { ...f.resume, expectedBindingSha256: "f".repeat(64) },
    { ...f.resume, input: { ...f.input, tag: "2.1.4" } },
    { ...f.resume, expectedCurrent: { ...f.resume.expectedCurrent, pid: process.pid + 1 } },
    { ...f.resume, clientTraceId: "forbidden" },
  ]) await assert.rejects(f.service.resumePackage(changed));
  f.changePrepared(binding => { binding.target.version = "changed"; });
  await assert.rejects(f.service.resumePackage(f.resume), /public selection changed/u);
  f.changePrepared(binding => { binding.target.version = "2.1.3+build.123"; binding.roots.runtime.ino = "foreign"; });
  await assert.rejects(f.service.resumePackage(f.resume), /identity changed|roots changed/u);
  assert.deepEqual(f.store.getReadonly(f.input.operationId), f.prior);
  assert.equal(f.counts.saves, 0); assert.equal(f.counts.schedules, 0);
});

test("a foreign active restart prevents the same-original next attempt without changing either row", async t => {
  const f = await fixture(t);
  const foreign = f.store.create({ operationId: "other-original", kind: "restart", streamId: "agent-hub-runtime",
    threadId: "agent-hub-runtime", status: "blocked", phase: "waiting-for-work", metadata: {} });
  await assert.rejects(f.service.resumePackage(f.resume), /Another original restart/u);
  assert.deepEqual(f.store.getReadonly(f.input.operationId), f.prior);
  assert.deepEqual(f.store.getReadonly(foreign.operationId), foreign);
  assert.equal(f.counts.saves, 0); assert.equal(f.counts.schedules, 0);
});

test("failed pre-stop receipt cannot start a new attempt until its owning controller invocation drains", async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let f;
  f = await fixture(t, () => {}, { blockingWorkCount: () => 0, performRestart: async () => {
    await f.service.fail(f.input.operationId, Error("new controlled pre-stop failure"), {
      packagePreStopFailure: { schema: 1, phase: "package-backup-preflight", bindingSha256: f.store.getReadonly(f.input.operationId).metadata.packageHandoff.sha256, attempt: 2 } });
    entered.resolve(); await finish.promise; return { status: "aborted", restartStateSettled: true };
  } });
  await f.service.resumePackage(f.resume);
  const active = f.service.performScheduled(f.input.operationId); await entered.promise;
  const failed = f.store.getReadonly(f.input.operationId);
  const next = { ...f.resume, expectedRevision: failed.revision, expectedBindingSha256: failed.metadata.packageHandoff.sha256 };
  await assert.rejects(f.service.resumePackage(next), /has not drained/u);
  assert.deepEqual(f.store.getReadonly(f.input.operationId), failed);
  finish.resolve(); await active;
  assert.equal((await f.service.resumePackage(next)).attempt, 3);
});
