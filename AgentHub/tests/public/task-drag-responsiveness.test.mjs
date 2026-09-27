import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

const movedTask = {
  id: "board-drag", taskNumber: "HUB-DRAG", title: "Move without duplicate",
  bucket: "backlog", workspaceId: null, workflowStatus: "new", status: "open",
  revision: 1, attachments: [], checklist: [],
};

async function dropTask(page, destination) {
  return page.evaluate(({ task, targetSelector }) => {
    const transfer = new DataTransfer();
    transfer.setData(window.AgentHubTaskReferences.MIME, JSON.stringify({
      kind: "task", taskId: task.id, title: task.title,
    }));
    const started = performance.now();
    document.querySelector(targetSelector).dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true, dataTransfer: transfer,
    }));
    return performance.now() - started;
  }, { task: movedTask, targetSelector: destination });
}

test("Task reference appears while the target Stream history has not answered", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await openFixture(page);
    await page.evaluate(() => {
      const send = window.__agentHubVscode.postMessage;
      window.__heldNavigation = [];
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === "open-task") { window.__heldNavigation.push(message); return; }
        send(message);
      };
    });
    const duration = await dropTask(page, '[data-stream-task-id="stream-b"]');
    assert.ok(duration < 1_000, `local drop took ${duration} ms`);
    assert.equal(await page.locator("[data-attachments] .attachment-task-reference").count(), 1);
    assert.equal(await page.evaluate(() => window.__heldNavigation.length), 1);
    assert.match(await page.locator("[data-attachments]").textContent(), /Move without duplicate/u);
  } finally { await browser.close(); }
});

for (const accepted of [true, false]) {
  test(`Dashboard drop immediately shows pending and clears on ${accepted ? "confirmed move" : "rejection"}`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => localStorage.setItem("agent-hub.dashboard.view", "workspaces"));
      const initial = snapshot();
      initial.boardTasks = [movedTask];
      await openFixture(page, { fixtureSnapshot: initial });
      await page.evaluate(() => {
        document.documentElement.dataset.view = "dashboard";
        const send = window.__agentHubVscode.postMessage;
        window.__heldBoardMoves = [];
        window.__agentHubVscode.postMessage = (message) => {
          if (message.action === "board-task-move") { window.__heldBoardMoves.push(message); return; }
          send(message);
        };
      });
      const duration = await dropTask(page, '[data-board-destination="notes"]');
      assert.ok(duration < 1_000, `pending feedback took ${duration} ms`);
      const card = page.locator('[data-board-destination="backlog"] [data-board-task-id="board-drag"]');
      assert.equal(await card.getAttribute("aria-busy"), "true");
      assert.equal(await card.locator("[data-board-task-pending]").textContent(), "Сохраняется…");
      assert.equal(await card.getAttribute("data-board-task-movable"), null);
      await dropTask(page, '[data-board-destination="notes"]');
      assert.equal(await page.evaluate(() => window.__heldBoardMoves.length), 1);
      const next = { ...initial, version: "confirmed-move", boardTasks: [{ ...movedTask, bucket: "notes", revision: 2 }] };
      await page.evaluate(({ ok, result }) => {
        const message = window.__heldBoardMoves[0];
        if (ok) window.__agentHubFixture.snapshot = result;
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: message.id, ok, result: {
            view: "task-board", boardTasks: result.boardTasks,
            workspaces: result.workspaces, boardLayout: result.boardLayout,
          },
          error: ok ? "" : "Перенос отклонён",
        } }));
      }, { ok: accepted, result: next });
      await page.waitForFunction(() => !document.querySelector('[data-board-task-id="board-drag"][aria-busy="true"]'));
      const destination = accepted ? "notes" : "backlog";
      assert.equal(await page.locator(`[data-board-destination="${destination}"] [data-board-task-id="board-drag"]`).count(), 1,
        await page.evaluate(() => JSON.stringify({
          cards: [...document.querySelectorAll('[data-board-task-id="board-drag"]')].map(card => ({
            column: card.closest("[data-board-destination]")?.dataset.boardDestination, text: card.textContent,
          })), toasts: window.__toastHistory,
        })));
      assert.equal(await page.locator('[data-board-task-id="board-drag"] [data-board-task-pending]').count(), 0);
      assert.equal(await page.evaluate(() => window.__heldBoardMoves.length), 1);
    } finally { await browser.close(); }
  });
}

