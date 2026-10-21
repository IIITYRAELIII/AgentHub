import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { serverConfigurationEntries } from "../../src/interfaces/web/server-configuration.mjs";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

// Browser plugin not available: the existing isolated Edge/Playwright fixture.
test("sync server field edits, cancels and saves through the existing configuration event", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [], consoleErrors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
      await openFixture(page);
      if (await page.locator("html").evaluate(root => root.hasAttribute("data-mobile-dialogs-enabled"))) {
        await page.locator('[data-mobile-dialogs-tab="more"]').click();
        await page.locator("[data-mobile-more-sheet]").getByRole("button", { name: "Сервер", exact: true }).click();
      } else await page.locator(width < 600 ? '[data-mobile-button="server"]' : '[data-view-button="server"]').click();
      const configuration = serverConfigurationEntries({ usageSyncServerUrl: "https://old.example.invalid/sync" });
      await page.evaluate(configuration => {
        window.__syncSettings = [];
        document.addEventListener("agenthub:intent", event => {
          if (event.detail.type === "server:config-update") window.__syncSettings.push(event.detail.changes);
        });
        window.AgentHub.setServerStatus({ process: { status: "running", version: "fixture" }, configuration });
      }, configuration);
      assert.equal(page.url(), "http://agent-hub.test/");
      assert.ok((await page.title()).length > 0);
      const field = page.getByRole("textbox", { name: "Сервер синхронизации", exact: true });
      await field.waitFor({ state: "visible" });
      assert.equal(await field.inputValue(), "https://old.example.invalid/sync");
      await field.fill("https://new.example.invalid/sync");
      await page.locator("[data-server-config-discard]").click();
      assert.equal(await field.inputValue(), "https://old.example.invalid/sync");
      await field.fill("https://new.example.invalid/sync");
      const bounds = await field.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      assert.ok((await page.locator("[data-server-config]").innerText()).includes("Сервер синхронизации"));
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, []);
      if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) {
        await mkdir(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, `sync-setting-${width}.png`) });
      }
      await page.locator("[data-server-config-save]").click();
      assert.deepEqual(await page.evaluate(() => window.__syncSettings), [{ usageSyncServerUrl: "https://new.example.invalid/sync" }]);
      await page.close();
    }
  } finally { await browser.close(); }
});
