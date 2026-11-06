import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchBrowser } from "./composer-production.fixture.mjs";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";

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

test("HTTP first paint authorizes only its generated background style before deferred app executes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-first-paint-http-"));
  const theme = path.join(root, "themes", "orbit");
  await mkdir(theme, { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "index.html"), `<!doctype html><html data-theme="orbit"><head>
      <link rel="stylesheet" href="/shell.css">
      <!-- agent-hub-theme-styles -->
      <!-- agent-hub-theme-catalog -->
      <script src="/app.js" defer></script></head>
      <body><header class="header">Visible shell</header></body></html>`),
    writeFile(path.join(root, "shell.css"), ".header { background-image: var(--panel-image); min-height: 30px; }"),
    writeFile(path.join(root, "app.js"), "window.appExecuted = true;"),
    writeFile(path.join(theme, "theme.json"), JSON.stringify({
      id: "orbit", name: "Orbit", color: "#000000", order: 1,
      styles: "theme.css", backgrounds: [{ id: "orbit", name: "Orbit", asset: "scene.png" }],
    })),
    writeFile(path.join(theme, "theme.css"), 'html[data-theme="orbit"] { --panel-image: var(--orbit-image, url("./scene.png")); }'),
    writeFile(path.join(theme, "scene.png"), png),
  ]);
  const server = new MiniAppServer({ port: 0, assetsDirectory: root,
    journalDatabase: { subscribe: () => () => {} }, telegramRuntime: false });
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [], requests = [];
  let releaseApp;
  const held = new Promise((resolve) => { releaseApp = resolve; });
  try {
    const { url } = await server.start();
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.route("**/app.js", async (route) => { await held; return route.continue(); });
    await page.goto(url, { waitUntil: "commit" });
    await page.locator(".header").waitFor({ state: "visible" });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const observed = await page.evaluate(() => ({
      appExecuted: window.appExecuted === true,
      background: getComputedStyle(document.querySelector(".header")).backgroundImage,
      nonce: document.querySelector("[data-agent-hub-backgrounds]").nonce,
    }));
    assert.equal(observed.appExecuted, false);
    assert.deepEqual(errors, []);
    assert.equal(requests.includes("/scene.png"), false);
    assert.equal(observed.background, `url("${url}themes/orbit/scene.png")`);
    const second = await fetch(url);
    assert.equal((await second.text()).includes(`nonce="${observed.nonce}"`), false);
    const violation = await page.evaluate(() => new Promise((resolve) => {
      document.addEventListener("securitypolicyviolation", (event) => resolve(event.violatedDirective), { once: true });
      const style = document.createElement("style");
      style.textContent = ".header { --unapproved-style: applied; }";
      document.head.append(style);
    }));
    assert.match(violation, /^style-src/u);
    assert.equal(await page.locator(".header").evaluate((element) => getComputedStyle(element).getPropertyValue("--unapproved-style")), "");
  } finally {
    releaseApp();
    await page.waitForLoadState("domcontentloaded");
    await page.close();
    await browser.close();
    await server.close();
    const relative = path.relative(os.tmpdir(), root);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
});
