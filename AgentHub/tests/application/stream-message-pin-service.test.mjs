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

test("pin service accepts historical Thread aliases in one Stream and rejects cross-Stream sources", () => {
  const { service, candidate } = fixture();
  const result = service.set({
    pinned: true,
    streamId: "stream-1",
    taskThreadId: "thread-old",
    ...candidate,
  });
  assert.equal(result.messagePins.length, 1);
  assert.throws(() => service.set({
    pinned: true,
    streamId: "stream-1",
    taskThreadId: "thread-foreign",
    ...candidate,
    threadId: "thread-foreign",
  }), /не относится/u);
});

test("missing source remains listed and removable, and one unpin can be undone", () => {
  const { service, pins, candidate } = fixture();
  service.set({ pinned: true, streamId: "stream-1", taskThreadId: "thread-old", ...candidate });
  pins[0].itemId = "missing";
  assert.equal(service.snapshot()[0].available, false);
  const removed = service.set({ pinned: false, streamId: "stream-1", pinId: pins[0].id });
  assert.equal(removed.messagePins.length, 0);
  assert.ok(removed.undoToken);
  const restored = service.set({ pinned: true, streamId: "stream-1", undoToken: removed.undoToken });
  assert.equal(restored.messagePins.length, 1);
});
