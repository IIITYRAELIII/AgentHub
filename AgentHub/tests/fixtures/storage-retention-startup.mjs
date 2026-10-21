// Run the actual production composition in a private child; observers delegate
// to the real owners. No source rewriting, Test Contour or dependency substitutes.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { StorageRetentionService } from "../../src/application/storage-retention-service.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { RuntimeTimerCoordinator } from "../../src/runtime/runtime-timer-coordinator.mjs";
import { agentHubRuntimeHealth } from "../../src/application/runtime-health.mjs";

const events = [], owners = [], schedules = [];
let service;
for (const Factory of [TaskGitWorkspaceService, ReleaseGitWorkspaceService]) {
  const original = Factory.prototype.storageRetentionOwner;
  Factory.prototype.storageRetentionOwner = function (options) {
    if (Factory === TaskGitWorkspaceService) {
      assert.ok(options.taskBoard, "real Task board must reach the native merge owner");
    } else {
      assert.equal(options.readGeneration("missing-fixture-operation", 1), null,
        "real ReleaseOperationService must resolve the retention proof");
    }
    const owner = original.call(this, options);
    const list = owner.list.bind(owner);
    owner.list = async (...args) => {
      events.push(`list:${owner.id}`);
      return list(...args);
    };
    owners.push(owner.id);
    return owner;
  };
}
const initial = StorageRetentionService.prototype.scheduleInitial;
StorageRetentionService.prototype.scheduleInitial = function (...args) {
  service = this;
  events.push("initial");
  return initial.apply(this, args);
};
const schedule = RuntimeTimerCoordinator.prototype.schedule;
RuntimeTimerCoordinator.prototype.schedule = function (name, callback, milliseconds, ...rest) {
  if (name === "storage-retention") schedules.push(milliseconds);
  return schedule.call(this, name, callback, milliseconds, ...rest);
};
const close = StorageRetentionService.prototype.close;
StorageRetentionService.prototype.close = async function (...args) {
  events.push("close-enter");
  await close.apply(this, args);
  events.push("close-return");
};

let server;
let releaseDiscovery = () => {};
try {
  server = await import("../../agent-hub-server.mjs");
  // Startup's promise represents the whole runtime lifetime (waitForever),
  // rather than readiness. Observe its rejection while waiting on real health.
  let startupFailure;
  void server.startAgentHub().catch(error => { startupFailure = error; });
  const readyDeadline = Date.now() + 10_000;
  while (!agentHubRuntimeHealth.snapshot().ready && Date.now() < readyDeadline) {
    if (startupFailure) throw startupFailure;
    await delay(10);
  }
  if (startupFailure) throw startupFailure;
  process.send({ stage: "ready" });
  assert.equal(agentHubRuntimeHealth.snapshot().ready, true);
  assert.ok(service, "production bootstrap must schedule the constructed retention service");
  assert.deepEqual(owners, ["native-merge-transport", "release-generation-transport"]);
  assert.deepEqual(service.owners.map(owner => owner.id),
    ["native-merge-transport", "runtime-release", "release-generation-transport"]);
  assert.deepEqual(schedules, [5000]);
  assert.equal(service.store.get("storage-retention:v1"), null,
    "construction/readiness must not scan storage before the deferred timer");
  const deadline = Date.now() + 15_000;
  while (service.status().state !== "idle" && Date.now() < deadline) await delay(25);
  assert.equal(service.status().state, "idle");
  assert.equal(service.status().more, false);
  assert.equal(service.status().pending, 0);
  assert.deepEqual(service.store.get("storage-retention:v1").metadata.ownerIds,
    ["native-merge-transport", "runtime-release", "release-generation-transport"]);
  assert.ok(events.includes("list:native-merge-transport"));
  assert.ok(events.includes("list:release-generation-transport"));
  assert.equal(schedules.at(-1), 6 * 60 * 60_000);
  assert.equal(agentHubRuntimeHealth.snapshot().diagnostics.storageRetention.state, "idle");
  process.send({ stage: "first-cycle", events, schedules });

  // Hold an empty, real discovery reply to make shutdown's drain observable.
  let entered, release;
  const inDiscovery = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  releaseDiscovery = release;
  const owner = service.owners[0], list = owner.list.bind(owner);
  owner.list = async (...args) => {
    const result = await list(...args);
    entered();
    await held;
    events.push("discovery-return");
    return result;
  };
  service.now = () => new Date(Date.now() + 7 * 60 * 60_000);
  const flight = service.runOnce();
  await Promise.race([inDiscovery, delay(3000).then(() => {
    throw new Error(`second-cycle discovery unavailable: ${JSON.stringify(service.status())}`);
  })]);
  process.send({ stage: "drain-probe" });
  const shuttingDown = server.shutdownAgentHub("isolated-retention-test");
  const drainDeadline = Date.now() + 3000;
  while (!events.includes("close-enter") && Date.now() < drainDeadline) await delay(10);
  assert.ok(events.includes("close-enter"));
  assert.equal(events.includes("close-return"), false, "shutdown must await the actual in-flight owner");
  assert.equal(service.timers.has("storage-retention"), false);
  release();
  await flight;
  await shuttingDown;
  assert.ok(events.indexOf("discovery-return") < events.indexOf("close-return"));
  assert.equal(service.timers.has("storage-retention"), false);
  const scheduleCount = schedules.length;
  await delay(50);
  assert.equal(schedules.length, scheduleCount, "stopped cleanup must not reschedule");
  process.send({ ok: true, events, owners, schedules }, () => process.exit(0));
} catch (error) {
  process.send?.({ ok: false, error: error.stack });
  releaseDiscovery();
  await Promise.race([server?.shutdownAgentHub("isolated-retention-failure").catch(() => {}), delay(3000)]);
  // A failed factory may have opened services before returning a shutdown owner.
  // This exits only this disposable child, never the installed Hub.
  process.exit(1);
}
