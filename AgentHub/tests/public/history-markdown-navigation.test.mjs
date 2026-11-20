import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

test("unfinished Markdown block markers keep stored history and navigation responsive", { timeout: 30_000 }, async () => {
  const initial = snapshot();
  const history = {
    provider: "codex", streamId: "stream-a", threadId: "thread-a",
    start: 0, end: 1, total: 1, messageTotal: 2, nextBefore: null, version: "unfinished-markers",
    items: [{
      id: "marker-turn", completed: true, status: "completed", terminalRevision: 1,
      prompt: "Show the stored answer",
      answer: [
        "Leading text",
        "- ",
        "### ",
        "1. ",
        "+\t",
        "* ",
        "Text after the unfinished markers",
        "",
        "## A real heading",
        "- A real bullet",
        "3. A real ordered item",
        "> A real quotation",
        "",
        "```text",
        "- ",
        "```",
      ].join("\n"),
    }],
  };
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(6000);
    const errors = await openFixture(page, { surface: "web", fixtureSnapshot: initial,
      fixtureHistory: history, initialHash: "#/chat/codex/thread-a" });
    const response = page.locator('[data-chat-pane] [data-role="agent"][data-turn-id="marker-turn"]');
    await response.waitFor();
    const paragraph = (await response.locator("p").first().innerText()).replace(/\s+/gu, " ").trim();
    assert.equal(paragraph, "Leading text - ### 1. + * Text after the unfinished markers");
    assert.deepEqual(await response.locator("h2, ul li, ol li, blockquote").allTextContents(),
      ["A real heading", "A real bullet", "A real ordered item", "A real quotation"]);
    assert.equal(await response.locator("pre code").textContent(), "- ");
    await page.locator('[data-view-button="dashboard"]:visible').first().click();
    await page.waitForFunction(() => document.documentElement.dataset.view === "dashboard");
    await page.locator('[data-view-button="chat"]:visible').first().click();
    await response.waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
