import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { StreamMessagePinStore } from "../../../src/infrastructure/persistence/stream-message-pin-store.mjs";

function pinValue(streamId, ordinal) {
  return {
    streamId,
    messageKey: `message:v1:${ordinal}`,
    sourceAlias: `source-${ordinal}`,
    provider: "codex",
    taskThreadId: "thread-1",
    turnThreadId: "thread-1",
    turnId: `turn-${ordinal}`,
    itemId: `item-${ordinal}`,
    role: ordinal % 2 ? "user" : "agent",
    semanticSlot: ordinal % 2 ? "user-command" : "final",
    preview: `Сообщение ${ordinal}`,
    author: "Codex",
    time: "2026-09-06T10:00:00.000Z",
  };
}

test("message pins persist, deduplicate, order newest first, cap at 50, and cascade with Stream deletion", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-pins-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let nowMs = 1_000;
  const catalog = new WorkspaceCatalogStore({ databaseFile, now: () => nowMs });
  await catalog.load();
  const workspace = catalog.createWorkspace({ name: "Pins" });
  const stream = catalog.createStream({ workspaceId: workspace.id, name: "Dialog" });
  catalog.bindThread({ provider: "codex", threadId: "thread-1", streamId: stream.id });
  let pins = new StreamMessagePinStore({ databaseFile, now: () => ++nowMs });
  t.after(async () => {
    pins?.close();
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = pins.pin(pinValue(stream.id, 1));
  assert.equal(first.changed, true);
  assert.equal(pins.pin(pinValue(stream.id, 1)).changed, false);
  pins.pin(pinValue(stream.id, 2));
  assert.deepEqual(pins.list(stream.id).map((pin) => pin.messageKey), ["message:v1:2", "message:v1:1"]);

  pins.close();
  pins = new StreamMessagePinStore({ databaseFile, now: () => ++nowMs });
  assert.equal(pins.list(stream.id).length, 2);
  for (let ordinal = 3; ordinal <= 50; ordinal += 1) pins.pin(pinValue(stream.id, ordinal));
  assert.throws(() => pins.pin(pinValue(stream.id, 51)), /не больше 50/u);

  catalog.archiveWorkspace(workspace.id);
  assert.equal(pins.list(stream.id).length, 50);
  catalog.deleteArchivedWorkspace(workspace.id, workspace.name);
  assert.deepEqual(pins.list(stream.id), []);
});
