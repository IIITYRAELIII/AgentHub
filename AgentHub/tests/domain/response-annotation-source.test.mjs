import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  normalizedResponseAnnotations,
  normalizedResponseAnnotationSource,
  responseAnnotationSourceMessageKey,
} from "../../src/domain/response-annotation-source.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

test("trace group locators survive preview eviction without weakening exact content identity", async () => {
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  context.window = context;
  vm.runInContext(await readFile(new URL("../../assets/web-app/messages/disclosure.js", import.meta.url), "utf8"), context);
  const api = context.AgentHubMessageDisclosure;
  const locator = source({ surfaceKind: "trace-reasoning", traceGroupId: "reasoning:exact" });
  assert.deepEqual(normalizedResponseAnnotationSource(locator), locator);
  assert.deepEqual(JSON.parse(JSON.stringify(api.normalizedResponseAnnotationSource(locator))), locator);
  const group = { id: locator.traceGroupId, reasoning: "Полный исходный текст", activities: [] };
  const message = { ...locator, activityGroups: [group], text: "Answer" };
  const content = api.responseAnnotationSourceContent(message, locator);
  assert.equal(api.responseAnnotationSourceContent({ ...message, text: "New answer",
    activityGroups: [{ id: "other", reasoning: "other" }, group] }, locator), content);
  assert.notEqual(api.responseAnnotationSourceContent({ ...message,
    activityGroups: [{ ...group, reasoning: "Changed" }] }, locator), content);
  for (const activityGroups of [[], [group, group]]) {
    assert.equal(api.responseAnnotationSourceContent({ ...message, activityGroups }, locator), "");
  }
  for (const invalid of [{ ...locator, role: "user" }, { ...locator, surfaceKind: "message-body" }]) {
    assert.equal(normalizedResponseAnnotationSource(invalid), null);
    assert.equal(api.normalizedResponseAnnotationSource(invalid), null);
  }
});

function source(overrides = {}) {
  const identity = {
    provider: "codex",
    threadId: "thread-source",
    turnId: "turn-source",
    itemId: "item-source",
    role: "agent",
    ...overrides,
  };
  return {
    version: 1,
    ...identity,
    messageKey: responseAnnotationSourceMessageKey(identity),
    surfaceKind: "message-body",
    surfaceIndex: 0,
    start: 7,
    end: 19,
    contentHash: HASH_A,
    surfaceHash: HASH_B,
    selectionHash: HASH_C,
    ...overrides,
  };
}

test("response annotation source accepts only exact bounded provider item ranges", () => {
  assert.deepEqual(normalizedResponseAnnotationSource(source()), source());
  assert.equal(normalizedResponseAnnotationSource(source({ end: 1_000_001 })), null);
  assert.equal(normalizedResponseAnnotationSource(source({ start: -1 })), null);
  assert.equal(normalizedResponseAnnotationSource(source({ contentHash: "sha256:nope" })), null);
  assert.equal(normalizedResponseAnnotationSource(source({ messageKey: "provider\u001fwrong" })), null);
  assert.deepEqual(normalizedResponseAnnotationSource(source({ role: "user" })), source({ role: "user" }));
  assert.equal(normalizedResponseAnnotationSource(source({ role: "system" })), null);
});

test("invalid source metadata fails closed without discarding readable legacy annotation", () => {
  assert.deepEqual(normalizedResponseAnnotations([{
    text: "Читаемая цитата",
    annotation: "Проверить",
    source: source({ turnId: "wrong", messageKey: "stale" }),
  }]), [{ text: "Читаемая цитата", annotation: "Проверить" }]);
});

