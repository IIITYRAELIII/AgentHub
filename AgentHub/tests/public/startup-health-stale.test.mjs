import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const INITIAL_GENERATION = Date.now() - 14000;
const health = (generation = INITIAL_GENERATION, ready = false) => ({ ready, status: ready ? "ready" : "starting",
  startup: { startedAtMs: generation, operations: Array.from({ length: 17 }, (_, i) => ({
    id: `stage-${i}`, label: i === 7 ? "Инициализация провайдера" : `Этап ${i + 1}`,
    state: ready || i < 7 ? "completed" : i === 7 ? "running" : "pending",
  })) } });

async function fixture() {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(() => {
    window.healthRequests = []; window.recoveryRequests = [];
    document.addEventListener("agenthub:startup-recovery", e => recoveryRequests.push(e.detail));
    window.fetch = (url, init) => new Promise((resolve, reject) => {
      const item = { url, signal: init.signal, resolve, reject };
      window.healthRequests.push(item);
      // Deliberately ignore abort: late transport callbacks still must be fenced.
    });
  });
  await page.route("**/*", async route => {
    const u = new URL(route.request().url());
    if (u.hostname !== "startup.test") return route.abort();
    if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body:
      '<title>Agent Hub startup health fixture</title><link rel="stylesheet" href="/startup-screen.css">'
      + '<main><button id="chat">Chat</button></main><script src="/command-trace.js" defer></script>'
      + '<script type="module" src="/startup-screen.js"></script>' });
    const name = u.pathname.slice(1);
    assert.ok(["startup-screen.js", "startup-screen-model.js", "startup-screen.css", "agent-hub-mark.png", "command-trace.js"].includes(name));
    return route.fulfill({ contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "image/png",
      body: await readFile(new URL(`../../assets/web-app/${name}`, import.meta.url)) });
  });
  await page.goto("https://startup.test/");
  const call = n => page.waitForFunction(n => window.healthRequests.length >= n, n);
  const answer = (n, snapshot, holdBody = false) => page.evaluate(({ n, snapshot, holdBody }) => {
    const request = healthRequests[n - 1];
    let finish;
    const body = holdBody ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(snapshot);
    request.finishBody = () => finish(snapshot);
    request.resolve({ ok: true, status: 200, json: () => body });
  }, { n, snapshot, holdBody });
  const capture = async name => {
    if (!process.env.STARTUP_HEALTH_QA_DIR) return;
    await mkdir(process.env.STARTUP_HEALTH_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.STARTUP_HEALTH_QA_DIR, name + ".png") });
  };
  const refresh = () => page.evaluate(() => document.dispatchEvent(new CustomEvent("agenthub:startup-recovery-result", { detail: {} })));
  return { browser, page, errors, call, answer, capture, refresh };
}

