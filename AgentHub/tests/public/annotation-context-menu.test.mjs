import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture, selectMessageText } from "./composer-production.fixture.mjs";

test("annotation menu escapes clipped themes and stays inside the chat edge", async () => {
  const browser = await launchBrowser();
  try {
    for (const width of [1366, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const diagnostics = await openFixture(page);
      if (width < 960) await page.locator('[data-mobile-button="chat"]').click();
      await selectMessageText(page);
      const body = page.locator('.msg-body').filter({ hasText: "Alpha source text" });
      const chat = page.locator('[data-chat]');
      if (width > 960) await chat.evaluate((element) => { element.style.width = "520px"; });
      const box = await chat.boundingBox();
      if (width > 960) assert.ok(box.x + box.width < width - 100, "fixture must distinguish chat and viewport edges");
      await body.evaluate((element, bounds) => {
        // A clipped themed parent must not clip a floating menu.
        element.closest('[data-chat]').style.overflow = "hidden";
        element.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, clientX: bounds.x + bounds.width - 1, clientY: 895,
        }));
      }, box);
      const menu = page.locator('[data-annotation-context-menu]');
      await menu.waitFor({ state: "visible" });
      const rect = await menu.boundingBox();
      assert.ok(rect.x >= box.x - 1 && rect.x + rect.width <= box.x + box.width + 1);
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
      assert.ok(rect.y >= 0 && rect.y + rect.height <= 900);
      assert.equal(await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + 5, rect.y + 5));
      }), true, "menu must be hit-testable outside the clipped theme");
      await menu.locator('[data-action="annotate-selection"]').click();
      await page.locator('[data-annotation-comment-index="0"]').waitFor({ state: "visible" });
      assert.equal(await menu.isVisible(), false);
      assert.deepEqual(diagnostics, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
