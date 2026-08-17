import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function navigationTabsApi() {
  const source = await readFile(
    new URL("../../assets/web-app/navigation-tabs-controller.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubNavigationTabs;
}

test("every standalone section remains active after storage restoration", async () => {
  const { isStandaloneNavigationTab, storedNavigationTab } = await navigationTabsApi();
  for (const tab of ["dashboard", "journal", "statistics", "background", "server"]) {
    const restored = storedNavigationTab({ getItem: () => tab }, "navigation-key");
    assert.equal(restored, tab);
    assert.equal(isStandaloneNavigationTab(restored), true);
  }
});
test("task and chat panes remain active after storage restoration", async () => {
  const { currentNavigationTab, storedNavigationTab } = await navigationTabsApi();
  for (const tab of ["tasks", "chat"]) {
    const restored = storedNavigationTab({ getItem: () => tab }, "navigation-key");
    assert.equal(currentNavigationTab("chat", restored), tab);
  }
});

test("invalid or unavailable storage safely falls back to tasks", async () => {
  const { storedNavigationTab } = await navigationTabsApi();
  assert.equal(storedNavigationTab({ getItem: () => "unknown" }, "navigation-key"), "tasks");
  assert.equal(storedNavigationTab({ getItem: () => { throw new Error("blocked"); } }), "tasks");
});

test("a rotated Thread route follows the current history identity", async () => {
  const { resolvedChatRoute } = await navigationTabsApi();
  const route = resolvedChatRoute(
    { history: { provider: "codex", threadId: "thread-current", streamId: "stream-1" } },
    { provider: "codex", threadId: "thread-old" },
  );
  assert.equal(route.provider, "codex");
  assert.equal(route.threadId, "thread-current");
  assert.equal(route.streamId, "stream-1");
  assert.equal(route.hash, "#/chat/stream/stream-1");
});

test("chat route falls back to provider and Thread only when Stream is unknown", async () => {
  const { resolvedChatRoute } = await navigationTabsApi();
  const route = resolvedChatRoute(
    { history: { provider: "codex", threadId: "thread-current" } },
    { provider: "codex", threadId: "thread-old" },
  );
  assert.equal(route.provider, "codex");
  assert.equal(route.threadId, "thread-current");
  assert.equal(route.streamId, "");
  assert.equal(route.hash, "#/chat/codex/thread-current");
});
