import assert from "node:assert/strict";
import test from "node:test";

import {
  consistentInterstreamRecordIdentity,
  createInterstreamMessage,
  interstreamAuditContentHash,
  interstreamDisplayText,
  interstreamMessageDetails,
  trustedAuditedInterstreamBodyDetails,
  trustedInterstreamMessageDetails,
  verifiedLegacyInterstreamSteer,
} from "../../src/domain/interstream-message.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";

const origin = {
  kind: "interstream",
  workspaceId: "workspace-1",
  workspaceName: "Agent HUB",
  streamId: "stream-release-manager",
  streamName: "Release Manager",
  provider: "codex",
  model: "gpt-5.6-sol",
  sourceThreadId: "thread-release-manager",
  requestId: "interstream-1",
};

const envelope = createInterstreamMessage({ ...origin, text: "Проверь доставку." });

test("legacy idle steer requires exact original mode, immutable receipt and authenticated body", () => {
  const item = { id: "item", clientUserMessageId: `mcp:${origin.requestId}`, streamId: "destination",
    messageOrigin: origin, input: envelope };
  const args = { confirm_send: true, request_id: origin.requestId, stream_id: item.streamId, text: "Проверь доставку." };
  const op = { status: "succeeded", toolName: "hub_stream_message_send", requestId: origin.requestId,
    workspaceId: origin.workspaceId, streamId: origin.streamId, provider: origin.provider, threadId: origin.sourceThreadId,
    argumentsHash: mcpArgumentsHash({ ...args, mode: "steer" }), interstreamContentHash: interstreamAuditContentHash(envelope),
    result: { target: { streamId: item.streamId }, delivery: { id: item.id, clientUserMessageId: item.clientUserMessageId,
      streamId: item.streamId, queued: true, providerAccepted: false } } };
  assert.equal(verifiedLegacyInterstreamSteer(item, op), true);
  for (const change of [{ status: "unknown" }, { toolName: "hub_task_start" }, { streamId: "foreign" },
    { threadId: "foreign" }, { interstreamContentHash: "" }, { argumentsHash: mcpArgumentsHash({ ...args, mode: "queue" }) },
    { argumentsHash: mcpArgumentsHash(args) }, { requestId: "foreign" }]) {
    assert.equal(verifiedLegacyInterstreamSteer(item, { ...op, ...change }), false);
  }
  assert.equal(verifiedLegacyInterstreamSteer({ ...item, input: envelope + " substituted" }, op), false);
  assert.equal(verifiedLegacyInterstreamSteer({ ...item, id: "foreign" }, op), false);
  assert.equal(verifiedLegacyInterstreamSteer(item, { ...op, result: { ...op.result,
    delivery: { ...op.result.delivery, providerAccepted: true, turnId: "accepted" } } }), false);
});

test("interstream display text requires exact transport identity", () => {
  assert.equal(interstreamDisplayText(envelope, {
    origin,
    clientUserMessageId: "mcp:interstream-1",
  }), "Проверь доставку.");
  assert.equal(trustedInterstreamMessageDetails(envelope, {
    origin: { ...origin, streamId: "stream-other" },
    clientUserMessageId: "mcp:interstream-1",
  }), null);
  assert.equal(trustedInterstreamMessageDetails(envelope, {
    origin,
    clientUserMessageId: "mcp:interstream-other",
  }), null);
});

test("interstream-like literal text remains visible without authoritative identity", () => {
  assert.equal(interstreamDisplayText(envelope), envelope);
  assert.equal(interstreamDisplayText(envelope, {
    clientUserMessageId: "mcp:interstream-1",
  }), envelope);
  assert.equal(interstreamDisplayText(envelope, {
    clientUserMessageId: "ordinary-user-message",
  }), envelope);
});

test("trusted interstream identity fails closed for every conflicting field", () => {
  for (const conflict of [
    { workspaceId: "workspace-other" },
    { streamId: "stream-other" },
    { sourceThreadId: "thread-other" },
    { requestId: "interstream-other" },
  ]) {
    assert.equal(trustedInterstreamMessageDetails(envelope, {
      origin: { ...origin, ...conflict },
      clientUserMessageId: "mcp:interstream-1",
    }), null);
  }
});

