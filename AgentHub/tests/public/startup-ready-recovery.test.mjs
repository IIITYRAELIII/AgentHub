import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { callTelegramJson } from "../../src/infrastructure/telegram/telegram-api.mjs";
import { createStartupScreenModel, shouldShowStartupScreen } from "../../assets/web-app/startup-screen-model.js";

test("authoritative ready overrides optional failure while unready still blocks", () => {
  const health = { ready: true, status: "degraded", startup: { startedAtMs: 1000, operations: [
    { id: "telegram", label: "Telegram", state: "failed", error: "fetch failed" },
  ] } };
  const model = createStartupScreenModel(health);
  assert.equal(shouldShowStartupScreen(model, { visible: true }), false);
  assert.equal(model.operations[0].error, "fetch failed", "diagnostics retained");
  assert.equal(shouldShowStartupScreen(createStartupScreenModel({ ...health, ready: false })), true);
  assert.equal(shouldShowStartupScreen(createStartupScreenModel({ ready: false })), true,
    "a new unready runtime blocks even before stage metadata arrives");
});

test("restart request without replacement evidence remains waiting even with zero blockers", async () => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(new URL("../../assets/web-app/connection-banner.js", import.meta.url), "utf8"), context);
  for (const restartBlockingCount of [0, 1]) {
    assert.equal(context.window.AgentHubConnectionBanner.snapshotConnectionState({
      restartPending: true, restartWaiting: false, restartBlockingCount,
    }).status, "restart-waiting");
  }
});

