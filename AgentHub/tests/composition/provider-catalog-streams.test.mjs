import assert from "node:assert/strict";
import test from "node:test";

import {
  currentStreamEntries,
  currentWorkspaceThreadEntries,
} from "../../src/composition/provider-catalog-composition.mjs";

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

test("a rotated empty Thread remains visible as the current Stream entry", () => {
  const entries = currentWorkspaceThreadEntries({
    hierarchy: () => [{
      id: "workspace-1",
      name: "Agent HUB",
      kind: "user",
      streams: [{
        id: "stream-1",
        ordinal: 2,
        name: null,
        displayName: "Stream 2",
        threads: [
          { provider: "codex", threadId: "old-thread", position: 1, projectRoot: "D:\\Repo" },
          { provider: "codex", threadId: "new-thread", position: 2, projectRoot: "D:\\Repo" },
        ],
      }],
    }],
  });

  assert.deepEqual(entries, [{
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    workspaceKind: "user",
    streamId: "stream-1",
    streamName: null,
    streamDisplayName: "Stream 2",
    streamOrdinal: 2,
    threadPosition: 2,
    provider: "codex",
    threadId: "new-thread",
    projectRoot: "D:\\Repo",
    projectName: "Repo",
    title: "Agent HUB",
    model: null,
    updatedAtMs: 0,
    running: false,
  }]);
});