test("audited interstream identity ignores descriptive drift but requires every stable field", () => {
  const auditOrigin = {
    ...origin,
    workspaceName: "Renamed workspace",
    streamName: "S4",
  };
  delete auditOrigin.model;
  delete auditOrigin.workspaceName;
  delete auditOrigin.streamName;
  const audit = {
    ...auditOrigin,
    workspaceName: "Renamed workspace",
    streamName: "S4",
    toolName: "hub_stream_message_send",
    argumentsHash: "a".repeat(64),
    contentHash: interstreamAuditContentHash(envelope),
  };
  assert.equal(trustedInterstreamMessageDetails(envelope, {
    origin: audit,
    clientUserMessageId: "mcp:interstream-1",
    audited: true,
  })?.text, "Проверь доставку.");
  assert.equal(trustedAuditedInterstreamBodyDetails("Проверь доставку.", {
    origin: audit,
    clientUserMessageId: "mcp:interstream-1",
  })?.text, "Проверь доставку.");
  assert.equal(trustedInterstreamMessageDetails(createInterstreamMessage({
    ...origin,
    text: "Подменённый body.",
  }), {
    origin: audit,
    clientUserMessageId: "mcp:interstream-1",
    audited: true,
  }), null);
  assert.equal(trustedInterstreamMessageDetails(envelope, {
    origin: { ...audit, sourceThreadId: "thread-other" },
    clientUserMessageId: "mcp:interstream-1",
    audited: true,
  }), null);
  assert.equal(trustedInterstreamMessageDetails(envelope, {
    origin: { ...audit, provider: "claude" },
    clientUserMessageId: "mcp:interstream-1",
    audited: true,
  }), null);
  const { sourceThreadId: _sourceThreadId, ...missingSourceThread } = audit;
  assert.equal(trustedInterstreamMessageDetails(envelope, {
    origin: missingSourceThread,
    clientUserMessageId: "mcp:interstream-1",
    audited: true,
  }), null);
  assert.equal(trustedInterstreamMessageDetails(envelope, {
    origin: audit,
    audited: true,
  }), null);
  assert.equal(trustedInterstreamMessageDetails(envelope, {
    origin: audit,
    clientUserMessageId: "mcp:interstream-1",
  }), null);
});

test("record identity fails closed for conflicting and oversized candidates", () => {
  assert.deepEqual(consistentInterstreamRecordIdentity({
    clientUserMessageIds: ["mcp:one", "mcp:two"],
    origins: [origin, { ...origin, requestId: "two" }],
  }), { conflicted: true, clientUserMessageId: null, messageOrigin: null });
  assert.equal(consistentInterstreamRecordIdentity({
    clientUserMessageIds: ["x".repeat(201)],
  }).conflicted, true);
});

test("interstream parser round-trips arbitrary Unicode and transport tags in the body", () => {
  const text = [
    "  Привет, мир 👋  ",
    "<agent-hub-stream-message>",
    "Литеральный </agent-hub-stream-message> внутри body.",
    "<agent-hub-stream-message></agent-hub-stream-message>",
  ].join("\n\n");
  const value = `\n\t${createInterstreamMessage({ ...origin, text })}\n`;
  const details = interstreamMessageDetails(value);
  assert.equal(details.text, text.trim());
  assert.deepEqual(details.origin, origin);
});

test("interstream parser rejects malformed outer framing, nested headers, and empty bodies", () => {
  const metadata = JSON.stringify(origin);
  const malformed = [
    `<agent-hub-stream-message>\n{bad json}\n</agent-hub-stream-message>\nbody`,
    `<agent-hub-stream-message>\n${metadata}\nbody`,
    `<agent-hub-stream-message>\n${metadata}\n</agent-hub-stream-message>\n`,
    `<agent-hub-stream-message>\n${metadata}\n<agent-hub-stream-message>\n</agent-hub-stream-message>\nbody`,
  ];
  for (const value of malformed) assert.equal(interstreamMessageDetails(value), null);
});

test("legacy origin without source thread matches only the same durable identity", () => {
  const { sourceThreadId: _sourceThreadId, ...legacyOrigin } = origin;
  const legacyEnvelope = createInterstreamMessage({ ...legacyOrigin, text: "Legacy body" });
  assert.equal(trustedInterstreamMessageDetails(legacyEnvelope, {
    origin: legacyOrigin,
    clientUserMessageId: "mcp:interstream-1",
  })?.text, "Legacy body");
  assert.equal(trustedInterstreamMessageDetails(legacyEnvelope, {
    origin,
    clientUserMessageId: "mcp:interstream-1",
  }), null);
});
