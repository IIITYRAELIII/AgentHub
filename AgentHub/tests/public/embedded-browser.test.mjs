import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const CONTROLLER_URL = new URL("../../assets/web-app/embedded-browser.js", import.meta.url);
const TRUST_URL = new URL("../../assets/web-app/host-message-trust.js", import.meta.url);
const INDEX_URL = new URL("../../assets/web-app/index.html", import.meta.url);
const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);

const TEST_THEME_CATALOG = JSON.stringify([{
  id: "orbit",
  name: "Orbit",
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);

async function embeddedBrowserApi() {
  const window = {};
  const document = { querySelector: () => null };
  const context = { document, URL, window };
  vm.runInNewContext(await readFile(TRUST_URL, "utf8"), context);
  vm.runInNewContext(await readFile(CONTROLLER_URL, "utf8"), context);
  return window.AgentHubEmbeddedBrowser;
}

function webAssetContentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

async function openProductionApp(page) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname === "public.example.dev") {
      await route.fulfill({ contentType: "text/html", body: "<h1>Remote page</h1>" });
      return;
    }
    if (requestUrl.hostname !== "agent-hub.test") {
      await route.abort();
      return;
    }
    if (requestUrl.pathname === "/") {
      const source = await readFile(INDEX_URL, "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      return;
    }
    if (requestUrl.pathname === "/work-log.css") {
      await route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
      return;
    }
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: webAssetContentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("https://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
}

test("embedded browser accepts only bounded public HTTPS hostnames", async () => {
  const { MAX_URL_LENGTH, normalizeEmbeddedBrowserUrl } = await embeddedBrowserApi();
  assert.equal(normalizeEmbeddedBrowserUrl("public.example.dev/docs", {
    pageUrl: "https://hub.agenthub.dev/",
  }).url, "https://public.example.dev/docs");
  assert.equal(normalizeEmbeddedBrowserUrl("https://badexample.com:443/a", {
    pageUrl: "https://hub.agenthub.dev/",
  }).url, "https://badexample.com/a");
  assert.equal(normalizeEmbeddedBrowserUrl("https://пример.рф/справка", {
    pageUrl: "https://hub.agenthub.dev/",
  }).ok, true);

  for (const address of [
    "http://example.com",
    "https://localhost",
    "https://service.local/path",
    "https://SERVICE.ONION./path",
    "https://service.alt/path",
    "https://router.home.arpa",
    "https://example.com",
    "https://docs.example.net/path",
    "https://EXAMPLE.ORG./path",
    "https://example。com/path",
    "https://127.0.0.1",
    "https://[::1]",
    "https://user:secret@example.com",
    "https://hub.agenthub.dev/",
    "https://HUB.AGENTHUB.DEV./",
    `https://${"a".repeat(MAX_URL_LENGTH)}.com`,
  ]) {
    assert.equal(normalizeEmbeddedBrowserUrl(address, {
      pageUrl: "https://hub.agenthub.dev/",
    }).ok, false, address);
  }
});

test("embedded browser fails closed when credentialless frames are unavailable", async () => {
  const { createEmbeddedBrowserController } = await embeddedBrowserApi();
  const element = (initial = {}) => ({
    dataset: {},
    hidden: false,
    ...initial,
    addEventListener() {},
    removeEventListener() {},
    removeAttribute(name) { delete this[name]; },
    setAttribute(name, value) { this[name] = value; },
  });
  const nodes = new Map([
    ["[data-embedded-browser-form]", element()],
    ["[data-embedded-browser-address]", element({ value: "" })],
    ["[data-embedded-browser-frame]", element({ contentWindow: {}, hidden: true })],
    ["[data-embedded-browser-placeholder]", element()],
    ["[data-embedded-browser-status]", element({ textContent: "" })],
    ["[data-embedded-browser-external]", element({ hidden: true })],
    ["[data-embedded-browser-reload]", element({ disabled: true })],
    ["[data-embedded-browser-clear]", element({ disabled: true })],
    ["[data-embedded-browser-close]", element()],
  ]);
  const controller = createEmbeddedBrowserController({
    documentRef: { querySelector: (selector) => nodes.get(selector) ?? null },
    windowRef: {
      AgentHubHostMessageTrust: {
        isTrustedAgentHubHostMessage: () => true,
        registerEmbeddedFrame: () => {},
      },
      location: { href: "https://hub.agenthub.dev/" },
    },
  });

  const result = controller.load("https://public.example.dev/");
  assert.equal(result.error, "isolation-unsupported");
  assert.equal(nodes.get("[data-embedded-browser-frame]").src, undefined);
  assert.equal(nodes.get("[data-embedded-browser-external]").href, "https://public.example.dev/");
  assert.equal(nodes.get("[data-embedded-browser-external]").hidden, false);
});

test("embedded browser DOM uses a credentialless opaque sandbox and keeps rejected URLs out", async () => {
  const { chromium } = await import("playwright-core");
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([{
      name: "private-session",
      value: "must-not-leave",
      domain: "public.example.dev",
      path: "/",
      secure: true,
      sameSite: "None",
    }]);
    let framedCookie = null;
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (target.hostname === "agent-hub.test" && target.pathname === "/embedded-browser.js") {
        await route.fulfill({
          body: await readFile(CONTROLLER_URL),
          contentType: "text/javascript; charset=utf-8",
        });
        return;
      }
      if (target.hostname === "agent-hub.test" && target.pathname === "/host-message-trust.js") {
        await route.fulfill({
          body: await readFile(TRUST_URL),
          contentType: "text/javascript; charset=utf-8",
        });
        return;
      }
      if (target.hostname === "agent-hub.test") {
        const shell = await readFile(INDEX_URL, "utf8");
        const browserMarkup = shell.match(
          /<main class="embedded-browser-view"[\s\S]*?<\/main>/u,
        )?.[0];
        assert.ok(browserMarkup, "production embedded-browser markup");
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><body>
            <button data-view-button="chat">Chat</button>
            ${browserMarkup}
            <script src="/host-message-trust.js"></script>
            <script>window.AgentHub = { openExternalUrl: (url) => { window.openedExternalUrl = url; } };</script>
            <script src="/embedded-browser.js"></script>
          </body></html>`,
        });
        return;
      }
      if (target.hostname === "public.example.dev") {
        framedCookie = route.request().headers().cookie ?? "";
        await route.fulfill({
          contentType: "text/html",
          body: `<h1>Framed safely</h1><script>
            for (const type of ["agenthub:runtime-published", "agenthub:control-result", "agenthub:session-result", "agenthub:http-result"]) {
              parent.postMessage({ type, id: "predictable" }, "*");
            }
          </script>`,
        });
        return;
      }
      await route.abort();
    });

    await page.goto("https://agent-hub.test/");
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    assert.equal(await page.locator("iframe").getAttribute("credentialless"), "");
    assert.equal(await page.locator("iframe").getAttribute("referrerpolicy"), "no-referrer");
    assert.match(await page.locator("iframe").getAttribute("allow"), /camera 'none'/u);
    assert.match(await page.locator("iframe").getAttribute("allow"), /clipboard-write 'none'/u);

    await page.evaluate(() => {
      window.acceptedHostMessages = 0;
      window.addEventListener("message", window.AgentHubHostMessageTrust.guardHostMessage(() => {
        window.acceptedHostMessages += 1;
      }));
    });
    await page.locator("[data-embedded-browser-address]").fill("public.example.dev/private");
    await page.locator("[data-embedded-browser-form]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => !document.querySelector("iframe").hidden);
    await page.frameLocator("iframe").locator("h1").waitFor();
    assert.equal(await page.locator("iframe").getAttribute("src"), "https://public.example.dev/private");
    assert.equal(framedCookie, "");
    assert.equal(await page.evaluate(() => window.acceptedHostMessages), 0);
    assert.equal(await page.locator("[data-embedded-browser-external]").getAttribute("href"), "https://public.example.dev/private");
    await page.locator("[data-embedded-browser-external]").click();
    assert.equal(await page.evaluate(() => window.openedExternalUrl), "https://public.example.dev/private");

    await page.locator("[data-embedded-browser-address]").fill("http://127.0.0.1/admin");
    await page.locator("[data-embedded-browser-form]").evaluate((form) => form.requestSubmit());
    assert.equal(await page.locator("iframe").getAttribute("src"), "https://public.example.dev/private");
    assert.equal(await page.locator("[data-embedded-browser-address]").inputValue(), "https://public.example.dev/private");
    assert.match(await page.locator("[data-embedded-browser-status]").textContent(), /только HTTPS/u);

    await page.locator("[data-embedded-browser-clear]").click();
    assert.equal(await page.locator("iframe").isHidden(), true);
    assert.equal(await page.locator("[data-embedded-browser-external]").isHidden(), true);

    await page.locator("[data-embedded-browser-address]").fill("public.example.dev/again");
    await page.locator("[data-embedded-browser-form]").evaluate((form) => form.requestSubmit());
    await page.evaluate(() => window.AgentHubEmbeddedBrowser.deactivate());
    assert.equal(await page.locator("iframe").isHidden(), true);
    assert.equal(await page.locator("iframe").getAttribute("src"), null);
  } finally {
    await browser.close();
  }
});

test("production desktop and mobile navigation unload the remote frame", async () => {
  const { chromium } = await import("playwright-core");
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  try {
    for (const surface of [
      { viewport: { width: 1280, height: 800 }, open: '[data-view-button="browser"]', leave: '[data-view-button="chat"]' },
      { viewport: { width: 390, height: 844 }, open: '[data-mobile-button="browser"]', leave: '[data-mobile-button="chat"]' },
    ]) {
      const context = await browser.newContext({ viewport: surface.viewport });
      const page = await context.newPage();
      await openProductionApp(page);
      await page.locator(surface.open).click();
      await page.locator("[data-embedded-browser-address]").fill("public.example.dev/navigation");
      await page.locator("[data-embedded-browser-form]").evaluate((form) => form.requestSubmit());
      await page.waitForFunction(() => document.querySelector("[data-embedded-browser-frame]")?.getAttribute("src")
        === "https://public.example.dev/navigation");

      await page.locator(surface.leave).click();
      assert.equal(await page.locator("[data-embedded-browser-frame]").getAttribute("src"), null);
      assert.equal(await page.locator("[data-embedded-browser-frame]").isHidden(), true);
      assert.equal(await page.locator("html").getAttribute("data-view"), "chat");
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("production remount unloads copied frame state and rejects old and new frame senders", async () => {
  const { chromium } = await import("playwright-core");
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await openProductionApp(page);
    await page.locator('[data-view-button="browser"]').click();
    await page.locator("[data-embedded-browser-address]").fill("public.example.dev/before-replacement");
    await page.locator("[data-embedded-browser-form]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("[data-embedded-browser-frame]")?.contentWindow);

    const result = await page.evaluate(() => {
      const oldFrame = document.querySelector("[data-embedded-browser-frame]");
      const oldSource = oldFrame.contentWindow;
      const replacement = oldFrame.cloneNode(false);
      oldFrame.replaceWith(replacement);
      const untrustedBeforeRegistration = window.AgentHubHostMessageTrust
        .isTrustedAgentHubHostMessage({ source: replacement.contentWindow });
      window.AgentHubEmbeddedBrowser.mount();
      const newSource = replacement.contentWindow;
      let accepted = 0;
      const receive = window.AgentHubHostMessageTrust.guardHostMessage(() => { accepted += 1; });
      receive({ source: oldSource, data: { type: "agenthub:runtime-published" } });
      receive({ source: newSource, data: { type: "agenthub:runtime-published" } });
      receive({ source: null, data: { type: "agenthub:runtime-published" } });
      return {
        accepted,
        newHidden: replacement.hidden,
        newSrc: replacement.getAttribute("src"),
        oldSrc: oldFrame.getAttribute("src"),
        untrustedBeforeRegistration,
      };
    });

    assert.deepEqual(result, {
      accepted: 1,
      newHidden: true,
      newSrc: null,
      oldSrc: null,
      untrustedBeforeRegistration: false,
    });
    await page.locator("[data-embedded-browser-address]").fill("public.example.dev/after-replacement");
    await page.locator("[data-embedded-browser-form]").evaluate((form) => form.requestSubmit());
    assert.equal(
      await page.locator("[data-embedded-browser-frame]").getAttribute("src"),
      "https://public.example.dev/after-replacement",
    );
  } finally {
    await browser.close();
  }
});
