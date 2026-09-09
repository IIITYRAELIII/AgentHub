import assert from "node:assert/strict";
import test from "node:test";

import { StreamMessagePinService } from "../../src/application/stream-message-pin-service.mjs";

function fixture() {
  const pins = [];
  const store = {
    list: () => pins.slice(),
    pin: (pin) => {
      const saved = { id: `pin-${pins.length + 1}`, available: true, ...pin };
      pins.unshift(saved);
      return { pin: saved, changed: true };
    },
    unpin: ({ pinId }) => {
      const index = pins.findIndex((pin) => pin.id === pinId);
      if (index < 0) return { pin: null, changed: false };
      return { pin: pins.splice(index, 1)[0], changed: true };
    },
    clear: (streamId) => {
      const removed = pins.filter((pin) => pin.streamId === streamId);
      pins.splice(0, pins.length, ...pins.filter((pin) => pin.streamId !== streamId));
      return { pins: removed, changed: removed.length > 0 };
    },
    setAvailability: (pinId, available) => {
      const pin = pins.find((candidate) => candidate.id === pinId);
      if (pin) pin.available = available;
    },
  };
  const candidate = {
    provider: "codex",
    threadId: "thread-old",
    turnThreadId: "thread-old",
    turnId: "turn-1",
    itemId: "item-1",
    role: "agent",
    messageKey: "message:v1:final",
    sourceAlias: "alias",
    semanticSlot: "final",
    pinEligible: true,
    text: "Финальный ответ",
    author: "Codex",
  };
  const workspaceCatalog = {
    stream: (id) => (id === "stream-1" ? { id } : null),
    threadsForStream: () => [{ provider: "codex", threadId: "thread-old" }],
  };
  return {
    pins,
    service: new StreamMessagePinService({
      store,
      workspaceCatalog,
      resolveMessage: (identity) => identity.itemId === "missing" ? null : candidate,
    }),
    candidate,
  };
}

test("pin service accepts historical Thread aliases in one Stream and rejects cross-Stream sources", async () => {
  const { service, candidate } = fixture();
  const result = await service.set({
    pinned: true,
    streamId: "stream-1",
    taskThreadId: "thread-old",
    ...candidate,
  });
  assert.equal(result.messagePins.length, 1);
  await assert.rejects(service.set({
    pinned: true,
    streamId: "stream-1",
    taskThreadId: "thread-foreign",
    ...candidate,
    threadId: "thread-foreign",
  }), /не относится/u);
});

test("missing source remains listed and removable, and one unpin can be undone", async () => {
  const { service, pins, candidate } = fixture();
  await service.set({ pinned: true, streamId: "stream-1", taskThreadId: "thread-old", ...candidate });
  pins[0].itemId = "missing";
  assert.equal(service.snapshot()[0].available, false);
  assert.equal(pins[0].available, true, "snapshot availability is derived without mutating storage");
  const removed = await service.set({ pinned: false, streamId: "stream-1", pinId: pins[0].id });
  assert.equal(removed.messagePins.length, 0);
  assert.ok(removed.undoToken);
  const restored = await service.set({ pinned: true, streamId: "stream-1", undoToken: removed.undoToken });
  assert.equal(restored.messagePins.length, 1);
});

test("failed undo persistence preserves its token for the same user retry", async () => {
  const { service, candidate } = fixture();
  const pinned = await service.set({ pinned: true, streamId: "stream-1", taskThreadId: "thread-old", ...candidate });
  const removed = await service.set({ pinned: false, streamId: "stream-1", pinId: pinned.pin.id });
  const pin = service.store.pin;
  service.store.pin = async () => { throw new Error("database is locked"); };
  const request = { pinned: true, streamId: "stream-1", undoToken: removed.undoToken };
  await assert.rejects(service.set(request), /database is locked/u);
  service.store.pin = async (value) => pin(value);
  assert.equal((await service.set(request)).changed, true);
});