test("client user locators remain exact across item hydration and preserve provider locators", async () => {
  const script = await readFile(new URL("../../assets/web-app/messages/disclosure.js", import.meta.url), "utf8");
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  context.window = context;
  vm.runInContext(script, context);
  const api = context.AgentHubMessageDisclosure;
  const user = {
    provider: "codex", threadId: "thread-source", turnId: "turn-source", itemId: "",
    clientUserMessageId: "ordinary-client", role: "user", text: "проценты",
  };
  const locator = source({ role: "user", turnId: "", itemId: "", clientUserMessageId: "ordinary-client" });
  assert.deepEqual(normalizedResponseAnnotationSource(locator), locator);
  assert.deepEqual(JSON.parse(JSON.stringify(api.normalizedResponseAnnotationSource(locator))), locator);
  const hydrated = { ...user, itemId: "item-source" };
  assert.equal(api.responseAnnotationSourceProjection([hydrated], locator).message, hydrated);
  assert.equal(api.responseAnnotationSourceContent(user), api.responseAnnotationSourceContent(hydrated, locator));
  const providerLocator = source({ role: "user" });
  assert.equal(api.responseAnnotationSourceProjection([hydrated], providerLocator).message, hydrated);
  assert.equal(api.responseAnnotationSourceContent(hydrated, providerLocator),
    api.responseAnnotationSourceContent({ ...hydrated, clientUserMessageId: "" }));
  assert.equal(api.responseAnnotationSourceProjection([{ ...user, clientUserMessageId: "different" }], locator), null);
  assert.equal(api.responseAnnotationSourceProjection([{ ...user, threadId: "different" }], locator), null);
  assert.equal(api.responseAnnotationSourceProjection([user, hydrated], locator), null);
  for (const invalid of [
    { ...locator, role: "agent" },
    { ...locator, clientUserMessageId: "bad\u001fid" },
    { ...locator, turnId: "mixed-provider-turn" },
    { ...locator, itemId: "mixed-provider-item" },
    { ...locator, messageKey: providerLocator.messageKey },
    { ...locator, selectionHash: "missing" },
    { ...locator, end: 1_000_001 },
  ]) {
    assert.equal(normalizedResponseAnnotationSource(invalid), null);
    assert.equal(api.normalizedResponseAnnotationSource(invalid), null);
  }
});

test("browser and backend source normalizers keep the same canonical schema", async () => {
  const script = await readFile(
    new URL("../../assets/web-app/messages/disclosure.js", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  context.window = context;
  vm.runInContext(script, context);
  const browserSource = context.AgentHubMessageDisclosure.normalizedResponseAnnotationSource(source());
  assert.deepEqual(JSON.parse(JSON.stringify(browserSource)), source());
  const digest = await context.AgentHubMessageDisclosure.responseAnnotationSha256("exact content");
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
  for (const length of [401, 430, 12_000]) {
    const text = "Полная цитата. ".repeat(length).slice(0, length - 1) + "!";
    const locator = source({ end: 7 + text.length });
    assert.deepEqual(normalizedResponseAnnotationSource(locator), locator);
    assert.deepEqual(JSON.parse(JSON.stringify(
      context.AgentHubMessageDisclosure.normalizedResponseAnnotationSource(locator),
    )), locator);
    assert.deepEqual(normalizedResponseAnnotations([{ text, source: locator }]), [
      { text, annotation: "", source: locator },
    ]);
  }
});

test("browser source resolution ignores equal text and fails closed on absent identity or stale hashes", async () => {
  const script = await readFile(
    new URL("../../assets/web-app/messages/disclosure.js", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  context.window = context;
  vm.runInContext(script, context);
  const api = context.AgentHubMessageDisclosure;
  const exact = {
    provider: "codex",
    threadId: "thread-source",
    turnId: "turn-source",
    itemId: "item-source",
    role: "agent",
    text: "same text",
  };
  const wrong = { ...exact, itemId: "wrong-item", text: "same text" };
  assert.equal(api.responseAnnotationSourceProjection([wrong, exact], source()).index, 1);
  assert.equal(api.responseAnnotationSourceProjection([wrong], source()), null);
  assert.equal(api.responseAnnotationSourceHashesMatch(source(), {
    contentHash: HASH_A,
    surfaceHash: HASH_B,
    selectionHash: HASH_C,
  }), true);
  assert.equal(api.responseAnnotationSourceHashesMatch(source(), {
    contentHash: HASH_A,
    surfaceHash: HASH_B,
    selectionHash: `sha256:${"d".repeat(64)}`,
  }), false);
});

test("browser source projection accepts user and non-final agent identities with canonical history precedence", async () => {
  const script = await readFile(
    new URL("../../assets/web-app/messages/disclosure.js", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  context.window = context;
  vm.runInContext(script, context);
  const api = context.AgentHubMessageDisclosure;
  const user = {
    provider: "codex", threadId: "thread-source", turnId: "turn-user", itemId: "item-user",
    role: "user", text: "same text",
  };
  const commentary = {
    provider: "codex", threadId: "thread-source", turnId: "turn-live", itemId: "item-commentary",
    role: "agent", responsePhase: "commentary", text: "same text",
  };
  assert.equal(api.responseAnnotationSourceIdentity(user).role, "user");
  assert.equal(api.responseAnnotationSourceIdentity(commentary).itemId, "item-commentary");
  const exactHistory = { ...commentary, text: "terminal projection" };
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.responseAnnotationSourceMessages([user, exactHistory], commentary))),
    [user, exactHistory],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.responseAnnotationSourceMessages([user], commentary))),
    [user, commentary],
  );
});
