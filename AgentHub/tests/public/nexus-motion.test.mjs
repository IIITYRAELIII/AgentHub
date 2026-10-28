import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { launchBrowser } from "./composer-production.fixture.mjs";

test("Nexus light follows panel geometry and retires with motion, visibility or theme", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: "no-preference" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://nexus.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    await page.goto("http://nexus.test/");
    await page.setContent(`<html data-theme="nexus" data-view="chat" data-surface="desktop"><head><style>
      body { margin: 0; } .app-header { height: 60px; position: relative; }
      main { display: flex; gap: 12px; } main > section { height: 600px; }
      .task-rail { width: 250px; } .chat { flex: 1; } .activity-rail { width: 250px; }
    </style></head><body><header class="app-header"></header><main>
      <section class="task-rail"></section><section class="chat"></section><section class="activity-rail"></section>
    </main></body></html>`);
    const assets = new URL("../../assets/web-app/", import.meta.url);
    await page.addStyleTag({ content: await readFile(new URL("themes/nexus/theme.css", assets), "utf8") });
    await page.addScriptTag({ content: await readFile(new URL("background-motion-preference.js", assets), "utf8") });
    await page.addScriptTag({ content: await readFile(new URL("themes/nexus/motion.js", assets), "utf8") });
    const count = n => page.waitForFunction(n => document.querySelectorAll(".nexus-contour-light").length === n, n);
    await count(4);
    const firstTransform = await page.locator(".nexus-contour-light > span").first().evaluate(n => getComputedStyle(n).transform);
    await page.waitForFunction(previous => getComputedStyle(document.querySelector(".nexus-contour-light > span")).transform !== previous, firstTransform);
    await page.evaluate(() => document.querySelector(".task-rail").style.width = "380px");
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.waitForFunction(() => [...document.querySelectorAll(".nexus-contour-light")].every(n => {
      const style = getComputedStyle(n), box = n.getBoundingClientRect();
      return Math.abs(box.left - parseFloat(style.getPropertyValue("--nexus-left"))) < 1
        && Math.abs(box.top - parseFloat(style.getPropertyValue("--nexus-top"))) < 1;
    }));
    assert.ok(await page.locator(".nexus-contour-light").evaluateAll(nodes => nodes.every(n => getComputedStyle(n).pointerEvents === "none" && n.getAttribute("aria-hidden") === "true")));
    await page.evaluate(() => document.documentElement.dataset.backgroundMotion = "off");
    await count(0);
    await page.evaluate(() => document.documentElement.dataset.backgroundMotion = "on");
    await count(4);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await count(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await count(4);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await count(0);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
      document.documentElement.dataset.view = "dashboard";
    });
    await count(2);
    assert.equal(await page.locator("body > .nexus-contour-light").count(), 1);
    await page.evaluate(() => document.documentElement.dataset.theme = "orbit");
    await count(0);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
