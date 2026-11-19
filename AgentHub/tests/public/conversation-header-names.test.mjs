import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

for (const width of [1366, 390]) {
  test(`conversation header keeps names and separator without a Workspace prefix (${width})`, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(5_000);
      const data = snapshot();
      data.workspaces[0].name = "The Last Terra";
      Object.assign(data.workspaces[0].streams[0], { name: "Сборщик", displayName: "Сборщик" });
      Object.assign(data.tasks[0], { workspaceName: "The Last Terra", streamName: "Сборщик", streamDisplayName: "Сборщик" });
      const errors = await openFixture(page, { fixtureSnapshot: data, surface: "web", followSelection: true });
      if (width >= 860) await page.evaluate(() => AgentHub.showSelectedTask());
      const header = page.locator(width >= 860 ? ".stream-chat-identity:visible" : ".mobile-conversation-breadcrumb:visible");
      const expected = "The Last Terra / Сборщик";
      assert.equal((await header.innerText()).replace(/\s+/gu, " ").trim(), expected);
      assert.equal(new URL(page.url()).hostname, "agent-hub.test");
      assert.ok((await page.title()).length > 0);
      assert.ok((await page.locator("body").innerText()).length > 100);
      await page.locator("[data-dialog-settings-toggle]").click();
      assert.equal(await page.locator("[data-dialog-settings]").isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("[data-dialog-settings]").isVisible(), false);
      assert.equal((await header.innerText()).replace(/\s+/gu, " ").trim(), expected);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      if (process.env.AGENT_HUB_TEST_SCREENSHOTS) {
        await mkdir(process.env.AGENT_HUB_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_TEST_SCREENSHOTS, `conversation-header-${width}.png`) });
      }
    } finally { await browser.close(); }
  });
}
