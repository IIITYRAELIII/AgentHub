import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedStreamName,
  providerThreadKey,
  streamDisplayName,
} from "../../src/domain/workspace-stream-identity.mjs";

test("a single unnamed Stream has no visible ordinal", () => {
  assert.equal(streamDisplayName({ name: null, ordinal: 1, streamCount: 1 }), "");
  assert.equal(streamDisplayName({ name: null, ordinal: 1, streamCount: 2 }), "Stream 1");
  assert.equal(streamDisplayName({ name: "Themes", ordinal: 3, streamCount: 3 }), "Themes");
});

test("thread identity is provider-scoped", () => {
  assert.equal(providerThreadKey({ provider: "CODEX", threadId: "abc" }), "codex\0abc");
  assert.throws(() => providerThreadKey({ provider: "unknown", threadId: "abc" }), /provider/u);
  assert.equal(normalizedStreamName("  "), null);
});

