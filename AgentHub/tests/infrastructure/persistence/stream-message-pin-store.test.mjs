import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

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
  await pins.initialize();
  t.after(async () => {
    await pins?.close();
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await pins.pin(pinValue(stream.id, 1));
  assert.equal(first.changed, true);
  assert.equal((await pins.pin(pinValue(stream.id, 1))).changed, false);
  await pins.pin(pinValue(stream.id, 2));
  assert.deepEqual(pins.list(stream.id).map((pin) => pin.messageKey), ["message:v1:2", "message:v1:1"]);

  await pins.close();
  pins = new StreamMessagePinStore({ databaseFile, now: () => ++nowMs });
  await pins.initialize();
  assert.equal(pins.list(stream.id).length, 2);
  for (let ordinal = 3; ordinal <= 50; ordinal += 1) await pins.pin(pinValue(stream.id, ordinal));
  await assert.rejects(pins.pin(pinValue(stream.id, 51)), /не больше 50/u);

  catalog.archiveWorkspace(workspace.id);
  assert.equal(pins.list(stream.id).length, 50);
  catalog.deleteArchivedWorkspace(workspace.id, workspace.name);
  assert.deepEqual(pins.list(stream.id), []);
});

test("pin writes yield under a real SQLite writer and retain deduplication and revision atomicity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-pin-contention-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const workspace = catalog.createWorkspace({ name: "Pins" });
  const stream = catalog.createStream({ workspaceId: workspace.id, name: "Dialog" });
  const pins = new StreamMessagePinStore({ databaseFile });
  await pins.initialize();
  const blocker = new DatabaseSync(databaseFile);
  t.after(async () => {
    blocker.close();
    await pins.close();
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  blocker.exec("BEGIN IMMEDIATE");
  let timerRan = false;
  const startedAt = performance.now();
  const first = pins.pin(pinValue(stream.id, 1));
  const duplicate = pins.pin(pinValue(stream.id, 1));
  setTimeout(() => { timerRan = true; blocker.exec("COMMIT"); }, 30);
  const results = await Promise.all([first, duplicate]);
  assert.equal(timerRan, true);
  assert.ok(performance.now() - startedAt < 1_000, "SQLite busy wait must not block the release timer for five seconds");
  assert.deepEqual(results.map((result) => result.changed), [true, false]);
  assert.equal(results[0].pin.id, results[1].pin.id);
  assert.equal(pins.revision, 1);

  blocker.exec("BEGIN IMMEDIATE");
  const availability = pins.setAvailability(results[0].pin.id, false);
  setTimeout(() => blocker.exec("COMMIT"), 30);
  assert.equal(await availability, true);
  assert.equal(pins.revision, 2);
  assert.equal(pins.get(results[0].pin.id).available, false);

  blocker.exec("BEGIN IMMEDIATE");
  const removal = pins.unpin({ pinId: results[0].pin.id });
  setTimeout(() => blocker.exec("COMMIT"), 30);
  assert.equal((await removal).changed, true);
  assert.equal(pins.revision, 3);
  assert.deepEqual(pins.list(), []);
});

test("pin contention exhaustion preserves durable state and the queue accepts a later retry", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-pin-exhaustion-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const workspace = catalog.createWorkspace({ name: "Pins" });
  const stream = catalog.createStream({ workspaceId: workspace.id, name: "Dialog" });
  const pins = new StreamMessagePinStore({ databaseFile, mutationTimeoutMs: 30 });
  await pins.initialize();
  const blocker = new DatabaseSync(databaseFile);
  t.after(async () => {
    blocker.close();
    await pins.close();
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  blocker.exec("BEGIN IMMEDIATE");
  await assert.rejects(pins.pin(pinValue(stream.id, 1)), /database is locked/u);
  assert.equal(pins.revision, 0);
  assert.deepEqual(pins.list(), []);
  blocker.exec("COMMIT");
  await pins.pin(pinValue(stream.id, 1));
  blocker.exec("BEGIN IMMEDIATE");
  const clear = pins.clear(stream.id);
  setTimeout(() => blocker.exec("COMMIT"), 10);
  assert.equal((await clear).pins.length, 1);
  assert.equal(pins.revision, 2);
});
