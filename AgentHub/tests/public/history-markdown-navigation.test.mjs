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

test("stored Markdown links render escaped quotes and recover after a malformed title", { timeout: 30_000 }, async () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const taskUrl = "agent-hub://task/" + taskId;
  const quotedLink = '[Task](' + taskUrl + ' "Ускорить снятие \\"Ответ готов\\"")';
  const malformed = '[Broken](' + taskUrl + ' "' + '\\"'.repeat(32_768) + ')';
  const history = {
    provider: "codex", streamId: "stream-a", threadId: "thread-a",
    start: 0, end: 1, total: 1, messageTotal: 2, nextBefore: null, version: "escaped-link-title",
    items: [{
      id: "link-turn", completed: true, status: "completed", terminalRevision: 1,
      prompt: "Show the stored links",
      answer: [
        quotedLink + ' [Plain](https://example.com/ "Plain title")',
        "[File](<D:/Synthetic/report (1).xlsx>)",
        malformed + " [Next](https://example.com/next)",
      ].join("\n"),
    }],
  };
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(6000);
    await page.addInitScript(() => {
      document.addEventListener("agenthub:task-reference-open", (event) => {
        window.__openedTaskReference = event.detail.taskId;
      });
    });
    const errors = await openFixture(page, { surface: "web", fixtureHistory: history,
      initialHash: "#/chat/codex/thread-a" });
    const response = page.locator('[data-chat-pane] [data-role="agent"][data-turn-id="link-turn"]');
    const link = response.getByRole("link", { name: "Task", exact: true });
    assert.equal(await link.getAttribute("href"), taskUrl);
    assert.equal(await link.getAttribute("title"), 'Ускорить снятие "Ответ готов"');
    assert.equal(await response.getByRole("link", { name: "Plain" }).getAttribute("title"), "Plain title");
    assert.equal(await response.getByRole("link", { name: "File" }).getAttribute("data-agent-hub-local-link"),
      "D:/Synthetic/report (1).xlsx");
    assert.equal(await response.getByRole("link", { name: "Broken" }).count(), 0);
    assert.ok((await response.textContent()).includes(malformed));
    assert.equal(await response.getByRole("link", { name: "Next" }).getAttribute("href"), "https://example.com/next");
    await link.click();
    assert.equal(await page.evaluate(() => window.__openedTaskReference), taskId);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