test("Dashboard status drop keeps the current lane visibly pending until confirmed", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const initial = snapshot();
    initial.boardTasks = [{ ...movedTask, bucket: "notes" }];
    await openFixture(page, { fixtureSnapshot: initial });
    await page.evaluate(() => {
      document.documentElement.dataset.view = "dashboard";
      const send = window.__agentHubVscode.postMessage;
      window.__heldStatuses = [];
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === "board-task-status") { window.__heldStatuses.push(message); return; }
        send(message);
      };
    });
    const selector = '[data-board-destination="status:lane:notes:testing"]';
    await dropTask(page, selector);
    const previous = page.locator('[data-board-destination="status:lane:notes:new"] [data-board-task-id="board-drag"]');
    assert.equal(await previous.getAttribute("aria-busy"), "true");
    await dropTask(page, selector);
    assert.equal(await page.evaluate(() => window.__heldStatuses.length), 1);
    await page.evaluate((initialSnapshot) => {
      const next = { ...initialSnapshot, version: "status-confirmed",
        boardTasks: initialSnapshot.boardTasks.map(task => ({ ...task, workflowStatus: "testing", revision: 2 })) };
      window.__agentHubFixture.snapshot = next;
      window.dispatchEvent(new MessageEvent("message", { data: {
        type: "agenthub:control-result", id: window.__heldStatuses[0].id, ok: true,
        result: { view: "task-board", boardTasks: next.boardTasks,
          workspaces: next.workspaces, boardLayout: next.boardLayout },
      } }));
    }, initial);
    await page.waitForFunction(() => !document.querySelector('[data-board-task-id="board-drag"][aria-busy="true"]'));
    assert.equal(await page.locator(`${selector} [data-board-task-id="board-drag"]`).count(), 1);
    assert.equal(await page.locator('[data-board-task-id="board-drag"] [data-board-task-pending]').count(), 0);
  } finally { await browser.close(); }
});


