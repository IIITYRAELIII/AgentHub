import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStreamHandoffPackage,
  prependStreamHandoff,
  streamHandoffReason,
} from "../../src/domain/stream-handoff.mjs";

const turns = [
  {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-2",
    title: "Сделал реализацию",
    prompt: "давай сделаем",
    body: "Готово, коммит 43fca1b0.",
    changedFiles: ["AgentHub/src/app.mjs", "CHANGELOG.md"],
    startedAt: "2026-08-19T15:07:30.448Z",
    completedAt: "2026-08-19T15:17:35.140Z",
    status: "completed",
  },
  {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    title: "Продумал ротацию",
    prompt: "подумай как сделать",
    body: "Нужен neutral handoff-пакет.",
    changedFiles: ["AgentHub/src/app.mjs"],
    startedAt: "2026-08-19T06:17:48.499Z",
    completedAt: "2026-08-19T06:20:41.568Z",
    status: "completed",
  },
];

test("stream handoff package orders turns oldest first and lists changed files once", () => {
  const handoff = buildStreamHandoffPackage({
    workspaceName: "AgentHub",
    workspaceId: "workspace-1",
    streamName: "Stream 43",
    streamId: "stream-1",
    sourceProvider: "codex",
    sourceThreadId: "thread-1",
    targetProvider: "claude",
    reason: "manual",
    requestedAt: "2026-08-19T17:40:00.000Z",
    turns,
  });

  assert.match(handoff, /^<agent_hub_stream_handoff>/u);
  assert.match(handoff, /<\/agent_hub_stream_handoff>$/u);
  assert.match(handoff, /Stream: Stream 43 \(stream-1\)/u);
  assert.match(handoff, /Handed over: codex\/thread-1 -> claude/u);
  assert.equal(handoff.indexOf("Продумал ротацию") < handoff.indexOf("Сделал реализацию"), true);
  assert.equal(handoff.match(/- AgentHub\/src\/app\.mjs/gu).length, 1);
  assert.match(handoff, /- CHANGELOG\.md/u);
});

test("stream handoff package states that it is a Hub snapshot, not native context", () => {
  const handoff = buildStreamHandoffPackage({ streamId: "stream-1", targetProvider: "claude", turns: [] });
  assert.match(handoff, /compressed snapshot, not the previous agent's native context/u);
  assert.match(handoff, /Agent Hub has no recorded turns for this Stream yet\./u);
});

test("stream handoff package skips aborted turns", () => {
  const handoff = buildStreamHandoffPackage({
    streamId: "stream-1",
    targetProvider: "claude",
    turns: [...turns, {
      provider: "claude",
      title: "Failed to authenticate",
      body: "API Error: 403",
      startedAt: "2026-08-19T17:14:13.828Z",
      status: "aborted",
    }],
  });
  assert.equal(handoff.includes("Failed to authenticate"), false);
});

test("prepending a handoff keeps the input shape of both providers", () => {
  assert.equal(prependStreamHandoff("сделай", "PACKAGE"), "PACKAGE\n\nсделай");
  assert.deepEqual(prependStreamHandoff([{ type: "text", text: "сделай" }], "PACKAGE"), [
    { type: "text", text: "PACKAGE" },
    { type: "text", text: "сделай" },
  ]);
});

test("an empty handoff leaves the input untouched", () => {
  const input = [{ type: "text", text: "сделай" }];
  assert.equal(prependStreamHandoff(input, ""), input);
  assert.equal(prependStreamHandoff("сделай", "   "), "сделай");
});

test("unknown handoff reasons fall back to manual", () => {
  assert.equal(streamHandoffReason("rate-limit"), "rate-limit");
  assert.equal(streamHandoffReason("whatever"), "manual");
  assert.equal(streamHandoffReason(undefined), "manual");
});