test("Telegram transport diagnostics expose bounded cause codes without token URL or payload", async () => {
  const secret = "token-secret-value";
  const cause = new TypeError(`fetch https://api.telegram.org/bot${secret}/setMyCommands payload-secret`, {
    cause: new AggregateError([Object.assign(new Error("private hostname"), { code: "UND_ERR_CONNECT_TIMEOUT" })]),
  });
  let calls = 0;
  await assert.rejects(callTelegramJson({ token: secret, method: "setMyCommands", body: { private: "payload-secret" },
    fetchImpl: async () => { calls += 1; throw cause; },
  }), (error) => {
    assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/u);
    assert.doesNotMatch(error.message, /token-secret|https:|payload-secret|private hostname/u);
    assert.equal(error.uncertain, true);
    assert.equal(error.retryable, true);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(calls, 1, "no retry added");
});

test("real DOM: degraded ready, slow health, queued restart, replacement and targeted retry preserve working UI", { timeout: 30000 }, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    let health = { ready: true, status: "degraded", process: { instanceId: "instance-a" }, startup: {
      startedAtMs: 1000, completedAtMs: 2000, operations: [
        { id: "web", label: "Web", state: "completed" },
        { id: "telegram", label: "Telegram", state: "failed", error: "transport failed" },
      ],
    } };
    let hold = false;
    let pending = null;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "startup.test") return route.abort();
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body:
        '<title>Hub startup recovery fixture</title><link rel="stylesheet" href="/startup-screen.css">'
        + '<main><button id="chat">Chat works</button><textarea id="draft">unsent draft</textarea><p id="history">Retained history</p></main>'
        + '<script type="module" src="/startup-screen.js"></script>' });
      if (url.pathname === "/health") {
        if (hold) await new Promise((resolve) => { pending = resolve; });
        return route.fulfill({ json: health });
      }
      const name = url.pathname.slice(1);
      if (!["startup-screen.js", "startup-screen-model.js", "startup-screen.css", "agent-hub-mark.png"].includes(name)) return route.abort();
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "image/png",
        body: await readFile(new URL(`../../assets/web-app/${name}`, import.meta.url)) });
    });
    await page.addInitScript(() => {
      window.requests = [];
      document.addEventListener("agenthub:startup-recovery", (event) => window.requests.push(event.detail));
    });
    await page.goto("https://startup.test/");
    assert.equal(await page.title(), "Hub startup recovery fixture");
    const screen = page.locator(".hub-startup-screen");
    await page.locator(".hub-startup-diagnostics").waitFor({ state: "visible" });
    assert.equal(await screen.isHidden(), true);
    await page.locator("#chat").click();
    await page.locator("#draft").fill("retained edited draft");
    await page.locator(".hub-startup-diagnostics summary").click();
    if (process.env.STARTUP_RECOVERY_QA_DIR) {
      await mkdir(process.env.STARTUP_RECOVERY_QA_DIR, { recursive: true });
      for (const width of [1200, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: path.join(process.env.STARTUP_RECOVERY_QA_DIR, `degraded-${width}.png`) });
      }
      await page.setViewportSize({ width: 1200, height: 900 });
    }
    await page.locator(".hub-startup-diagnostics button").click();
    assert.deepEqual(await page.evaluate(() => window.requests), [{ action: "retry-startup", startedAtMs: 1000 }]);
    assert.equal(await page.locator(".hub-startup-diagnostics button").isDisabled(), true);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("agenthub:startup-recovery-result", { detail: { message: "retry failed" } })));
    hold = true;
    await page.waitForTimeout(3500);
    assert.ok(pending, "a health response is still pending beyond 1500ms");
    assert.equal(await screen.isHidden(), true);
    await page.locator("#chat").click();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agenthub:connection-state", { detail: { status: "restart-waiting" } })));
    assert.equal(await screen.isHidden(), true);
    hold = false; pending(); pending = null;
    health = { ready: false, status: "starting", process: { instanceId: "instance-b" }, startup: {
      startedAtMs: 3000, operations: [{ id: "provider", label: "Provider starting", state: "running" }],
    } };
    await screen.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector(".hub-startup-title")?.textContent === "Provider starting");
    health.startup.operations[0] = { id: "provider", label: "Provider", state: "failed", error: "mandatory unavailable" };
    await page.waitForFunction(() => document.querySelector(".hub-startup-errors")?.textContent.includes("mandatory unavailable"));
    assert.equal(await screen.isVisible(), true);
    health = { ...health, ready: true, status: "ready", startup: { ...health.startup,
      operations: [{ id: "provider", label: "Provider", state: "completed" }],
    } };
    await screen.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".hub-startup-diagnostics").isHidden(), true);
    assert.equal(await page.locator("#draft").inputValue(), "retained edited draft");
    assert.equal(await page.locator("#history").textContent(), "Retained history");
    assert.equal((await page.evaluate(() => window.requests)).length, 1, "no automatic retry/restart");
    if (process.env.STARTUP_RECOVERY_QA_DIR) {
      await mkdir(process.env.STARTUP_RECOVERY_QA_DIR, { recursive: true });
      for (const width of [1200, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: path.join(process.env.STARTUP_RECOVERY_QA_DIR, `ready-${width}.png`) });
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("real DOM: cancelled transitions leave a fresh unready stage title visible", { timeout: 15000 }, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.fixtureHealth = { ready: false, startup: { startedAtMs: 1000, operations: [
        { id: "a", label: "Stage A", state: "running" },
      ] } };
      window.fetch = async () => ({ ok: true, json: async () => structuredClone(window.fixtureHealth) });
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "startup.test") return route.abort();
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body:
        '<title>Startup transition fixture</title><link rel="stylesheet" href="/startup-screen.css">'
        + '<button>Chat</button><script type="module" src="/startup-screen.js"></script>' });
      const name = url.pathname.slice(1);
      if (!["startup-screen.js", "startup-screen-model.js", "startup-screen.css", "agent-hub-mark.png"].includes(name)) return route.abort();
      return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "image/png",
        body: await readFile(new URL(`../../assets/web-app/${name}`, import.meta.url)) });
    });
    await page.goto("https://startup.test/");
    await page.waitForFunction(() => document.querySelector(".hub-startup-title")?.textContent === "Stage A");
    const result = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const refresh = () => document.dispatchEvent(new CustomEvent("agenthub:startup-recovery-result", { detail: { message: "fixture refresh" } }));
      const capture = () => ({ hidden: document.querySelector(".hub-startup-screen").hidden,
        title: document.querySelector(".hub-startup-title").textContent,
        opacity: getComputedStyle(document.querySelector(".hub-startup-title")).opacity });
      const stage = (id, label, ready = false, startedAtMs = 1000) => ({ ready, startup: { startedAtMs,
        operations: [{ id, label, state: ready ? "completed" : "running" }] } });
      window.fixtureHealth = stage("b", "Stage B"); refresh(); await sleep(0);
      const transitioning = document.querySelector(".hub-startup-screen").classList.contains("is-transitioning");
      window.fixtureHealth = stage("b", "Stage B", true); refresh(); await sleep(0);
      const ready = capture();
      await sleep(400);
      const settledReady = capture();
      window.fixtureHealth = stage("b", "Replacement Stage B", false, 2000); refresh(); await sleep(0); await sleep(600);
      const replacement = capture();
      window.fixtureHealth = stage("c", "Stage C", false, 2000); refresh(); await sleep(0);
      window.fixtureHealth = stage("c", "Updated Stage C", false, 2000); refresh(); await sleep(0); await sleep(600);
      return { transitioning, ready, settledReady, replacement, sameStageRefresh: capture() };
    });
    assert.equal(result.transitioning, true, "fixture reaches the actual transition before ready");
    assert.equal(result.ready.hidden, true);
    assert.equal(result.settledReady.hidden, true, "cancelled callback cannot reopen ready UI");
    for (const [actual, title] of [[result.replacement, "Replacement Stage B"], [result.sameStageRefresh, "Updated Stage C"]]) {
      assert.equal(actual.hidden, false);
      assert.equal(actual.title, title);
      assert.equal(Number(actual.opacity), 1, "cancelled transition must not hide the current title");
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
