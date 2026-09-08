import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeUserMessages,
  hasCanonicalUserMessages,
  mergeCanonicalUserMessages,
  USER_MESSAGE_SNAPSHOT_AUTHORITY,
} from "../../src/domain/canonical-user-messages.mjs";

test("a partial unkeyed provider tail cannot replace accepted identities or erase its occurrence", () => {
  const current = [
    { role: "user", text: "Одинаковый текст", clientUserMessageId: "accepted-root" },
    { role: "user", text: "Одинаковый текст", clientUserMessageId: "accepted-steer" },
  ];

  const merged = mergeCanonicalUserMessages(current, [
    { role: "user", text: "Одинаковый текст", itemId: "turn-1:rollout-user:0" },
  ], { turnId: "turn-1" });

  assert.deepEqual(merged, [
    ...current,
    { role: "user", text: "Одинаковый текст", itemId: "turn-1:rollout-user:0" },
  ]);
  assert.equal(hasCanonicalUserMessages(merged), true);
});

test("provider observations can enrich only the same exact accepted identity", () => {
  const merged = mergeCanonicalUserMessages([
    {
      role: "user",
      text: "Первое",
      clientUserMessageId: "accepted-1",
      local: true,
      origin: { streamId: "owned" },
    },
  ], [
    {
      role: "user",
      text: "Подменённое",
      clientUserMessageId: "accepted-1",
      itemId: "provider-1",
      origin: { streamId: "provider" },
      responseAnnotations: [{ text: "source", annotation: "note" }],
    },
    { role: "user", text: "Второе", clientUserMessageId: "accepted-2", itemId: "provider-2" },
    { role: "user", text: "Эхо без identity", itemId: "provider-unkeyed" },
  ]);

  assert.deepEqual(merged.map((message) => message.clientUserMessageId ?? null), [
    "accepted-1",
    "accepted-2",
    null,
  ]);
  assert.equal(merged[0].itemId, "provider-1");
  assert.equal(merged[0].text, "Первое");
  assert.deepEqual(merged[0].origin, { streamId: "owned" });
  assert.deepEqual(merged[0].responseAnnotations, [{ text: "source", annotation: "note" }]);
  assert.equal(merged[0].local, true);
});

test("provider-owned external turns retain unkeyed user messages", () => {
  const observed = [
    { role: "user", text: "External one", itemId: "external-1" },
    { role: "user", text: "External two", itemId: "external-2" },
  ];

  assert.deepEqual(mergeCanonicalUserMessages([], observed), observed);
});

test("an external occurrence before an exact managed root remains distinct", () => {
  const merged = mergeCanonicalUserMessages([
    {
      itemId: "provider-root",
      role: "user",
      text: "Provider root",
      attachmentSources: [{ type: "path", value: "C:/root.png" }],
    },
  ], [
    {
      itemId: "canonical-root",
      clientUserMessageId: "accepted-root",
      role: "user",
      text: "Canonical root",
      attachments: [{ id: "uploaded-root" }],
    },
    {
      itemId: "canonical-steer",
      clientUserMessageId: "accepted-steer",
      role: "user",
      text: "Steer",
    },
  ]);

  assert.deepEqual(merged.map((message) => message.clientUserMessageId ?? null), [
    null,
    "accepted-root",
    "accepted-steer",
  ]);
  assert.equal(merged[0].itemId, "provider-root");
  assert.equal(merged[0].text, "Provider root");
  assert.deepEqual(merged[0].attachmentSources, [{ type: "path", value: "C:/root.png" }]);
  assert.deepEqual(merged[1].attachments, [{ id: "uploaded-root" }]);
});

test("an exact steer cannot adopt an unidentified root without root authority", () => {
  const root = { itemId: "provider-root", role: "user", text: "Root" };
  const steer = {
    itemId: "canonical-steer",
    clientUserMessageId: "accepted-steer",
    role: "user",
    text: "Steer",
  };

  assert.deepEqual(mergeCanonicalUserMessages([root], [steer]), [root, steer]);
});

test("an unkeyed observation before a managed root is never adopted by position", () => {
  const merged = mergeCanonicalUserMessages([], [
    { itemId: "rollout-root", role: "user", text: "Provider alias" },
    {
      itemId: "canonical-root",
      clientUserMessageId: "accepted-root",
      role: "user",
      text: "Canonical root",
    },
  ]);

  assert.deepEqual(merged.map((message) => message.itemId), [
    "rollout-root",
    "canonical-root",
  ]);
});

