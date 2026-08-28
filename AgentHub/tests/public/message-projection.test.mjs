import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function projectionApi() {
  const source = await readFile(
    new URL("../../assets/web-app/messages/projection.js", import.meta.url),
    "utf8",
  );
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  return context.globalThis.AgentHubMessageProjection;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("canonical submission atomically replaces optimistic aliases in either order", async () => {
  const projection = await projectionApi();
  const optimistic = {
    role: "user",
    clientUserMessageId: "client-1",
    submissionId: "submission-1",
    text: "draft",
    projectionAuthority: "optimistic",
    projectionState: "optimistic",
    operationKind: "user-turn",
  };
  const canonical = {
    role: "user",
    submissionId: "submission-1",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: "canonical",
    projectionAuthority: "canonical",
    projectionState: "queued",
    operationKind: "user-turn",
  };

  for (const values of [[optimistic, canonical], [canonical, optimistic]]) {
    assert.deepEqual(plain(projection.projectCanonicalMessages(values)), [{
      ...optimistic,
      ...canonical,
    }]);
  }
  assert.deepEqual(plain(projection.projectCanonicalMessages([canonical, canonical])), [canonical]);
});

test("attachment steer replaces its optimistic card only by exact submission identity", async () => {
  const projection = await projectionApi();
  const optimistic = {
    role: "user",
    clientUserMessageId: "client-attachment-steer",
    submissionId: "client-attachment-steer",
    text: "11 сек..",
    attachments: [{ id: "local-image", name: "image.png" }],
    operationKind: "user-turn",
    projectionAuthority: "optimistic",
    projectionState: "optimistic",
  };
  const canonical = {
    role: "user",
    clientUserMessageId: "client-attachment-steer",
    provider: "codex",
    threadId: "thread-production",
    turnId: "turn-production",
    itemId: "provider-user-item",
    text: "11 сек..",
    attachments: [{ id: "durable-image", name: "image.png" }],
    operationKind: "user-turn",
    projectionAuthority: "canonical",
    projectionState: "active",
  };
  const legacyWithoutIdentity = {
    ...canonical,
    clientUserMessageId: "",
    itemId: "legacy-provider-user-item",
    attachments: [],
  };

  assert.deepEqual(plain(projection.projectCanonicalMessages([optimistic, canonical])), [{
    ...optimistic,
    ...canonical,
  }]);
  assert.equal(
    projection.projectCanonicalMessages([optimistic, legacyWithoutIdentity]).length,
    2,
  );
});

test("Codex production history, live and outgoing aliases project one root and one steer", async () => {
  const projection = await projectionApi();
  const providerMessage = (itemId) => ({
    role: "user",
    provider: "codex",
    threadId: "thread-production",
    turnId: "turn-production",
    itemId,
    text: "Одинаковый текст и время не являются identity",
    time: "2026-08-27T20:10:05.580Z",
    operationKind: "user-turn",
    projectionAuthority: "canonical",
    projectionState: "active",
  });
  const liveMessage = (itemId, clientUserMessageId) => ({
    ...providerMessage(itemId),
    clientUserMessageId,
    projectionAuthority: "live",
  });
  const outgoingMessage = (clientUserMessageId) => ({
    role: "user",
    provider: "codex",
    threadId: "thread-production",
    turnId: "turn-production",
    itemId: clientUserMessageId,
    clientUserMessageId,
    submissionId: clientUserMessageId,
    text: "Одинаковый текст и время не являются identity",
    time: "2026-08-27T20:10:05.580Z",
    operationKind: "user-turn",
    projectionAuthority: "optimistic",
    projectionState: "optimistic",
  });
  const providerRoot = providerMessage("provider-root-item");
  const providerSteer = providerMessage("provider-steer-item");
  const liveRoot = liveMessage("provider-root-item", "client-root");
  const liveSteer = liveMessage("provider-steer-item", "client-steer");
  const outgoingRoot = outgoingMessage("client-root");
  const outgoingSteer = outgoingMessage("client-steer");

  for (const values of [
    [providerRoot, providerSteer, outgoingRoot, outgoingSteer, liveRoot, liveSteer],
    [outgoingRoot, outgoingSteer, liveRoot, liveSteer, providerRoot, providerSteer],
  ]) {
    const projected = plain(projection.projectCanonicalMessages(values));
    assert.equal(projected.length, 2);
    assert.deepEqual(
      projected.map((message) => message.clientUserMessageId).sort(),
      ["client-root", "client-steer"],
    );
  }
});

test("terminal revision absorbs reordered and duplicated active progress", async () => {
  const projection = await projectionApi();
  const active = {
    role: "agent",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "progress-1",
    text: "late progress",
    operationKind: "user-turn",
    projectionAuthority: "live",
    projectionState: "active",
  };
  const terminal = {
    ...active,
    itemId: "final-1",
    text: "final",
    projectionAuthority: "terminal",
    projectionState: "completed",
    terminalRevision: 2,
  };

  for (const values of [[active, terminal], [terminal, active], [terminal, active, terminal]]) {
    assert.deepEqual(plain(projection.projectCanonicalMessages(values)), [terminal]);
  }
});

test("positive terminal revision absorbs legacy zero but zero upgrades to positive", async () => {
  const projection = await projectionApi();
  const legacy = {
    role: "agent",
    provider: "codex",
    threadId: "thread-legacy",
    turnId: "turn-legacy",
    text: "legacy final",
    operationKind: "user-turn",
    projectionAuthority: "terminal",
    projectionState: "completed",
    terminalRevision: 0,
  };
  const canonical = {
    ...legacy,
    text: "canonical final",
    terminalRevision: 2,
  };
  assert.deepEqual(plain(projection.projectCanonicalMessages([canonical, legacy])), [canonical]);
  assert.deepEqual(plain(projection.projectCanonicalMessages([legacy, canonical])), [canonical]);
});

test("canonical final replaces a stale partial overlay at the same revision", async () => {
  const projection = await projectionApi();
  const canonical = {
    role: "agent",
    provider: "codex",
    threadId: "thread-final",
    turnId: "turn-final",
    itemId: "canonical-final",
    text: "Выбери:\n\n1. Первый вариант.\n2. Второй вариант.",
    operationKind: "user-turn",
    projectionAuthority: "canonical",
    projectionState: "completed",
    terminalRevision: 1,
  };
  const staleOverlay = {
    ...canonical,
    itemId: "turn-final:agent:final",
    text: "Выбери:\n\n1. Первый вариант.",
    projectionAuthority: "terminal",
  };

  for (const values of [[canonical, staleOverlay], [staleOverlay, canonical]]) {
    assert.deepEqual(plain(projection.projectCanonicalMessages(values)), [canonical]);
  }
});

test("newer terminal overlay still replaces older canonical history", async () => {
  const projection = await projectionApi();
  const canonical = {
    role: "agent",
    provider: "codex",
    threadId: "thread-final",
    turnId: "turn-final",
    itemId: "canonical-final",
    text: "Старый финал",
    operationKind: "user-turn",
    projectionAuthority: "canonical",
    projectionState: "completed",
    terminalRevision: 1,
  };
  const newerOverlay = {
    ...canonical,
    itemId: "turn-final:agent:final",
    text: "Новый финал",
    projectionAuthority: "terminal",
    terminalRevision: 2,
  };

  for (const values of [[canonical, newerOverlay], [newerOverlay, canonical]]) {
    assert.deepEqual(plain(projection.projectCanonicalMessages(values)), [newerOverlay]);
  }
});

test("restart replay keeps one canonical entity and never revives its terminal", async () => {
  const projection = await projectionApi();
  const persisted = {
    role: "agent",
    provider: "claude",
    threadId: "thread-2",
    turnId: "turn-9",
    text: "persisted final",
    operationKind: "user-turn",
    projectionAuthority: "terminal",
    projectionState: "completed",
    terminalRevision: 4,
  };
  const replay = {
    ...persisted,
    text: "reconnected progress",
    projectionAuthority: "live",
    projectionState: "active",
    terminalRevision: 0,
  };
  assert.deepEqual(plain(projection.projectCanonicalMessages([persisted, replay, replay])), [persisted]);
});

test("internal and unknown operations never project as a user running turn", async () => {
  const projection = await projectionApi();
  for (const operationKind of ["probe", "compaction", "measurement", "maintenance"]) {
    assert.equal(projection.isUserRunningProjection({ operationKind, projectionState: "active" }), false);
  }
  assert.equal(projection.isUserRunningProjection({ projectionState: "active" }), false);
  assert.equal(projection.isUserRunningProjection({
    operationKind: "user-turn",
    projectionState: "unknown",
  }), false);
  assert.equal(projection.isUserRunningProjection({
    operationKind: "user-turn",
    projectionState: "active",
  }), true);
});
