import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

const assets = new URL("../../assets/web-app/", import.meta.url);
const require = createRequire(import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = require("../../theme-registry.cjs");

test("packaged dialog stylesheet follows every shipped theme stylesheet", async () => {
  const registry = loadThemeRegistry(fileURLToPath(assets));
  const html = renderThemeHtml(await readFile(new URL("index.html", assets), "utf8"), registry);
  const links = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gu)].map((match) => match[1]);
  const dialogIndex = links.indexOf("/dialog-area.css");
  assert.ok(dialogIndex >= 0, "dialog stylesheet must be packaged");
  assert.ok(registry.themes.length > 0);
  for (const theme of registry.themes) {
    for (const file of theme.styles) {
      const url = `/themes/${theme.id}/${file}`;
      const index = links.indexOf(url);
      assert.ok(index >= 0 && index < dialogIndex, `${url} must be loaded before dialog styles`);
    }
  }
});

// Static architecture exception: a rendered color cannot prove that every
// shared rule derives its color from a theme token, across inactive selectors.
test("shared dialog stylesheet derives its palette from semantic theme tokens", async () => {
  const styles = await readFile(new URL("dialog-area.css", assets), "utf8");
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(styles, /\brgba?\(\s*\d/iu);
  assert.match(styles, /--dialog-canvas: var\(--bg\)/u);
  assert.match(styles, /--dialog-agent-2: hsl\(from var\(--accent\) calc\(h \+ 120\) s l\)/u);
});

// Theme-package token values are retained here; shared layout geometry is not
// frozen. Theme contrast remains covered by orange-theme.test.mjs.
test("Orange defines the reference dialog palette only as theme tokens", async () => {
  const orange = await readFile(new URL("themes/orange/theme.css", assets), "utf8");
  const expected = new Map([
    ["canvas", "#f7f4ee"],
    ["chrome", "#efeae1"],
    ["raised", "#fdfbf7"],
    ["sunken", "#f2ece2"],
    ["bubble-user", "#efe7db"],
    ["code-bg", "#eee7dc"],
    ["hairline", "#e3dace"],
    ["text", "#2b2723"],
    ["text-2", "#56504a"],
    ["text-3", "#8a8075"],
    ["text-4", "#a49a8d"],
    ["accent", "#c2643a"],
    ["accent-press", "#a8542a"],
    ["danger", "#b8493c"],
    ["agent-1", "#c2643a"],
    ["agent-2", "#8a5fa8"],
    ["agent-3", "#3f8a7d"],
    ["neutral-bar", "#b9ac97"],
  ]);
  for (const [name, value] of expected) {
    assert.ok(orange.includes(`--dialog-${name}: ${value};`));
  }
});

test("context details open nonmodally and close without blocking the composer", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      const fixtureSnapshot = snapshot();
      fixtureSnapshot.tasks[0].context = { usedTokens: 500, modelContextWindow: 1000, percent: 50 };
      const diagnostics = await openFixture(page, { fixtureSnapshot });
      assert.equal(page.url(), "http://agent-hub.test/");
      assert.equal(await page.title(), "Agent Hub");
      const button = page.locator("[data-context-usage]:visible");
      const details = page.locator("[data-context-usage-modal]");
      await button.click();
      assert.equal(await details.evaluate((node) => node.open), true);
      assert.equal(await details.evaluate((node) => node.matches(":modal")), false);
      assert.equal(await button.getAttribute("aria-expanded"), "true");
      if (process.env.AGENT_HUB_QA_SCREENSHOT) await page.screenshot({
        path: process.env.AGENT_HUB_QA_SCREENSHOT, fullPage: false,
      });
      await page.locator("[data-composer-input]").fill("Unsent draft");
      assert.equal(await page.locator("[data-composer-input]").inputValue(), "Unsent draft");
      await details.locator('[data-action="context-usage-close"]').first().click();
      assert.equal(await details.evaluate((node) => node.open), false);
      assert.equal(await button.getAttribute("aria-expanded"), "false");
      await button.click();
      assert.equal(await details.evaluate((node) => node.open), true);
      await button.click();
      assert.equal(await details.evaluate((node) => node.open), false);
      assert.deepEqual(diagnostics, []);
    } finally { await context.close(); }
  } finally { await browser.close(); }
});
