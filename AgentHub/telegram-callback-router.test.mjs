import assert from "node:assert/strict";
import test from "node:test";
import { contextualCallback } from "./callback-context.mjs";
import { routeTelegramCallback } from "./src/interfaces/telegram/telegram-callback-router.mjs";
import { parseApprovalCallback } from "./src/providers/codex/codex-approvals.mjs";

test("routes task, model and approval callback protocols", () => {
  assert.deepEqual(routeTelegramCallback("tasks-page:3", "abc"), {
    kind: "task-page",
    data: "tasks-page:3",
    page: 3,
  });
  assert.equal(
    routeTelegramCallback(contextualCallback("codex-reasoning:xhigh", "aaaaaaaaaaaa"), "aaaaaaaaaaaa").kind,
    "codex-reasoning",
  );
  assert.equal(
    routeTelegramCallback("a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:once", "abc", parseApprovalCallback).kind,
    "approval",
  );
});

test("rejects stale contextual controls before domain dispatch", () => {
  const data = contextualCallback("thread:archive", "aaaaaaaaaaaa");
  assert.equal(routeTelegramCallback(data, "bbbbbbbbbbbb").kind, "stale");
  assert.equal(routeTelegramCallback(data, "aaaaaaaaaaaa").kind, "thread-archive");
});

test("keeps legacy task view callbacks compatible", () => {
  assert.equal(routeTelegramCallback("show-message", "abc").kind, "task-view");
  assert.equal(routeTelegramCallback("task-diff", "abc").kind, "task-diff");
  const history = routeTelegramCallback("history-more:l:3", "abc");
  assert.equal(history.kind, "task-history");
  assert.equal(history.legacyHistory.count, "3");
});

test("routes an identity-bound task diff callback", () => {
  const route = routeTelegramCallback(
    "task-view:d:c:019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    "abc",
  );
  assert.equal(route.kind, "task-diff");
  assert.deepEqual(route.taskView, {
    action: "diff",
    provider: "codex",
    threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
    count: null,
  });
});

test("routes forward bundle controls without binding them to mutable task context", () => {
  const route = routeTelegramCallback(
    "forward-bundle:send:11111111-1111-4111-8111-111111111111",
    "abc",
  );
  assert.deepEqual(route, {
    kind: "forward-bundle",
    data: "forward-bundle:send:11111111-1111-4111-8111-111111111111",
    action: "send",
    id: "11111111-1111-4111-8111-111111111111",
  });
});
