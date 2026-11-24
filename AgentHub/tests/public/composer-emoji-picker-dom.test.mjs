import assert from "node:assert/strict";
import test from "node:test";
import { bridgeCalls, launchBrowser, openFixture } from "./composer-production.fixture.mjs";

for (const viewport of [{ width: 1366, height: 850 }, { width: 360, height: 740 }]) {
  test(`composer inserts emoji into the draft without sending at ${viewport.width}px`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const mobile = viewport.width === 360;
      const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
      const diagnostics = await openFixture(page, { surface: mobile ? "web" : "vscode" });
      if (mobile) {
        await page.evaluate(() => window.AgentHub.showSelectedTask());
        assert.equal(await page.locator("html").getAttribute("data-mobile-dialogs-enabled"), "");
      }
      assert.match(await page.title(), /Agent Hub/u);
      assert.match(page.url(), /agent-hub\.test/u);
      const input = page.getByRole("textbox", { name: "Сообщение агенту" });
      const toggle = page.getByRole("button", { name: "Вставить смайлик" });
      const picker = page.getByRole("region", { name: "Смайлики" });

      await input.fill("до слово после");
      await input.evaluate((element) => element.setSelectionRange(3, 8));
      await toggle.click();
      await picker.waitFor();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      await picker.getByRole("button", { name: "Символы" }).click();
      const bounds = await picker.boundingBox();
      const toggleBounds = await toggle.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height < toggleBounds.y);
      if (process.env.AGENT_HUB_EMOJI_SCREENSHOT) {
        await page.screenshot({ path: `${process.env.AGENT_HUB_EMOJI_SCREENSHOT}-${viewport.width}.png` });
      }
      await picker.getByRole("button", { name: "Красное сердце" }).click();
      assert.equal(await input.inputValue(), "до ❤️ после");
      assert.deepEqual(await input.evaluate((element) => [
        element === document.activeElement, element.selectionStart, element.selectionEnd,
      ]), [true, "до ❤️".length, "до ❤️".length]);
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");

      await toggle.focus();
      await page.keyboard.press("Enter");
      await picker.getByRole("button", { name: "Жесты" }).press("Enter");
      await picker.getByRole("button", { name: "Большой палец вверх" }).press("Enter");
      assert.equal(await input.inputValue(), "до ❤️👍 после");

      await toggle.click();
      await page.keyboard.press("Escape");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(await toggle.evaluate((element) => element === document.activeElement), true);
      await toggle.click();
      await input.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      if (mobile) {
        await toggle.click();
        await page.evaluate(() => history.back());
        await picker.waitFor({ state: "hidden" });
        assert.equal(await input.isVisible(), true);
      }
      assert.deepEqual(await bridgeCalls(page, "send-message"), []);

      await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
      await page.locator("[data-composer-send]").click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
        .some(({ action }) => action === "send-message"));
      const sends = await bridgeCalls(page, "send-message");
      assert.equal(sends.length, 1);
      assert.equal(sends[0].params.text, "до ❤️👍 после");
      assert.deepEqual(diagnostics, []);
    } finally {
      await browser.close();
    }
  });
}