test("mixed managed and provider-owned messages retain every unproven occurrence", () => {
  const current = [
    { role: "user", text: "Одинаково", clientUserMessageId: "managed-1" },
    { role: "user", text: "Одинаково", itemId: "external-1", origin: { kind: "desktop-import" } },
    { role: "user", text: "Одинаково", itemId: "external-2", origin: { kind: "desktop-import" } },
    { role: "user", text: "Legacy external without identity" },
  ];
  const merged = mergeCanonicalUserMessages(current, [
    { role: "user", text: "Подмена", clientUserMessageId: "managed-1", origin: { kind: "provider" } },
    { role: "user", text: "Обновлённое external", itemId: "external-2" },
    { role: "user", text: "Непроверяемый tail", itemId: "turn:rollout-user:9" },
  ], { turnId: "turn" });

  assert.equal(merged.length, 6);
  assert.equal(merged[0].text, "Одинаково");
  assert.deepEqual(merged.slice(1, 3).map((message) => message.itemId), [
    "external-1",
    "external-2",
  ]);
  assert.equal(merged[2].text, "Одинаково");
  assert.deepEqual(merged[2].origin, { kind: "desktop-import" });
  assert.equal(merged[3].text, "Legacy external without identity");
  assert.equal(merged[4].text, "Обновлённое external");
  assert.equal(merged[4].itemId, "external-2");
  assert.equal(merged[5].itemId, "turn:rollout-user:9");
});

test("a mixed managed turn preserves colliding and identity-free external occurrences", () => {
  const merged = mergeCanonicalUserMessages([{
    role: "user",
    text: "Managed",
    clientUserMessageId: "accepted",
  }], [{
    role: "user",
    text: "External stable",
    itemId: "provider-external",
  }, {
    role: "user",
    text: "External without identity",
  }, {
    role: "user",
    text: "External without identity",
  }, {
    role: "user",
    text: "Managed alias",
    itemId: "turn-mixed:rollout-user:0",
  }], { turnId: "turn-mixed" });

  assert.deepEqual(merged.map((message) => message.itemId ?? message.clientUserMessageId ?? null), [
    "accepted",
    "provider-external",
    null,
    null,
    "turn-mixed:rollout-user:0",
  ]);
});

test("provider item collisions and Hub-shaped hostile ids never become occurrence identity", () => {
  const merged = mergeCanonicalUserMessages([{
    role: "user",
    text: "Managed",
    clientUserMessageId: "accepted",
  }], [{
    role: "user",
    text: "First external",
    itemId: "same-provider-id",
  }, {
    role: "user",
    text: "Second external",
    itemId: "same-provider-id",
  }, {
    role: "user",
    text: "Hostile but legal external",
    itemId: "turn-hostile:rollout-user:0",
  }], { turnId: "turn-hostile" });

  assert.deepEqual(merged.map((message) => message.text), [
    "Managed",
    "First external",
    "Second external",
    "Hostile but legal external",
  ]);
});

test("one snapshot preserves a non-root rollout occurrence without ordinal guessing", () => {
  const values = canonicalizeUserMessages([{
    role: "user",
    text: "Managed",
    clientUserMessageId: "accepted",
  }, {
    role: "user",
    text: "Managed alias",
    itemId: "turn-one:rollout-user:0",
  }, {
    role: "user",
    text: "External",
    itemId: "provider-external",
  }], { turnId: "turn-one" });

  assert.deepEqual(values.map((message) => message.itemId ?? message.clientUserMessageId), [
    "accepted",
    "turn-one:rollout-user:0",
    "provider-external",
  ]);
});

test("one snapshot preserves unkeyed external content before an exact managed root", () => {
  const values = canonicalizeUserMessages([{
    role: "user",
    text: "Provider root",
    itemId: "turn-root:rollout-user:0",
  }, {
    role: "user",
    text: "Different canonical payload",
    clientUserMessageId: "accepted-root",
  }, {
    role: "user",
    text: "External",
    itemId: "provider-external",
  }]);

  assert.deepEqual(values.map((message) => message.itemId ?? message.clientUserMessageId), [
    "turn-root:rollout-user:0",
    "accepted-root",
    "provider-external",
  ]);
  assert.equal(values[0].clientUserMessageId, undefined);
  assert.equal(values[1].text, "Different canonical payload");
});

test("incremental snapshots preserve cross-snapshot provider itemId collisions", () => {
  const current = [{ role: "user", text: "Old external", itemId: "colliding-id" }];
  const observed = [{ role: "user", text: "New external", itemId: "colliding-id" }];

  assert.deepEqual(mergeCanonicalUserMessages(current, observed, {
    snapshotAuthority: USER_MESSAGE_SNAPSHOT_AUTHORITY.INCREMENTAL,
  }), [...current, ...observed]);
});

test("incremental source occurrences are replay-idempotent without collapsing new identical text", () => {
  const replayed = {
    role: "user",
    text: "Одинаковый внешний текст",
    itemId: "colliding-provider-id",
    sourceOccurrenceId: `codex-rollout:${"a".repeat(64)}`,
  };
  const appended = {
    ...replayed,
    sourceOccurrenceId: `codex-rollout:${"b".repeat(64)}`,
  };

  const first = mergeCanonicalUserMessages([], [replayed]);
  const second = mergeCanonicalUserMessages(first, [replayed]);
  const third = mergeCanonicalUserMessages(second, [replayed, appended]);
  const fourth = mergeCanonicalUserMessages(third, [replayed, appended]);

  assert.deepEqual(second, first);
  assert.deepEqual(third, [replayed, appended]);
  assert.deepEqual(fourth, third);
});

