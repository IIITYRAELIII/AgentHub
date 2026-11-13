import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

const SOURCE = "Before\n\n7. Alpha **bold**\n8. Beta end\n9. Gamma\n\nAfter";

async function withMessage(run) {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const errors = await openFixture(page);
    await page.evaluate((source) => {
      window.AgentHub.setMessages("stream-a", [{ id: "copy-list", role: "agent", text: source }]);
      const target = document.createElement("textarea");
      target.id = "paste-target";
      target.setAttribute("aria-label", "Plain text paste target");
      target.style.cssText = "position:fixed;top:0;right:0;width:180px;height:50px;z-index:99999";
      document.body.append(target);
      window.__copies = [];
      document.addEventListener("copy", (event) => window.__copies.push({
        trusted: event.isTrusted, handled: event.defaultPrevented,
      }));
    }, SOURCE);
    const body = page.locator('[data-message-id="copy-list"] .msg-body');
    await body.waitFor({ state: "visible" });
    await run(page, body);
    assert.deepEqual(errors, []);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await browser.close();
  }
}

async function paste(page) {
  const target = page.locator("#paste-target");
  await target.fill("");
  await target.focus();
  await page.keyboard.press("Control+V");
  return target.inputValue();
}

async function copyRange(page, body, options = {}) {
  await body.click({ position: { x: 5, y: 5 } });
  await body.evaluate((node, { start = null, end = null } = {}) => {
    const range = document.createRange();
    if (start === null) range.selectNodeContents(node);
    else {
      const items = node.querySelectorAll("li");
      range.setStart(items[start.item].firstChild, start.offset);
      range.setEnd(items[end.item].firstChild, end.offset);
    }
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, options);
  await page.keyboard.press("Control+C");
  assert.equal((await page.evaluate(() => window.__copies)).at(-1).trusted, true);
  return paste(page);
}

test("real browser Ctrl+C and paste retains visible ordered-list numbers", async () => {
  await withMessage(async (page, body) => {
    const value = await copyRange(page, body);
    assert.match(value, /7\. Alpha bold\r?\n8\. Beta end\r?\n9\. Gamma/u);
    assert.ok(value.startsWith("Before"));
    assert.ok(value.endsWith("After"));
    assert.equal(page.url(), "http://agent-hub.test/");
    assert.ok((await page.title()).includes("Agent Hub"));
    if (process.env.AGENT_HUB_COPY_QA_SCREENSHOT) {
      await page.locator("#paste-target").evaluate((node) => {
        node.style.width = "300px"; node.style.height = "200px";
      });
      await page.screenshot({ path: process.env.AGENT_HUB_COPY_QA_SCREENSHOT });
    }
    console.log(`Edge clipboard QA: ${page.context().browser().version()}, viewport 1280x900`);
  });
});

test("partial list selection retains source ordinal and only selected text", async () => {
  await withMessage(async (page, body) => {
    assert.equal(await copyRange(page, body, {
      start: { item: 1, offset: 2 }, end: { item: 2, offset: 3 },
    }), "8. ta end\n9. Gam");
    assert.equal(await copyRange(page, body, {
      start: { item: 1, offset: 0 }, end: { item: 2, offset: 0 },
    }), "8. Beta end");
  });
});

test("one partial item, nested ordinals, explicit values and line breaks survive Ctrl+C", async () => {
  await withMessage(async (page, body) => {
    assert.equal(await copyRange(page, body, {
      start: { item: 1, offset: 1 }, end: { item: 1, offset: 4 },
    }), "8. eta");
    // The clipboard owner handles semantic list DOM, independently of how a
    // Markdown producer supplies nested items. No new renderer syntax is added.
    await body.evaluate((node) => {
      node.innerHTML = '<ol start="4"><li>Parent<br>continued<ol start="12"><li>Child A</li>'
        + '<li value="20">Child B</li></ol></li><li>Sibling</li></ol>';
    });
    assert.equal(await copyRange(page, body),
      "4. Parent\ncontinued\n  12. Child A\n  20. Child B\n5. Sibling");
    await body.evaluate((node) => {
      node.innerHTML = '<ol reversed start="5"><li>Five</li><li value="2">Two</li><li>One</li></ol>';
    });
    assert.equal(await copyRange(page, body), "5. Five\n2. Two\n1. One");
  });
});

test("message menu copies the same numbered selection and whole-message action keeps Markdown", async () => {
  await withMessage(async (page, body) => {
    await page.evaluate(() => {
      window.__requests = [];
      window.AgentHub.on("clipboard:write", (request) => window.__requests.push(request.text));
    });
    await copyRange(page, body, { start: { item: 1, offset: 0 }, end: { item: 2, offset: 5 } });
    await body.evaluate((node) => {
      const items = node.querySelectorAll("li");
      const range = document.createRange();
      range.setStart(items[1].firstChild, 0);
      range.setEnd(items[2].firstChild, 5);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    assert.equal(await page.evaluate(() => getSelection().toString()), "Beta end\nGamma");
    await body.dispatchEvent("contextmenu", { button: 2, clientX: 400, clientY: 300 });
    // The open menu owns the captured selection even if live DOM changes.
    await body.locator("li").nth(1).evaluate((node) => { node.textContent = "Changed later"; });
    await page.locator('[data-annotation-context-menu] [data-action="copy-selection"]').click();
    assert.equal((await page.evaluate(() => window.__requests)).at(-1), "8. Beta end\n9. Gamma");
    await body.hover();
    await page.locator('.msg-stack:has([data-message-id="copy-list"]) [data-message-copy]').click({ timeout: 5_000 });
    assert.equal((await page.evaluate(() => window.__requests)).at(-1), SOURCE);
    assert.equal(await body.locator("ol").getAttribute("start"), "7");
    assert.equal(await body.locator("li").first().getAttribute("value"), null);
  });
});

test("plain message text, composer selection and non-message lists keep native clipboard behavior", async () => {
  await withMessage(async (page, body) => {
    await body.evaluate((node) => { node.textContent = "plain unchanged"; });
    assert.equal(await copyRange(page, body), "plain unchanged");
    assert.equal((await page.evaluate(() => window.__copies)).at(-1).handled, false);
    const composer = page.locator("[data-composer-input]");
    await composer.fill("editable unchanged");
    await composer.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+C");
    assert.equal(await paste(page), "editable unchanged");
    assert.equal((await page.evaluate(() => window.__copies)).at(-1).handled, false);
    await page.evaluate(() => {
      document.activeElement.blur();
      const list = document.createElement("ol");
      list.innerHTML = "<li>Outside</li>";
      document.body.append(list);
      const range = document.createRange();
      range.selectNodeContents(list);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.keyboard.press("Control+C");
    assert.equal((await page.evaluate(() => window.__copies)).at(-1).handled, false);
    assert.equal((await paste(page)).trim(), "Outside");
  });
});
