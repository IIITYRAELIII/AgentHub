import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";
import { openClientEventFixture } from "./client-event.fixture.mjs";

const history = suffix => ({ provider: "codex", streamId: `stream-${suffix}`, threadId: `thread-${suffix}`,
  start: 0, end: 1, total: 1, messageTotal: 2, nextBefore: null, version: `navigation-${suffix}`,
  items: [{ id: `turn-${suffix}`, completed: true, terminalRevision: 1,
    messages: [{ role: "user", itemId: `user-${suffix}`, text: `Question ${suffix}` },
      { role: "agent", itemId: `final-${suffix}`, phase: "final_answer", text: `Answer ${suffix}` }] }] });

for (const route of ["#/chat/codex/thread-b", "#/chat/stream/stream-b"]) {
  test(`initial routed chat ${route} owns first history before background prefetch`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript(() => {
        let bridge;
        window.__routedGate = { calls: [], held: [] };
        Object.defineProperty(window, "__fixtureBridge", {
          configurable: true, get: () => bridge,
          set(value) {
            bridge = value;
            const post = bridge.postMessage.bind(bridge);
            bridge.postMessage = message => {
              window.__routedGate.calls.push({ action: message.action, threadId: message.params?.threadId });
              if (message.action === "open-task" && message.params?.threadId === "thread-b") {
                window.__routedGate.held.push(message); return;
              }
              return post(message);
            };
            window.__routedGate.release = () => {
              for (const message of window.__routedGate.held.splice(0)) post(message);
            };
          },
        });
      });
      const opening = openFixture(page, { fixtureSnapshot: snapshot(), fixtureHistory: history("b"),
        expectedTaskId: "stream-b", initialHash: route });
      await page.waitForFunction(() => window.__routedGate?.held.length > 0);
      const calls = await page.evaluate(() => window.__routedGate.calls);
      const firstSnapshot = calls.findIndex(call => call.action === "snapshot");
      const firstHistory = calls.findIndex(call => call.action === "open-task");
      if (route.includes("/stream/")) assert.ok(firstSnapshot >= 0 && firstSnapshot < firstHistory,
        "stable Stream route resolves its binding from the initial snapshot");
      else assert.equal(firstSnapshot, -1, "an exact provider/Thread route reads history before its initial snapshot");
      assert.equal(calls.filter(call => call.action === "task-history" && call.threadId !== "thread-b").length, 0);
      await page.evaluate(() => window.__routedGate.release());
      const diagnostics = await opening;
      await page.getByText("Answer b", { exact: true }).waitFor();
      await page.waitForFunction(() => window.__routedGate.calls.some(call => call.action === "snapshot"));
      assert.equal(await page.locator("[data-chat-pane]").getAttribute("data-stream-chat-task-id"), "stream-b");
      assert.deepEqual(diagnostics, []);
    } finally { await browser.close(); }
  });
}

