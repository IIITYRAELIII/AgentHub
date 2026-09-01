import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedPollingBackoff,
  retryAfterMilliseconds,
} from "../../../src/interfaces/web/remote-polling-policy.mjs";

test("remote polling backoff grows exponentially, stays bounded, and resets after success", () => {
  const backoff = new BoundedPollingBackoff({
    baseMs: 1_000,
    maxMs: 8_000,
    jitterRatio: 0,
  });

  assert.deepEqual(backoff.failure(), { attempt: 1, delayMs: 1_000 });
  assert.deepEqual(backoff.failure(), { attempt: 2, delayMs: 2_000 });
  assert.deepEqual(backoff.failure(), { attempt: 3, delayMs: 4_000 });
  assert.deepEqual(backoff.failure(), { attempt: 4, delayMs: 8_000 });
  assert.deepEqual(backoff.failure(), { attempt: 5, delayMs: 8_000 });
  assert.equal(backoff.success(), 5);
  assert.deepEqual(backoff.failure(), { attempt: 1, delayMs: 1_000 });
});

test("remote polling backoff applies bounded jitter", () => {
  const low = new BoundedPollingBackoff({ baseMs: 1_000, maxMs: 10_000, random: () => 0 });
  const high = new BoundedPollingBackoff({ baseMs: 1_000, maxMs: 10_000, random: () => 1 });

  assert.equal(low.failure().delayMs, 1_000);
  assert.equal(high.failure().delayMs, 1_200);
});

test("remote polling backoff respects bounded Retry-After guidance", () => {
  const backoff = new BoundedPollingBackoff({
    baseMs: 1_000,
    maxMs: 60_000,
    jitterRatio: 0,
  });

  assert.equal(retryAfterMilliseconds("60"), 60_000);
  assert.equal(retryAfterMilliseconds("invalid"), 0);
  assert.deepEqual(backoff.failure({ minimumMs: 60_000 }), { attempt: 1, delayMs: 60_000 });
  assert.deepEqual(backoff.failure({ minimumMs: 120_000 }), { attempt: 2, delayMs: 60_000 });
});