test("delayed JSON and failed health preserve stale stages/time, coalesce refreshes and recover", { timeout: 45000 }, async () => {
  const f = await fixture(); const { page } = f;
  try {
    await f.call(1); await f.answer(1, health());
    await page.waitForFunction(() => document.querySelectorAll(".hub-startup-completed-item").length === 7);
    await f.capture("fresh-desktop");
    await f.call(2); await f.answer(2, health(), true);
    await page.evaluate(() => { window.firstStage = document.querySelector(".hub-startup-completed-item"); });
    for (let n = 0; n < 4; n++) await f.refresh();
    await page.waitForFunction(() => document.querySelector(".hub-startup-screen").classList.contains("is-disconnected"));
    const stale = await page.evaluate(() => ({ completed: document.querySelectorAll(".hub-startup-completed-item").length,
      queue: document.querySelectorAll(".hub-startup-queue-item").length,
      label: document.querySelector(".hub-startup-stage-count").textContent,
      status: document.querySelector(".hub-startup-connection-status").textContent,
      timer: document.querySelector(".hub-startup-timer").textContent,
      sameNode: window.firstStage === document.querySelector(".hub-startup-completed-item"), requests: healthRequests.length }));
    assert.equal(stale.completed, 7); assert.equal(stale.queue, 10); assert.equal(stale.label, "8 из 17 этапов");
    assert.match(stale.status, /последние подтверждённые/u); assert.equal(stale.sameNode, true); assert.equal(stale.requests, 2);
    await f.capture("stale-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    const rowVisible = await page.evaluate(() => {
      const row = document.querySelector(".hub-startup-queue-item").getBoundingClientRect();
      const footer = document.querySelector(".hub-startup-recovery").getBoundingClientRect();
      return { visible: row.top >= 0 && row.bottom <= footer.top, rowTop: row.top, rowBottom: row.bottom, footerTop: footer.top };
    });
    await f.capture("stale-mobile");
    assert.equal(rowVisible.visible, true, `stale connection label leaves the last active stage visible on mobile: ${JSON.stringify(rowVisible)}`);
    await page.waitForTimeout(1200);
    assert.equal(await page.locator(".hub-startup-timer").textContent(), stale.timer, "stale elapsed observation is frozen");
    await page.evaluate(() => healthRequests[1].finishBody()); await f.call(3);
    await page.evaluate(() => healthRequests[2].reject(new Error("private failure")));
    await f.call(4); await page.waitForTimeout(1800);
    assert.equal(await page.locator(".hub-startup-completed-item").count(), 7, "prolonged outage retains observations");
    const retained = await page.evaluate(() => JSON.parse(localStorage.getItem("agent-hub-upload-trace-v1")));
    assert.ok(retained.some(e => e.metadata.action === "startup-health-read" && e.outcome === "failed"));
    const requestIds = await page.evaluate(() => healthRequests.map(r => new URL(r.url, location.href).searchParams.get("clientTraceId")));
    assert.ok(retained.every(e => requestIds.includes(e.commandId)), "all persisted phases keep their original health request ID");
    assert.doesNotMatch(JSON.stringify(retained), /private failure|Инициализация/u);
    await f.answer(4, health());
    await page.waitForFunction(() => !document.querySelector(".hub-startup-screen").classList.contains("is-disconnected"));
    assert.equal(await page.locator(".hub-startup-completed-item").count(), 7); assert.deepEqual(f.errors, []);
    assert.equal((await page.evaluate(() => recoveryRequests)).length, 0);
  } finally { await f.browser.close(); }
});

