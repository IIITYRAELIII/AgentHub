import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture, snapshot, bridgeCalls, applyFixtureSnapshot } from "./composer-production.fixture.mjs";

test("dashboard waits for the new runtime instead of calling the broken legacy move", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const old = snapshot();
    delete old.boardLayout;
    const diagnostics = await openFixture(page, { fixtureSnapshot: old });
    const action = (detail) => page.evaluate((value) => document.dispatchEvent(
      new CustomEvent("agenthub:board-action", { detail: value }),
    ), detail);
    for (const detail of [
      { type: "move-column", columnId: "workspace:workspace-1", beforeColumnId: null },
      { type: "update-comment", columnId: "workspace:workspace-1", comment: "new comment" },
    ]) {
      await action(detail);
      await page.waitForFunction(() => window.__toastHistory.some((value) => value.includes("обновление runtime")));
    }
    assert.deepEqual(await bridgeCalls(page, "board-column-move"), []);
    assert.deepEqual(await bridgeCalls(page, "board-column-comment"), []);
    assert.deepEqual(await bridgeCalls(page, "board-workspace-move"), []);
    const current = snapshot();
    current.version = "current-board-runtime";
    await applyFixtureSnapshot(page, current);
    await action({ type: "move-column", columnId: "workspace:workspace-1", beforeColumnId: null });
    await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => entry.action === "board-column-move"));
    const calls = await bridgeCalls(page, "board-column-move");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.columnId, "workspace:workspace-1");
    assert.equal(calls[0].params.beforeColumnId, null);
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});
