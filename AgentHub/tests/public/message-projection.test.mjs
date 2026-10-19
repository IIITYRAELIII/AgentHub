import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { mergeCanonicalUserMessages } from "../../src/domain/canonical-user-messages.mjs";

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

test("terminal client messages without provider item IDs remain distinct including interstream input", async () => {
  const projection = await projectionApi();
  const users = Array.from({ length: 6 }, (_, index) => ({
    role: "user", provider: "codex", threadId: "thread", turnId: "turn", itemId: "",
    clientUserMessageId: `client-${index}`, text: `Message ${index}`,
    projectionAuthority: "canonical", projectionState: "completed",
    ...(index === 4 ? { kind: "interstream", author: "Themes" } : {}),
  }));
  for (const order of [users, [...users].reverse()]) {
    const result = plain(projection.projectCanonicalMessages([...order, ...order]));
    assert.deepEqual(result, order);
    assert.equal(result.find((message) => message.clientUserMessageId === "client-5").kind, undefined);
    assert.equal(result.find((message) => message.clientUserMessageId === "client-4").author, "Themes");
  }
});

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

test("queued active and completed projections keep one card and immutable submittedAt", async () => {
  const projection = await projectionApi();
  const optimistic = {
    role: "user",
    clientUserMessageId: "client-lifecycle",
    submissionId: "client-lifecycle",
    operationKind: "user-turn",
    projectionAuthority: "optimistic",
    projectionState: "optimistic",
    submittedAt: "2026-09-01T21:24:59.000Z",
    time: "2026-09-01T21:24:59.000Z",
  };
  const queued = {
    ...optimistic,
    projectionAuthority: "canonical",
    projectionState: "queued",
    deliveryState: "queued",
    submittedAt: "2026-09-01T21:25:00.000Z",
    time: "2026-09-01T21:25:00.000Z",
  };
  const active = {
    ...queued,
    projectionAuthority: "live",
    projectionState: "active",
    deliveryState: "accepted",
    turnId: "turn-lifecycle",
    startedAt: "2026-09-01T21:28:00.000Z",
    time: "2026-09-01T21:28:00.000Z",
  };
  const completed = {
    ...active,
    projectionAuthority: "canonical",
    projectionState: "completed",
    terminalRevision: 1,
    time: "2026-09-01T21:29:00.000Z",
  };

  const queuedProjection = plain(projection.projectCanonicalMessages([optimistic, queued]));
  assert.equal(queuedProjection.length, 1);
  assert.equal(queuedProjection[0].projectionState, "queued");
  assert.equal(queuedProjection[0].submittedAt, queued.submittedAt);
  assert.equal(queuedProjection[0].time, queued.submittedAt);

  const activeProjection = plain(projection.projectCanonicalMessages([optimistic, queued, active, queued]));
  assert.equal(activeProjection.length, 1);
  assert.equal(activeProjection[0].projectionState, "active");
  assert.equal(activeProjection[0].submittedAt, queued.submittedAt);
  assert.equal(activeProjection[0].startedAt, active.startedAt);
  assert.equal(activeProjection[0].time, queued.submittedAt);

  const completedProjection = plain(projection.projectCanonicalMessages([optimistic, queued, active, completed]));
  assert.equal(completedProjection.length, 1);
  assert.equal(completedProjection[0].projectionState, "completed");
  assert.equal(completedProjection[0].submittedAt, queued.submittedAt);
  assert.equal(completedProjection[0].time, queued.submittedAt);
});

