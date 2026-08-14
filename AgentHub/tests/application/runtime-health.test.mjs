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
