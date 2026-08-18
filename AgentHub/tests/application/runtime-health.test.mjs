import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeHealth } from "../../src/application/runtime-health.mjs";

test("runtime health distinguishes startup, ready and degraded states", () => {
  const health = createRuntimeHealth();
  assert.deepEqual(health.snapshot(), {
    live: true,
    ready: false,
    degraded: false,
    status: "starting",
    capabilities: [],
  });

  health.begin()
    .setCapability("provider", { critical: true, state: "ready" })
    .setCapability("telegram", { state: "failed", error: "offline" })
    .complete();
  assert.deepEqual(health.snapshot(), {
    live: true,
    ready: true,
    degraded: true,
    status: "degraded",
    capabilities: [
      { name: "provider", critical: true, state: "ready" },
      { name: "telegram", critical: false, state: "failed", error: "offline" },
    ],
  });
});

test("runtime health exposes one authoritative ordered startup progression", () => {
  let now = 1_000;
  const health = createRuntimeHealth({ now: () => now });
  health.begin({
    operations: [
      { id: "release", label: "Release", state: "completed" },
      { id: "provider", label: "Provider" },
      { id: "ready", label: "Ready" },
    ],
  });
  now = 2_000;
  health.startOperation("provider");
  assert.deepEqual(health.snapshot().startup, {
    startedAtMs: 1_000,
    operations: [
      { id: "release", label: "Release", state: "completed", startedAtMs: 1_000, completedAtMs: 1_000 },
      { id: "provider", label: "Provider", state: "running", startedAtMs: 2_000 },
      { id: "ready", label: "Ready", state: "pending" },
    ],
  });
  assert.throws(() => health.startOperation("ready"), /already running: provider/u);
  now = 3_000;
  health.completeOperation("provider").startOperation("ready");
  now = 4_000;
  health.failOperation("ready", new Error("local path")).complete();
  assert.deepEqual(health.snapshot().startup, {
    startedAtMs: 1_000,
    completedAtMs: 4_000,
    operations: [
      { id: "release", label: "Release", state: "completed", startedAtMs: 1_000, completedAtMs: 1_000 },
      { id: "provider", label: "Provider", state: "completed", startedAtMs: 2_000, completedAtMs: 3_000 },
      { id: "ready", label: "Ready", state: "failed", startedAtMs: 3_000, completedAtMs: 4_000, error: "local path" },
    ],
  });
});
