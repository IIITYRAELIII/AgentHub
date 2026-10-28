import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { launchBrowser } from "./composer-production.fixture.mjs";

const require = createRequire(import.meta.url);
const { renderThemeHtml } = require("../../theme-registry.cjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5RkAAAAASUVORK5CYII=", "base64");

for (const encoded of [false, true]) {
  test(`first paint keeps ${encoded ? "encoded" : "direct"} background canonical before deferred app executes`, async () => {
    const registry = { themes: [{
      id: "orbit", name: "Orbit", color: "#000000", aliases: [], assets: [],
      backgrounds: [{ id: "orbit", name: "Orbit", asset: "scene.png", preload: true }],
      styles: ["theme.css"], scripts: [], markup: [],
    }] };
    const html = renderThemeHtml(`<!doctype html><html data-theme="orbit"><head>
      <link rel="stylesheet" href="/shell.css">
      <!-- agent-hub-theme-styles -->
      <!-- agent-hub-theme-catalog -->
      <script src="/app.js" defer></script></head>
      <body><header class="header">Visible shell</header></body></html>`, registry, {
      resourceUrl: (name) => encoded && name.endsWith(".png") ? `${name}.json` : name,
      nonce: "fixture-nonce",
    });
    const browser = await launchBrowser();
    const page = await browser.newPage();
    const requests = [];
    let releaseApp;
    const held = new Promise((resolve) => { releaseApp = resolve; });
    try {
      page.on("request", (request) => requests.push(new URL(request.url()).pathname));
      await page.route("**/*", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
        if (pathname === "/app.js") {
          await held;
          return route.fulfill({ contentType: "text/javascript", body: "window.appExecuted = true;" });
        }
        if (pathname === "/shell.css") return route.fulfill({ contentType: "text/css", body: ".header { background-image: var(--panel-image); min-height: 30px; }" });
        if (pathname === "/themes/orbit/theme.css") return route.fulfill({ contentType: "text/css", body: 'html[data-theme="orbit"] { --panel-image: var(--orbit-image, url("./scene.png")); }' });
        if (pathname === "/themes/orbit/scene.png") return route.fulfill({ contentType: "image/png", body: png });
        return route.fulfill({ status: 404, body: "not found" });
      });
      await page.goto("http://agent-hub.test/", { waitUntil: "commit" });
      await page.locator(".header").waitFor({ state: "visible" });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const observed = await page.evaluate(() => ({
        appExecuted: window.appExecuted === true,
        background: getComputedStyle(document.querySelector(".header")).backgroundImage,
      }));
      assert.equal(observed.appExecuted, false);
      assert.equal(requests.includes("/scene.png"), false, JSON.stringify({ observed, requests }));
      assert.equal(observed.background, encoded ? "none" : 'url("http://agent-hub.test/themes/orbit/scene.png")');
    } finally {
      releaseApp();
      await page.waitForLoadState("domcontentloaded");
      await page.close();
      await browser.close();
    }
  });
}
