import assert from "node:assert/strict";
import test from "node:test";

import { currentStreamEntries } from "../../src/composition/provider-catalog-composition.mjs";

test("catalog exposes one current provider Thread per Stream", () => {
  const entries = currentStreamEntries([
    { streamId: "stream-1", threadId: "old", threadPosition: 1, running: false },
    { streamId: "stream-1", threadId: "new", threadPosition: 2, running: false },
    { streamId: "stream-2", threadId: "other", threadPosition: 1, running: false },
  ]);
  assert.deepEqual(entries.map((entry) => entry.threadId), ["new", "other"]);
});

test("an active older Thread remains visible until its terminal event", () => {
  const [entry] = currentStreamEntries([
    { streamId: "stream-1", threadId: "old", threadPosition: 1, running: true },
    { streamId: "stream-1", threadId: "new", threadPosition: 2, running: false },
  ]);
  assert.equal(entry.threadId, "old");
});