test("fresh canonical successful restart can settle a wait before the first health sample", { timeout: 30000 }, async () => {
  const f = await fixture(); const { page } = f;
  try {
    await f.call(1);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agenthub:connection-state", { detail: { status: "restarting" } })));
    await f.call(2);
    const snapshot = health(INITIAL_GENERATION + 1000, true);
    snapshot.diagnostics = { restart: { operationId: "exact-canonical", status: "succeeded", completedAt: new Date().toISOString() } };
    await f.answer(2, snapshot);
    await page.locator(".hub-startup-screen").waitFor({ state: "hidden" });
    await f.answer(1, health());
    assert.equal(await page.locator(".hub-startup-screen").isHidden(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test("a new restart after transient loss rejects a previous terminal and repeated events retain its boundary", { timeout: 30000 }, async () => {
  const f = await fixture(); const { page } = f;
  try {
    await f.call(1); await f.answer(1, health()); await f.call(2);
    await page.waitForFunction(() => document.querySelector(".hub-startup-screen").classList.contains("is-disconnected"));
    const previousTerminalAt = await page.evaluate(() => Date.now());
    await page.waitForFunction(at => Date.now() > at, previousTerminalAt);
    const restartStartedAt = await page.evaluate(() => {
      const at = Date.now();
      window.dispatchEvent(new CustomEvent("agenthub:connection-state", { detail: { status: "restarting" } }));
      return at;
    });
    await f.call(3);
    const previousReady = health(INITIAL_GENERATION, true);
    previousReady.diagnostics = { restart: { operationId: "previous-canonical", status: "succeeded",
      completedAt: new Date(previousTerminalAt).toISOString() } };
    await f.answer(3, previousReady); await f.call(4);
    assert.ok(previousTerminalAt < restartStartedAt);
    assert.equal(await page.locator(".hub-startup-screen").isVisible(), true,
      "a terminal before this replacement and unchanged generation cannot settle the new wait");
    assert.equal(await page.locator(".hub-startup-completed-item").count(), 0,
      "a real replacement does not inherit the previous startup stages");
    await f.capture("R1-prior-terminal-refused");

    const currentTerminalAt = await page.evaluate(() => Date.now());
    await page.waitForFunction(at => Date.now() > at, currentTerminalAt);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("agenthub:connection-state", { detail: { status: "restarting" } }));
      window.dispatchEvent(new CustomEvent("agenthub:connection-state", { detail: { status: "restarting" } }));
    });
    assert.equal(await page.evaluate(() => healthRequests.length), 4, "same-wait events preserve the in-flight read");
    const currentReady = health(INITIAL_GENERATION, true);
    currentReady.diagnostics = { restart: { operationId: "current-canonical", status: "succeeded",
      completedAt: new Date(currentTerminalAt).toISOString() } };
    await f.answer(4, currentReady);
    await page.locator(".hub-startup-screen").waitFor({ state: "hidden" });
    await f.answer(2, previousReady);
    assert.equal(await page.locator(".hub-startup-screen").isHidden(), true, "late old read cannot reopen a settled wait");
    assert.equal((await page.evaluate(() => recoveryRequests)).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test("restart fences late old requests and online cannot adopt the previous ready generation", { timeout: 30000 }, async () => {
  const f = await fixture(); const { page } = f;
  try {
    await f.call(1); await f.answer(1, health()); await f.call(2);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agenthub:connection-state", { detail: { status: "restarting" } })));
    await f.call(3); assert.equal(await page.evaluate(() => healthRequests[1].signal.aborted), true);
    await f.answer(3, health(INITIAL_GENERATION, true));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agenthub:connection-state", { detail: { status: "online" } })));
    assert.equal(await page.locator(".hub-startup-screen").isVisible(), true);
    await f.call(4); await f.answer(4, health(INITIAL_GENERATION + 1000));
    await page.waitForFunction(() => document.querySelectorAll(".hub-startup-dial-segment").length === 17);
    await f.answer(2, health(INITIAL_GENERATION, true));
    await page.waitForTimeout(350);
    assert.equal(await page.locator(".hub-startup-screen").isVisible(), true, "late ready cannot hide replacement");
    await f.call(5); await f.answer(5, health(INITIAL_GENERATION, true));
    await page.waitForFunction(() => document.querySelector(".hub-startup-screen").classList.contains("is-disconnected"));
    assert.equal(await page.locator(".hub-startup-completed-item").count(), 7, "older received generation cannot roll back");
    await f.call(6); await f.answer(6, health(INITIAL_GENERATION + 1000, true));
    await page.locator(".hub-startup-screen").waitFor({ state: "hidden" });
    assert.equal((await page.evaluate(() => recoveryRequests)).length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test("first online working paint shares the confirmed Ready health request ID", { timeout: 20000 }, async () => {
  const f = await fixture();
  const { page } = f;
  try {
    await page.evaluate(() => {
      window.startupTraceEvents = [];
      window.AgentHubCommandTrace.bindReporter(async ({ events }) => {
        window.startupTraceEvents.push(...events);
      });
    });
    await f.call(1);
    await f.answer(1, health());
    await page.waitForFunction(() => document.querySelectorAll(".hub-startup-completed-item").length === 7);
    await f.call(2);
    await f.answer(2, health(INITIAL_GENERATION, true));
    await page.locator(".hub-startup-screen").waitFor({ state: "hidden" });
    const readyId = await page.evaluate(() => new URL(healthRequests[1].url, location.href).searchParams.get("clientTraceId"));
    assert.ok(readyId);
    const action = "startup-first-working-paint";
    await page.evaluate(() => window.AgentHubCommandTrace.flush());
    assert.equal(await page.evaluate(action => startupTraceEvents.filter(e => e.metadata.action === action).length, action), 0);
    await page.evaluate(() => {
      document.documentElement.dataset.connection = "online";
      for (let i = 0; i < 2; i++) {
        window.dispatchEvent(new CustomEvent("agenthub:connection-state", { detail: { status: "online" } }));
      }
    });
    await page.waitForFunction(action => {
      void window.AgentHubCommandTrace.flush();
      return startupTraceEvents.some(e => e.metadata.action === action && e.outcome === "succeeded");
    }, action);
    const working = await page.evaluate(action => startupTraceEvents
      .filter(e => e.metadata.action === action && e.outcome === "succeeded"), action);
    assert.equal(working.length, 1);
    assert.equal(working[0].commandId, readyId);
    assert.equal(working[0].metadata.httpRequestId, readyId);
    assert.equal(working[0].metadata.clientAssetRevision, "startup-stale.v2");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.browser.close();
  }
});
