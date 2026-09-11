import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A reload drops the access secret from the address, so the browser device
// client starts without it while the server still holds a valid local session.
// These checks run the production script in a real browser against a stubbed
// local-session endpoint; no live contour is involved.
const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);

async function launchEdge(chromium) {
  if (process.platform === "win32") return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true });
}

async function openDeviceClient(page, { localSession }) {
  await page.addInitScript((responses) => {
    window.localSessionCalls = 0;
    window.localSessionResponses = responses;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(typeof input === "string" ? input : input?.url ?? "");
      if (url.includes("/api/local-session")) {
        const index = Math.min(window.localSessionCalls, window.localSessionResponses.length - 1);
        window.localSessionCalls += 1;
        const status = window.localSessionResponses[index];
        if (status === "network-error") throw new Error("network down");
        return new Response(null, { status });
      }
      return nativeFetch(input, init);
    };
  }, localSession);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "device.test") return route.abort();
    if (url.pathname === "/") {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<div class="browser-auth" data-browser-auth hidden>'
          + '<form data-browser-auth-form><input data-browser-auth-name>'
          + '<input data-browser-auth-code><button data-browser-auth-submit></button>'
          + '<p data-browser-auth-status></p></form></div>'
          + '<script src="/browser-device-auth.js"></script>',
      });
    }
    if (url.pathname === "/browser-device-auth.js") {
      return route.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: await readFile(new URL("browser-device-auth.js", WEB_APP_ROOT)),
      });
    }
    return route.abort();
  });
  await page.goto("https://device.test/");
  await page.waitForFunction(() => typeof window.AgentHubBrowserDevice === "object");
  await page.waitForFunction(() => window.localSessionCalls > 0);
}

test("a live local session keeps access after a reload without the access secret", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    // 204 means the server still holds this browser's local session.
    await openDeviceClient(page, { localSession: [204] });

    const first = await page.evaluate(async () => {
      try {
        await window.AgentHubBrowserDevice.ensureSession();
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
      }
    });
    assert.equal(first.ok, true,
      `запрос данных после перезагрузки ушёл в сопряжение: ${first.message ?? ""}`);

    const pairingHidden = await page.evaluate(() => (
      document.querySelector("[data-browser-auth]").hidden === true
    ));
    assert.equal(pairingHidden, true, "показано сопряжение при действующей локальной сессии");

    // Repeated calls inside the recheck window do not re-probe the owner.
    const callsAfterFirst = await page.evaluate(() => window.localSessionCalls);
    await page.evaluate(async () => {
      await window.AgentHubBrowserDevice.ensureSession();
      await window.AgentHubBrowserDevice.ensureSession();
    });
    assert.equal(await page.evaluate(() => window.localSessionCalls), callsAfterFirst,
      "каждый запрос данных повторно опрашивает владельца сессии");
  } finally {
    await browser.close();
  }
});

test("a session that stopped being valid falls back to pairing instead of pretending", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    // Valid at startup, gone by the time the client re-checks it.
    await openDeviceClient(page, { localSession: [204, 401] });

    const forced = await page.evaluate(async () => {
      try {
        await window.AgentHubBrowserDevice.ensureSession(true);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
      }
    });
    assert.equal(forced.ok, false, "истёкшая локальная сессия была выдана за действующую");
    assert.match(forced.message, /сесси|доступ/iu);
    assert.equal(await page.evaluate(() => document.querySelector("[data-browser-auth]").hidden), false,
      "сопряжение не предложено после потери сессии");
  } finally {
    await browser.close();
  }
});

test("without a local session the client still asks for pairing", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openDeviceClient(page, { localSession: [401] });
    await page.waitForFunction(() => (
      document.querySelector("[data-browser-auth]").hidden === false
    ), null, { timeout: 10_000 });

    const attempt = await page.evaluate(async () => {
      try {
        await window.AgentHubBrowserDevice.ensureSession();
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
      }
    });
    assert.equal(attempt.ok, false, "доступ выдан без сессии и без сопряжённого устройства");
    assert.match(attempt.message, /довер|сесси|доступ/iu);
    assert.equal(await page.evaluate(() => window.AgentHubBrowserDevice.isPaired()), false);
  } finally {
    await browser.close();
  }
});
