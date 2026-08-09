import assert from "node:assert/strict";
import test from "node:test";

import { reconcileCodexThreadSubscriptions } from "../../../src/providers/codex/codex-thread-subscriptions.mjs";

test("Codex subscription reconciliation retains selected and running threads", async () => {
  const calls = [];
  const sendRpc = async (method, params, options) => {
    calls.push([method, params, options]);
    if (method === "thread/loaded/list") return { data: ["selected", "running", "stale"], nextCursor: null };
    return { status: "unsubscribed" };
  };
  const result = await reconcileCodexThreadSubscriptions({
    sendRpc,
    selectedThreadId: "selected",
    activeRuns: [{ provider: "codex", threadId: "running", status: "running" }],
  });
  assert.deepEqual(result.released, [{ threadId: "stale", status: "unsubscribed" }]);
  assert.deepEqual(calls.filter(([method]) => method === "thread/unsubscribe").map(([, params]) => params.threadId), ["stale"]);
  assert.ok(calls.every(([, , options]) => options.priority === "background"));
});