for (const destination of ["board", "stream", "composer", "dashboard-composer"]) {
  test(`Native Task drag to ${destination} stays responsive with a populated board`, { timeout: 35_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.addInitScript(() => localStorage.setItem("agent-hub.dashboard.view", "workspaces"));
      const initial = snapshot();
      initial.boardTasks = Array.from({ length: 300 }, (_, index) => ({
        ...movedTask, id: `native-${index}`, taskNumber: `HUB-${index}`,
        title: "Task with a long title for native dragging ".repeat(5) + index,
        bucket: index % 2 ? "workspace" : "backlog",
        workspaceId: index % 2 ? "workspace-1" : null,
      }));
      await openFixture(page, { fixtureSnapshot: initial });
      await page.evaluate((target) => {
        document.documentElement.dataset.view = target.startsWith("board") || target.startsWith("dashboard") ? "dashboard" : "chat";
        window.__nativeEvents = [];
        window.__dragTrace = [];
        window.__heldNativeMoves = [];
        window.__heldNativeNavigation = [];
        window.__nativeSends = [];
        window.AgentHubCommandTrace.bindReporter(async ({ events }) => window.__dragTrace.push(...events));
        for (const type of ["dragstart", "drop"]) document.addEventListener(type, () => window.__nativeEvents.push(type), true);
        const send = window.__agentHubVscode.postMessage;
        window.__agentHubVscode.postMessage = (message) => {
          if (message.action === "board-task-move") { window.__heldNativeMoves.push(message); return; }
          if (message.action === "open-task") { window.__heldNativeNavigation.push(message); return; }
          if (message.action === "send-message") window.__nativeSends.push(message);
          send(message);
        };
      }, destination);
      const sourceSelector = destination === "board" || destination === "dashboard-composer"
        ? 'section[data-board-destination="backlog"] [data-board-task-id="native-0"]'
        : '[data-workspace-task-list] [data-board-task-id="native-1"]';
      const destinationSelector = destination === "board" ? 'section[data-board-destination="notes"]'
        : destination === "stream" ? '.stream-tab[data-stream-task-id="stream-b"]' : '[data-composer-input]';
      const source = await page.locator(sourceSelector).boundingBox();
      let target = await page.locator(destinationSelector).boundingBox();
      assert.ok(source && (target || destination === "dashboard-composer"), "native source must be visible");
      await page.locator(sourceSelector).evaluate((card) => {
        window.__nativeSource = card;
        card.addEventListener("dragend", () => window.__nativeSourceEnded = true);
      });
      const started = Date.now();
      await page.mouse.move(source.x + 40, source.y + 35);
      await page.mouse.down();
      await page.mouse.move(source.x + 65, source.y + 40, { steps: 5 });
      assert.equal(await page.evaluate(() => window.__nativeEvents.includes("dragstart")), true);
      if (destination === "board") {
        // A background update removes the original source node during a real
        // browser gesture. Its dragend still has to clear the transfer fallback.
        await page.evaluate((value) => {
          value.boardTasks[0].title = "Updated while native drag is active";
          window.AgentHubTaskBoard.setSnapshot(value);
        }, { tasks: initial.boardTasks, boardTasks: initial.boardTasks,
          workspaces: initial.workspaces, boardLayout: initial.boardLayout });
        assert.equal(await page.evaluate(() => window.__nativeSource.isConnected), false);
      }
      if (destination === "dashboard-composer") {
        // Exercise a Dashboard-origin native transfer across a production view
        // switch. The switch is explicit fixture input, not simulated hover UX.
        await page.locator('[data-view-button="chat"]').evaluate(button => button.click());
        target = await page.locator(destinationSelector).boundingBox();
        assert.ok(target, "composer must be visible after switching views");
      }
      await page.mouse.move(target.x + 40, target.y + Math.min(target.height / 2, 80), { steps: 20 });
      await page.mouse.up();
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2_000, `native drag including repaint took ${elapsed} ms`);
      const result = await page.evaluate(async () => {
        for (let count = 0; count < 20 && window.AgentHubCommandTrace.diagnostics().pending; count += 1) {
          await window.AgentHubCommandTrace.flush();
        }
        return {
          events: window.__nativeEvents, ended: window.__nativeSourceEnded,
          active: window.AgentHubTaskReferences.fromTransfer(new DataTransfer()),
          traces: window.__dragTrace.filter(event => event.metadata?.action === "task-drag-start"),
          dropTraces: window.__dragTrace.filter(event => event.stage === "ui-interaction" && event.metadata?.action === "task-drop"),
          sends: window.__nativeSends.length,
          moves: window.__heldNativeMoves.length, navigation: window.__heldNativeNavigation.length,
          references: document.querySelectorAll('[data-attachments] .attachment-task-reference').length,
        };
      });
      assert.equal(result.events.filter(event => event === "dragstart").length, 1);
      assert.equal(result.events.filter(event => event === "drop").length, 1);
      assert.equal(result.ended, true);
      assert.equal(result.active, null);
      assert.deepEqual(result.traces.map(event => event.outcome), ["started", "succeeded"]);
      assert.ok(result.traces[1].monotonicDurationMs < 1_000);
      assert.equal(result.moves, destination === "board" ? 1 : 0);
      assert.equal(result.references, destination === "board" ? 0 : 1);
      assert.equal(result.navigation, destination === "stream" ? 1 : 0);
      assert.equal(result.sends, 0);
      assert.deepEqual(result.dropTraces.map(event => event.outcome), destination === "board" ? [] : ["started", "succeeded"]);
    } finally { await browser.close(); }
  });
}
