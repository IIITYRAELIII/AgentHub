import assert from "node:assert/strict";
import test from "node:test";
import { bridgeCalls, launchBrowser, openFixture, submit } from "./composer-production.fixture.mjs";

for (const length of [401, 430, 12_000]) {
  test(`production quote retains ${length} characters through selection, reload and send`, {
    timeout: 60_000,
  }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const diagnostics = await openFixture(page);
      const quote = "Полная цитата с эмодзи 🛰️. ".repeat(length).slice(0, length - 1) + "!";
      const added = await page.evaluate(async (text) => {
        window.AgentHub.setMessages("stream-a", [{
          id: "quote-source", itemId: "source-item", turnId: "source-turn",
          role: "assistant", provider: "codex", threadId: "thread-a",
          text: `Начало: **${text}** Конец.`, time: "2026-09-04T08:00:00.000Z",
        }]);
        const surface = document.querySelector('[data-message-id="quote-source"] .msg-body strong');
        const range = document.createRange();
        range.selectNodeContents(surface);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return window.AgentHub.addSelectedAnnotation();
      }, quote);
      assert.equal(added, true);
      await page.waitForFunction((expected) => {
        const drafts = JSON.parse(localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "{}");
        return JSON.stringify(drafts).includes(expected);
      }, quote);
      await page.reload();
      await page.locator("[data-annotations] .annotation").waitFor({ state: "visible" });
      assert.ok((await page.locator("[data-annotations] .annotation").textContent()).includes(quote));
      if (length === 12_000) {
        const preview = page.locator("[data-annotations] .annotation-quote");
        await preview.focus();
        await page.keyboard.press("End");
        await page.waitForFunction(() => document.querySelector(".annotation-quote").scrollTop > 0);
        const geometry = await page.locator("[data-annotation-comment-index]").evaluate((node) => ({
          top: node.getBoundingClientRect().top,
          bottom: node.getBoundingClientRect().bottom,
          viewport: window.innerHeight,
        }));
        assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.viewport);
      }
      await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
      await submit(page, { text: "Проверить цитату" });
      const params = (await bridgeCalls(page, "send-message")).at(-1).params;
      const annotation = params.responseAnnotations[0];
      assert.equal(annotation.text, quote);
      assert.equal(annotation.source.end - annotation.source.start, length);
      assert.equal(annotation.source.itemId, "source-item");
      assert.ok(params.text.includes(quote));
      assert.deepEqual(diagnostics, []);
    } finally {
      await browser.close();
    }
  });
}