test("a bridge rebinds provider aliases before a later canonical refresh", async () => {
  const projection = await projectionApi();
  const history = {
    role: "user",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "provider-user-item",
    text: "релиз сразу",
    projectionAuthority: "canonical",
    projectionState: "active",
    operationKind: "user-turn",
  };
  const optimistic = {
    role: "user",
    clientUserMessageId: "client-release",
    submissionId: "client-release",
    text: "релиз сразу",
    projectionAuthority: "optimistic",
    projectionState: "optimistic",
    operationKind: "user-turn",
  };
  const bridge = {
    ...history,
    clientUserMessageId: "client-release",
    projectionAuthority: "live",
  };
  const refreshed = {
    ...history,
    text: "релиз",
  };

  assert.deepEqual(
    plain(projection.projectCanonicalMessages([history, optimistic, bridge, refreshed])),
    [{ ...optimistic, ...bridge, ...refreshed }],
  );
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

test("a truncated unkeyed refresh cannot leave optimistic duplicates after navigation", async () => {
  const projection = await projectionApi();
  const canonical = ["root", "steer"].map((suffix) => ({
    role: "user",
    provider: "codex",
    threadId: "thread-production",
    turnId: "turn-production",
    itemId: `owned-${suffix}`,
    clientUserMessageId: `client-${suffix}`,
    text: "Одинаковый текст",
    operationKind: "user-turn",
    projectionAuthority: "canonical",
    projectionState: "completed",
  }));
  const refreshed = mergeCanonicalUserMessages(canonical, [{
    role: "user",
    itemId: "rollout-tail",
    text: "Одинаковый текст",
  }]);
  const outgoing = canonical.map((message) => ({
    ...message,
    itemId: message.clientUserMessageId,
    submissionId: message.clientUserMessageId,
    projectionAuthority: "optimistic",
    projectionState: "optimistic",
  }));

  for (const values of [[...outgoing, ...refreshed], [...refreshed, ...outgoing]]) {
    const projected = plain(projection.projectCanonicalMessages(values));
    assert.equal(projected.length, 2);
    assert.deepEqual(projected.map((message) => message.clientUserMessageId), [
      "client-root",
      "client-steer",
    ]);
  }
});

test("canonical projection strips an interstream wrapper only with matching origin and command identity", async () => {
  const projection = await projectionApi();
  const origin = {
    kind: "interstream", workspaceId: "hub", workspaceName: "Agent HUB",
    streamId: "themes", streamName: "Themes", provider: "codex", model: "GPT-5.6-Terra",
    sourceThreadId: "themes-thread", requestId: "hub176-design-review",
  };
  const rawText = `<agent-hub-stream-message>\n${JSON.stringify(origin)}\n</agent-hub-stream-message>\nПроверь дизайн`;
  const message = {
    role: "user", kind: "interstream", origin, text: rawText,
    provider: "codex", threadId: "releaseManager-thread", turnId: "turn-review", itemId: "review-item",
    clientUserMessageId: "mcp:hub176-design-review", projectionAuthority: "canonical",
    author: "Agent HUB - Themes (Terra)", projectionState: "completed",
  };
  const [trusted] = plain(projection.projectCanonicalMessages([message]));
  assert.equal(trusted.text, "Проверь дизайн");
  assert.equal(trusted.author, message.author);
  assert.deepEqual(trusted.origin, origin);
  for (const value of [
    { ...message, origin: undefined },
    { ...message, origin: { ...origin, sourceThreadId: "foreign" } },
    { ...message, clientUserMessageId: "literal-client" },
    { ...message, text: rawText.replace('"kind"', 'broken"kind"') },
  ]) {
    assert.equal(projection.projectCanonicalMessages([value])[0].text, value.text);
  }
  const live = { ...message, projectionAuthority: "live", projectionState: "active" };
  for (const values of [[live, trusted], [trusted, live]]) {
    assert.equal(projection.projectCanonicalMessages(values)[0].text, "Проверь дизайн");
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

test("unconfirmed recovery keeps Stop available without presenting execution as running", async () => {
  const api = await projectionApi();
  const run = { operationKind: "user-turn", status: "running", projectionState: "active", activityUnknown: true };
  assert.deepEqual(plain(api.userRunActivity(run)), { running: false, canStop: true, unknown: true });
  assert.deepEqual(plain(api.userRunActivity({ ...run, projectionState: "unknown" })), { running: false, canStop: true, unknown: true });
  assert.deepEqual(plain(api.userRunActivity({ ...run, activityUnknown: false })), { running: true, canStop: true, unknown: false });
  assert.deepEqual(plain(api.userRunActivity(null)), { running: false, canStop: false, unknown: false });
});
