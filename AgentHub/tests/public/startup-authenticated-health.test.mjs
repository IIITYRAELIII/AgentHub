import assert from "node:assert/strict";
import test from "node:test";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { createLocalWebviewSession } from "../../src/interfaces/web/local-webview-session.mjs";
import { createRuntimeHealth } from "../../src/application/runtime-health.mjs";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

test("actual authenticated health reaches the full client's failed-startup overlay; public probe stays redacted", { timeout: 30000 }, async () => {
  const cause = "CODEX_CANARY_PROTOCOL: exact synthetic command approval failed <not markup>";
  const health = createRuntimeHealth();
  health.begin({ operations: [{ id: "provider", label: "Инициализация провайдера" }] });
  health.failOperation("provider", cause);
  health.setCapability("provider", { critical: true, state: "failed", error: cause });
  const secret = "h".repeat(43), calls = [];
  const server = new MiniAppServer({ host: "127.0.0.1", port: 0, journalDatabase: { subscribe: () => () => {} }, health,
    localAccessSecret: secret, controlHandler: async request => {
      calls.push(request.action);
      assert.equal(request.action, "runtime-health");
      return health.snapshot();
    } });
  let browser;
  try {
    const address = await server.start();
    const read = async (authenticated) => {
      const response = await fetch(`${address.url}api/control`, {
        method: "POST", headers: { "Content-Type": "application/json",
          ...(authenticated ? { Authorization: `webview ${createLocalWebviewSession(secret).token}` } : {}) },
        body: JSON.stringify({ action: "runtime-health", params: {} }),
      });
      return { status: response.status, body: await response.json() };
    };
    const publicHealth = await (await fetch(`${address.url}health`)).json();
    assert.equal(publicHealth.ready, false);
    assert.equal(publicHealth.capabilities[0].error, undefined);
    assert.equal(publicHealth.startup.operations[0].error, undefined);
    assert.equal((await read(false)).status, 401);
    assert.equal(calls.length, 0);

    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.exposeBinding("__readAuthenticatedHealth", async () => {
      const response = await read(true);
      assert.equal(response.status, 200);
      return response.body.result;
    });
    await openFixture(page);
    // Rebind only the existing transport port. Both actual client/control and
    // startup modules run unmodified; data comes from real authenticated HTTP.
    await page.evaluate(() => {
      const original = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = message => {
        if (message.action !== "runtime-health") return original(message);
        void window.__readAuthenticatedHealth().then(result => window.dispatchEvent(new MessageEvent("message", {
          data: { type: "agenthub:control-result", id: message.id, ok: true, result },
        })));
      };
    });
    await page.route("**/health", route => route.fulfill({ json: publicHealth }));
    const screen = page.locator(".hub-startup-screen");
    await page.waitForFunction(expected => document.querySelector(".hub-startup-errors")?.textContent.includes(expected), cause, { timeout: 10000 });
    assert.equal(page.url(), "http://agent-hub.test/");
    assert.match(await page.title(), /Agent Hub/iu);
    assert.equal(await screen.isVisible(), true);
    assert.equal(await page.locator(".hub-startup-errors not").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Повторить упавшие этапы" }).isEnabled(), true);
    assert.ok(calls.length > 0);
    if (process.env.HUB348_AUTH_SCREENSHOT) await page.screenshot({ path: process.env.HUB348_AUTH_SCREENSHOT });
    health.retryOperation("provider"); health.completeOperation("provider");
    health.setCapability("provider", { critical: true, state: "ready" }); health.complete();
    await screen.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