test("one source occurrence is replaced when App Server later supplies its exact client identity", () => {
  const sourceOccurrenceId = `codex-app-server:${"c".repeat(64)}`;
  const unkeyed = {
    itemId: "provider-item",
    role: "user",
    text: "Initial provider projection",
    sourceOccurrenceId,
  };
  const enriched = {
    itemId: "provider-item",
    role: "user",
    text: "Authoritative accepted payload",
    sourceOccurrenceId,
    clientUserMessageId: "accepted-message",
    origin: { streamId: "owning-stream" },
  };

  const first = mergeCanonicalUserMessages([], [unkeyed]);
  const second = mergeCanonicalUserMessages(first, [enriched]);
  const staleReplay = mergeCanonicalUserMessages(second, [unkeyed]);

  assert.equal(second.length, 1);
  assert.equal(second[0].clientUserMessageId, "accepted-message");
  assert.equal(second[0].sourceOccurrenceId, sourceOccurrenceId);
  assert.equal(second[0].text, "Authoritative accepted payload");
  assert.deepEqual(second[0].origin, { streamId: "owning-stream" });
  assert.deepEqual(staleReplay, second);
});

test("one source occurrence cannot reconcile two conflicting exact client identities", () => {
  const sourceOccurrenceId = `codex-app-server:${"d".repeat(64)}`;
  const first = {
    role: "user",
    text: "First accepted command",
    sourceOccurrenceId,
    clientUserMessageId: "accepted-one",
  };
  const conflicting = {
    role: "user",
    text: "Second accepted command",
    sourceOccurrenceId,
    clientUserMessageId: "accepted-two",
  };
  assert.deepEqual(mergeCanonicalUserMessages([first], [conflicting]), [first, conflicting]);
});

test("untrusted occurrence-shaped values do not collapse external messages", () => {
  const invalid = {
    role: "user",
    text: "External",
    sourceOccurrenceId: "provider-controlled-value",
  };
  assert.deepEqual(mergeCanonicalUserMessages([invalid], [invalid]), [invalid, invalid]);
});

test("an explicitly complete snapshot replaces provider projection wholesale without item matching", () => {
  const managed = { role: "user", text: "Owned", clientUserMessageId: "accepted" };
  const observed = [
    { role: "user", text: "First external", itemId: "colliding-id" },
    { role: "user", text: "Second external", itemId: "colliding-id" },
    { role: "user", text: "Identity-free" },
  ];
  const options = {
    currentSnapshotAuthority: USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE,
    snapshotAuthority: USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE,
  };
  const first = mergeCanonicalUserMessages([
    managed,
    { role: "user", text: "Stale provider", itemId: "colliding-id" },
  ], observed, options);
  const second = mergeCanonicalUserMessages(first, observed, options);

  assert.deepEqual(first, [managed, ...observed]);
  assert.deepEqual(second, first);
});

test("a complete observation cannot replace an unproven prior snapshot", () => {
  const oldExternal = { role: "user", text: "Old external", itemId: "colliding-id" };
  const newExternal = { role: "user", text: "New external", itemId: "colliding-id" };

  assert.deepEqual(mergeCanonicalUserMessages([oldExternal], [newExternal], {
    snapshotAuthority: USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE,
  }), [oldExternal, newExternal]);
});

test("rotated provider-only history preserves identical unkeyed occurrences and stable items", () => {
  const current = [
    { role: "user", text: "Одинаково", itemId: "external-before-rotation" },
    { role: "user", text: "Без identity" },
  ];
  const observed = [
    { role: "user", text: "Одинаково", itemId: "external-after-rotation" },
    { role: "user", text: "Без identity" },
    { role: "user", text: "Без identity" },
  ];

  const merged = mergeCanonicalUserMessages(current, observed);

  assert.deepEqual(merged.map((message) => message.itemId ?? null), [
    "external-before-rotation",
    null,
    "external-after-rotation",
    null,
    null,
  ]);
});

test("one exact managed identity remains one entity across stale aliases", () => {
  const merged = mergeCanonicalUserMessages([
    { role: "user", text: "Owned", clientUserMessageId: "accepted", itemId: "local" },
    { role: "user", text: "Stale alias", clientUserMessageId: "accepted", itemId: "stale" },
  ], [
    { role: "user", text: "Provider alias", clientUserMessageId: "accepted", itemId: "provider" },
  ]);

  assert.deepEqual(merged, [{
    role: "user",
    text: "Owned",
    clientUserMessageId: "accepted",
    itemId: "provider",
  }]);
});