for (const disposition of ["late success", "late rejection", "invalid chat hash"]) {
  test(`real client fences an obsolete navigation after ${disposition}`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const diagnostics = await openFixture(page, { fixtureSnapshot: snapshot(), fixtureHistory: history("a") });
      await page.getByText("Answer a", { exact: true }).waitFor();
      await page.evaluate(value => {
        window.__navigationGate = { held: [], history: value };
        const bridge = window.__fixtureBridge;
        const original = bridge.postMessage.bind(bridge);
        bridge.postMessage = message => {
          if (message.params?.streamId === "stream-b" && ["select-task", "task-history"].includes(message.action)) {
            window.__navigationGate.held.push(message);
            return;
          }
          return original(message);
        };
        window.__toastHistory.length = 0;
      }, history("b"));
      await page.locator("[data-stream-task-id='stream-b']:visible").first().click();
      await page.waitForFunction(() => ["select-task", "task-history"].every(action => window.__navigationGate.held.some(m => m.action === action)));
      if (disposition === "invalid chat hash") {
        await page.evaluate(() => { location.hash = "#/not-a-chat"; });
        await page.waitForFunction(() => location.hash === "#/not-a-chat");
      } else {
        await page.locator("[data-stream-task-id='stream-a']:visible").first().click();
        await page.getByText("Answer a", { exact: true }).waitFor();
      }
      await page.evaluate(rejected => {
        for (const message of window.__navigationGate.held.splice(0)) {
          const failed = rejected && message.action === "select-task";
          window.dispatchEvent(new MessageEvent("message", { data: {
            type: "agenthub:control-result", id: message.id, ok: !failed,
            ...(failed ? { error: "Obsolete navigation rejected" } : { result: message.action === "task-history"
              ? window.__navigationGate.history : { selectionChanged: true, snapshotDeferred: true } }),
          } }));
        }
      }, disposition === "late rejection");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByText("Answer b", { exact: true }).count(), 0,
        "the obsolete history response cannot commit to the current surface");
      if (disposition !== "invalid chat hash") {
        assert.equal(await page.locator("[data-chat-pane]").getAttribute("data-stream-chat-task-id"), "stream-a");
        assert.equal(await page.getByText("Answer a", { exact: true }).isVisible(), true);
      } else assert.equal(await page.evaluate(() => location.hash), "#/not-a-chat");
      assert.deepEqual(await page.evaluate(() => window.__toastHistory), [], "an obsolete rejection cannot toast against a newer intent");
      assert.deepEqual(diagnostics, []);
    } finally { await browser.close(); }
  });
}

for (const [intent, detail, action] of [
  ["task:new", { title: "Created", provider: "codex" }, "new-task"],
  ["stream:rebirth", { streamId: "stream-a", taskId: "stream-a", provider: "codex" }, "rotate-stream"],
  ["stream:continue-provider", { streamId: "stream-a", provider: "claude" }, "new-task"],
  ["stream:new", { workspaceId: "workspace-1" }, "create-stream"],
  ["message:send", { requestId: "navigation-draft-command", taskId: "stream-a", streamId: "stream-a",
    draftStream: true, text: "Create draft Thread", settings: { provider: "codex" } }, "new-task"],
]) {
  test(`public selecting intent ${intent} invalidates an older pending navigation`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const diagnostics = await openClientEventFixture(page, { fixtureSnapshot: snapshot(), fixtureHistory: history("a") });
      await page.getByText("Answer a", { exact: true }).waitFor();
      await page.evaluate(({ history, newAction }) => {
        window.__intentGate = { old: [], next: [], newAction, history, done: false };
        const bridge = window.__fixtureBridge;
        const post = bridge.postMessage.bind(bridge);
        bridge.postMessage = message => {
          const gate = window.__intentGate;
          if (message.action === gate.newAction) { gate.next.push(message); return; }
          if (message.params?.streamId === "stream-b" && ["select-task", "task-history"].includes(message.action)) {
            gate.old.push(message); return;
          }
          return post(message);
        };
      }, { history: history("b"), newAction: action });
      await page.locator("[data-stream-task-id='stream-b']:visible").first().click();
      await page.waitForFunction(() => window.__intentGate.old.some(message => message.action === "task-history"));
      await page.evaluate(({ intent, detail }) => {
        window.__dispatchClientFixture(intent, detail).finally(() => { window.__intentGate.done = true; });
      }, { intent, detail });
      await page.waitForFunction(() => window.__intentGate.next.length > 0);
      await page.evaluate(() => {
        for (const message of window.__intentGate.old.splice(0)) window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: message.id, ok: true, result: message.action === "task-history"
            ? window.__intentGate.history : { selectionChanged: true, snapshotDeferred: true },
        } }));
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByText("Answer b", { exact: true }).count(), 0);
      // Settle the deliberately held new command explicitly. This is a known
      // fixture refusal, not a second command, provider turn or timeout.
      await page.evaluate(() => {
        for (const message of window.__intentGate.next.splice(0)) window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: message.id, ok: false, error: "Synthetic creation refused",
        } }));
      });
      await page.waitForFunction(() => window.__intentGate.done);
      assert.deepEqual(diagnostics, []);
    } finally { await browser.close(); }
  });
}
