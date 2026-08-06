import assert from "node:assert/strict";
import test from "node:test";
import { contextualCallback, resolveContextualCallback } from "../../../src/interfaces/telegram/callback-context.mjs";

const current = "0123456789ab";

test("mutating UI callbacks require the current context", () => {
  const callback = contextualCallback("thread:archive", current);
  assert.equal(callback, "thread:archive:u:0123456789ab");
  assert.deepEqual(resolveContextualCallback(callback, current), {
    action: "thread:archive",
    contextual: true,
    stale: false,
  });
  assert.equal(resolveContextualCallback(callback, "abcdefabcdef").stale, true);
  assert.equal(resolveContextualCallback("thread:archive", current).stale, true);
});

test("durable callbacks do not require ephemeral UI context", () => {
  assert.deepEqual(resolveContextualCallback("task:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf013", current), {
    action: "task:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    contextual: false,
    stale: false,
  });
  assert.equal(resolveContextualCallback("show-message", current).stale, false);
});

test("oversized contextual callbacks are rejected before Telegram delivery", () => {
  assert.throws(() => contextualCallback(`codex-model:${"x".repeat(60)}`, current), /exceeds 64 bytes/);
});
