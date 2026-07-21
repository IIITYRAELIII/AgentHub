import assert from "node:assert/strict";
import test from "node:test";

import { routeTtsWorkerMessage } from "./tts-progress.mjs";

test("TTS progress refreshes the inactivity timer without completing the request", () => {
  let refreshed = 0;
  const pending = new Map([[7, {
    timer: { refresh: () => { refreshed += 1; } },
    resolve: () => assert.fail("progress must not resolve"),
    reject: () => assert.fail("progress must not reject"),
  }]]);

  assert.equal(routeTtsWorkerMessage(pending, { id: 7, progress: true, completed: 2, total: 5 }), true);
  assert.equal(refreshed, 1);
  assert.equal(pending.has(7), true);
});

test("TTS completion removes and resolves the pending request", () => {
  let output;
  const timer = setTimeout(() => {}, 10_000);
  const pending = new Map([[8, {
    timer,
    resolve: (value) => { output = value; },
    reject: () => assert.fail("successful completion must not reject"),
  }]]);

  assert.equal(routeTtsWorkerMessage(pending, { id: 8, ok: true, outputPath: "voice.ogg" }), true);
  assert.equal(output, "voice.ogg");
  assert.equal(pending.has(8), false);
});

test("TTS errors remove and reject the pending request", () => {
  let failure;
  const timer = setTimeout(() => {}, 10_000);
  const pending = new Map([[9, {
    timer,
    resolve: () => assert.fail("failed completion must not resolve"),
    reject: (error) => { failure = error; },
  }]]);

  assert.equal(routeTtsWorkerMessage(pending, { id: 9, ok: false, error: "boom" }), true);
  assert.equal(failure?.message, "boom");
  assert.equal(pending.has(9), false);
});
