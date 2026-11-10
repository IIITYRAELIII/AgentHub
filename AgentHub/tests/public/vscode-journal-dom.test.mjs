import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { launchBrowser } from "./composer-production.fixture.mjs";
const require = createRequire(import.meta.url);
const { webviewHtml } = require("../../VSCodeExtension/webview.js");
const themes = [{ id: "orbit", name: "Orbit" }, { id: "gothic", name: "Gothic" }];

test("complete VS Code journal preserves theme, exact disclosure state, heading and embedded controls", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__vscodeMessages = [];
      window.acquireVsCodeApi = () => ({
        getState: () => JSON.parse(localStorage.getItem("fixture:vscode-state") ?? "null"),
        setState: state => localStorage.setItem("fixture:vscode-state", JSON.stringify(state)),
        postMessage: message => window.__vscodeMessages.push(message),
      });
    });
    await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: webviewHtml({}, "gothic", themes) }));
    await page.goto("http://vscode-journal.test/");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "gothic");
    const html = '<h1>Original title</h1><div data-work-log-rate-limits data-sampled-at="2026-09-11T10:00:00Z"><span>Limit 50%</span></div>'
      + '<div data-work-log-row data-work-log-thread-id="thread-one"><details data-work-log-previous-turns open><summary>Older turns</summary>'
      + '<button data-work-log-collapse-turns>Close older</button><p>Old turn</p></details></div>'
      + '<details data-work-log-turn-id="exact-turn" open><summary>Exact turn</summary><p>Journal body</p></details>';
    const render = async title => {
      await page.evaluate(value => window.postMessage({ type: "render", ...value }, "*"), { html, css: "", title });
      await page.waitForFunction(expected => document.querySelector("[data-work-log-panel-title]")?.textContent === expected, title);
    };
    await render("Synthetic journal path");
    assert.equal(await page.locator("h1 .rate-limits").textContent(), "Limit 50%");
    assert.equal(await page.locator("[data-work-log-rate-limits]").count(), 0);
    assert.equal(await page.locator("[data-theme-select] option").count(), themes.length);
    await page.locator("[data-theme-select]").selectOption("orbit");
    assert.deepEqual(await page.evaluate(() => window.__vscodeMessages.at(-1)), { type: "theme", theme: "orbit" });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:vscode-state")).theme), "orbit");
    await page.evaluate(() => window.postMessage({ type: "theme", theme: "gothic" }, "*"));
    await page.waitForFunction(() => document.documentElement.dataset.theme === "gothic");
    assert.equal(await page.evaluate(() => window.__vscodeMessages.length), 1, "incoming theme is not echoed back");
    await page.locator("[data-work-log-collapse-turns]").click();
    assert.equal(await page.locator("[data-work-log-previous-turns]").evaluate(node => node.open), false);
    assert.equal(await page.locator("[data-work-log-turn-id]").evaluate(node => node.open), true);
    await render("Refreshed journal path");
    assert.equal(await page.locator("[data-work-log-previous-turns]").evaluate(node => node.open), false);
    assert.equal(await page.locator("[data-work-log-turn-id]").evaluate(node => node.open), true);
    await page.locator("[data-collapse-all]").click();
    assert.equal(await page.locator("details[open]").count(), 0);
    await page.reload();
    await render("Reopened journal path");
    assert.equal(await page.locator("details[open]").count(), 0, "explicit empty disclosure set survives recreation");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
