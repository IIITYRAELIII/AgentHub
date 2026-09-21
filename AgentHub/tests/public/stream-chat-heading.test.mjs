import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { launchBrowser, openFixture, snapshot, setSelectedTask, applyFixtureSnapshot, bridgeCalls } from "./composer-production.fixture.mjs";

for (const width of [1800, 390]) {
  test(`chat heading follows its Stream and survives rename/rotation at ${width}px`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(5_000);
      const data = snapshot();
      const diagnostics = await openFixture(page, { fixtureSnapshot: data });
      if (width < 860) await page.locator('[data-mobile-button="chat"]').click();
      const name = page.locator("[data-stream-header-name]");
      const workspace = page.locator("[data-stream-header-workspace]");
      assert.equal(await page.title(), "Agent Hub");
      assert.equal(await name.textContent(), "Stream A");
      assert.equal(await name.isVisible(), true);
      assert.equal(await workspace.textContent(), "Workspace");
      await page.locator("[data-composer-input]").fill("Unsent Stream A draft");
      await setSelectedTask(page, "stream-b");
      assert.equal(await name.textContent(), "Stream B");
      await setSelectedTask(page, "stream-a");
      assert.equal(await page.locator("[data-composer-input]").inputValue(), "Unsent Stream A draft");

      const renamed = "ДлинноеИмяПотокаБезПробелов".repeat(4);
      data.version = "renamed-and-rotated";
      data.tasks[0].streamName = renamed;
      data.tasks[0].streamDisplayName = renamed;
      data.tasks[0].threadId = "thread-rotated";
      data.tasks[0].workspaceName = "Another Workspace";
      data.workspaces[0].name = "Another Workspace";
      data.workspaces[0].streams[0].name = renamed;
      data.workspaces[0].streams[0].displayName = renamed;
      data.workspaces[0].streams[0].threads = [{ id: "thread-rotated" }];
      data.selected.threadId = "thread-rotated";
      await applyFixtureSnapshot(page, data);
      await page.waitForFunction((expected) => document.querySelector("[data-stream-header-name]")?.textContent === expected, renamed);
      assert.equal(await workspace.textContent(), "Another Workspace");
      const geometry = await name.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const header = node.closest("header").getBoundingClientRect();
        return { visible: r.width > 0 && r.height > 0, fits: r.left >= 0 && r.right <= innerWidth && r.bottom <= header.bottom,
          unclipped: node.scrollWidth <= node.clientWidth + 1,
          pageFits: document.documentElement.scrollWidth <= innerWidth };
      });
      assert.deepEqual(geometry, { visible: true, fits: true, unclipped: true, pageFits: true });
      assert.equal((await bridgeCalls(page, "send-message")).length, 0);
      assert.deepEqual(diagnostics, []);
      if (process.env.AGENT_HUB_QA_DIR) {
        await mkdir(process.env.AGENT_HUB_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_QA_DIR, `heading-${width}.png`) });
      }
    } finally { await browser.close(); }
  });
}
