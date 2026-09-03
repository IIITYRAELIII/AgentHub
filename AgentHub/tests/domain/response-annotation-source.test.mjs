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
  assert.equal(normalizedResponseAnnotationSource(source({ end: 408 })), null);
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
