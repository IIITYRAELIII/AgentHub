import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const TEST_THEME_CATALOG = JSON.stringify([{
  id: "orbit",
  name: "Orbit",
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function openProductionUi(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    if (url.pathname === "/work-log.css") {
      return route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    try {
      return route.fulfill({
        status: 200,
        contentType: contentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
}

function navigationTask() {
  return {
    provider: "codex",
    threadId: "thread-current",
    streamId: "stream-1",
    workspaceId: "workspace-1",
    workspaceName: "Agent Hub",
    streamName: "Диалоги",
    title: "Диалоги",
    displayTitle: "Диалоги",
    selected: true,
    lastAnswerAt: "2026-09-08T07:00:00.000Z",
  };
}

function navigationSnapshot() {
  return {
    version: "snapshot-1",
    tasks: [navigationTask()],
    workspaces: [{
      id: "workspace-1",
      name: "Agent Hub",
      streams: [{
        id: "stream-1",
        name: "Диалоги",
        threads: [{ provider: "codex", threadId: "thread-current" }],
      }],
    }],
    messagePins: [{
      id: "pin-target",
      streamId: "stream-1",
      messageKey: "message:v1:target",
      provider: "codex",
      taskThreadId: "thread-current",
      turnThreadId: "thread-current",
      turnId: "turn-target",
      itemId: "answer-target",
      role: "agent",
      preview: "Точное сообщение из другой страницы истории",
      author: "Codex",
      time: "2026-09-08T06:30:00.000Z",
      available: true,
    }],
    settings: {},
    selected: {
      provider: "codex",
      threadId: "thread-current",
      streamId: "stream-1",
    },
  };
}

function navigationHistory({ focused = false } = {}) {
  const start = focused ? 30 : 80;
  const items = Array.from({ length: 20 }, (_, offset) => {
    const index = start + offset;
    const target = focused && offset === 9;
    return {
      id: target ? "turn-target" : `turn-${index}`,
      provider: "codex",
      threadId: "thread-current",
      completed: true,
      status: "completed",
      terminalRevision: 1,
      startedAt: `2026-09-08T06:${String(index % 60).padStart(2, "0")}:00.000Z`,
      completedAt: `2026-09-08T06:${String(index % 60).padStart(2, "0")}:30.000Z`,
      messages: [{
        itemId: target ? "answer-target" : `answer-${index}`,
        messageKey: target ? "message:v1:target" : `message:v1:${index}`,
        pinEligible: true,
        role: "agent",
        text: `${target ? "Точное закреплённое сообщение" : `Ответ ${index}`}\n\n${"Контекст строки. ".repeat(18)}`,
      }],
    };
  });
  return {
    provider: "codex",
    threadId: "thread-current",
    streamId: "stream-1",
    start,
    end: start + items.length,
    total: 100,
    messageTotal: 100,
    nextBefore: String(start),
    version: focused ? "history-focused" : "history-current",
    items,
  };
}

async function openProductionNavigationUi(page, { surface = "web" } = {}) {
  const snapshot = navigationSnapshot();
  const actions = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    let uuidSequence = 0;
    if (typeof crypto.randomUUID !== "function") Object.defineProperty(crypto, "randomUUID", {
      value: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
    });
    const nativeScrollIntoView = Element.prototype.scrollIntoView;
    window.__hub105ScrollIntoView = [];
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      window.__hub105ScrollIntoView.push({
        itemId: this.getAttribute?.("data-item-id") ?? "",
        behavior: options?.behavior ?? "auto",
      });
      return nativeScrollIntoView.call(this, options);
    };
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/api/snapshot") {
      if (request.method() === "HEAD") return route.fulfill({ status: 204 });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    }
    if (url.pathname === "/api/control") {
      const body = request.postDataJSON();
      actions.push(body.action);
      let result = {};
      if (body.action === "open-task") {
        result = { snapshot, history: navigationHistory() };
      } else if (body.action === "open-turn") {
        result = {
          snapshot,
          history: navigationHistory({ focused: true }),
          focusedMessage: { turnId: "turn-target", itemId: "answer-target" },
        };
      } else if (body.action === "task-history") {
        result = {
          provider: "codex",
          threadId: "thread-current",
          streamId: "stream-1",
          notModified: true,
          version: "history-current",
        };
      } else if (body.action === "rate-limit-history") {
        result = { points: [] };
      } else {
        result = snapshot;
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, result }),
      });
    }
    if (url.pathname === "/api/control/ack") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (url.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    if (url.pathname === "/work-log.css") {
      return route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    try {
      return route.fulfill({
        status: 200,
        contentType: contentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://agent-hub.test/#/chat/stream/stream-1", { waitUntil: "load" });
  try {
    await page.waitForFunction(() => (
      typeof window.AgentHub === "object"
      && document.querySelectorAll("[data-chat-log] [data-item-id]").length === 20
    ));
  } catch (error) {
    const state = await page.evaluate(() => ({
      messageCount: document.querySelectorAll("[data-chat-log] [data-item-id]").length,
      toast: document.querySelector("[data-toast]")?.textContent ?? "",
    }));
    throw new Error(`${error.message}; ${JSON.stringify({ actions, pageErrors, state })}`);
  }
  await page.evaluate((nextSurface) => {
    document.documentElement.dataset.surface = nextSurface;
    window.AgentHub.showSelectedTask();
    const scroll = document.querySelector("[data-chat-scroll]");
    const log = document.querySelector("[data-chat-log]");
    const sample = (kind) => {
      const target = log.querySelector("[data-item-id='answer-target']");
      window.__hub105Trace.push({
        kind,
        scrollTop: scroll.scrollTop,
        targetPresent: Boolean(target),
      });
    };
    window.__hub105Trace = [];
    window.__hub105StartTrace = () => {
      window.__hub105Trace = [];
      sample("start");
    };
    scroll.addEventListener("scroll", () => sample("scroll"));
    new MutationObserver(() => requestAnimationFrame(() => sample("mutation-frame")))
      .observe(log, { childList: true });
  }, surface);
  return actions;
}

async function seed(page, { mobile = false } = {}) {
  await page.evaluate(({ mobile }) => {
    if (mobile) document.documentElement.dataset.surface = "mobile";
    const task = {
      id: "task-1",
      provider: "codex",
      threadId: "thread-new",
      workspaceId: "workspace-1",
      workspaceName: "Agent Hub",
      streamId: "stream-1",
      streamName: "Диалоги",
      title: "Диалоги",
      agentLabel: "Codex",
      selected: true,
    };
    window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent Hub" }]);
    window.AgentHub.setTasks([task]);
    window.AgentHub.setMessages("task-1", [{
      id: "message-1",
      provider: "codex",
      threadId: "thread-old",
      turnId: "turn-1",
      itemId: "answer-1",
      messageKey: "message:v1:answer",
      pinEligible: true,
      role: "agent",
      author: "Codex",
      text: "Точный закреплённый ответ",
      time: "2026-09-06T10:00:00.000Z",
    }]);
    window.AgentHub.setMessagePins([{
      id: "pin-1",
      streamId: "stream-1",
      messageKey: "message:v1:answer",
      provider: "codex",
      taskThreadId: "thread-old",
      turnThreadId: "thread-old",
      turnId: "turn-1",
      itemId: "answer-1",
      role: "agent",
      preview: "Точный закреплённый ответ",
      author: "Codex",
      time: "2026-09-06T10:00:00.000Z",
      available: true,
    }, {
      id: "pin-missing",
      streamId: "stream-1",
      messageKey: "message:v1:missing",
      provider: "claude",
      taskThreadId: "thread-retired",
      turnThreadId: "thread-retired",
      turnId: "turn-missing",
      itemId: "answer-missing",
      role: "agent",
      preview: "Старый ответ после compaction",
      author: "Claude",
      available: false,
    }]);
    window.AgentHub.showSelectedTask();
  }, { mobile });
}

async function capture(page, name) {
  const directory = String(process.env.AGENT_HUB_CAPTURE_DIR ?? "").trim();
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
}

function messagePin(id, messageKey, preview) {
  return {
    id,
    streamId: "stream-1",
    messageKey,
    provider: "codex",
    taskThreadId: "thread-old",
    turnThreadId: "thread-old",
    turnId: `turn-${id}`,
    itemId: `item-${id}`,
    role: "agent",
    preview,
    author: "Codex",
    time: "2026-09-06T10:00:00.000Z",
    available: true,
  };
}

test("production pin navigation replaces a history window without a second scroll excursion", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  const surfaces = [
    { name: "web", surface: "web", viewport: { width: 1280, height: 800 } },
    { name: "vscode-webview-narrow", surface: "vscode", viewport: { width: 720, height: 900 } },
    { name: "mobile-web", surface: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  ];
  try {
    for (const surface of surfaces) {
      const page = await browser.newPage({
        viewport: surface.viewport,
        deviceScaleFactor: surface.deviceScaleFactor ?? 1,
      });
      const actions = await openProductionNavigationUi(page, { surface: surface.surface });
      const scroll = page.locator("[data-chat-scroll]");
      await scroll.evaluate((node) => {
        node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.35);
      });
      await page.waitForTimeout(50);
      await page.evaluate(() => window.__hub105StartTrace());
      await page.locator("[data-message-pin-current]").evaluate((button) => button.click());
      const target = page.locator("[data-item-id='answer-target']");
      await target.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.activeElement?.dataset?.itemId === "answer-target");
      assert.equal(await target.getAttribute("data-pin-highlight"), "");
      assert.equal(await page.locator("[data-message-pin-status]").textContent(), "Закреплённое сообщение показано");
      await page.waitForTimeout(40);
      await capture(page, `hub105-${surface.name}-first-frame`);
      await page.waitForTimeout(260);
      await capture(page, `hub105-${surface.name}-settled`);

      assert.equal(actions.filter((action) => action === "open-turn").length, 1);
      const firstNavigation = await page.evaluate(() => ({
        calls: window.__hub105ScrollIntoView.filter((call) => call.itemId === "answer-target"),
        trace: window.__hub105Trace.slice(),
      }));
      assert.deepEqual(firstNavigation.calls.map((call) => call.behavior), ["auto"]);
      const targetScrolls = firstNavigation.trace.filter((sample) => (
        sample.kind === "scroll" && sample.targetPresent
      ));
      if (targetScrolls.length > 1) {
        const positions = targetScrolls.map((sample) => sample.scrollTop);
        assert.ok(Math.max(...positions) - Math.min(...positions) <= 2, JSON.stringify(firstNavigation.trace));
      }

      await page.evaluate(() => {
        window.__hub105ScrollIntoView = [];
        window.__hub105StartTrace();
      });
      await page.locator("[data-message-pin-current]").evaluate((button) => button.click());
      await page.waitForTimeout(300);
      assert.equal(actions.filter((action) => action === "open-turn").length, 2);
      const repeatedNavigation = await page.evaluate(() => ({
        calls: window.__hub105ScrollIntoView.filter((call) => call.itemId === "answer-target"),
        trace: window.__hub105Trace.slice(),
      }));
      assert.equal(repeatedNavigation.calls.length, 1);
      const repeatedScrolls = repeatedNavigation.trace.filter((sample) => sample.kind === "scroll");
      if (repeatedScrolls.length > 1) {
        const positions = repeatedScrolls.map((sample) => sample.scrollTop);
        assert.ok(Math.max(...positions) - Math.min(...positions) <= 2, JSON.stringify(repeatedNavigation.trace));
      }
      await page.close();
    }

    const reducedPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await reducedPage.emulateMedia({ reducedMotion: "reduce" });
    await openProductionNavigationUi(reducedPage);
    await reducedPage.locator("[data-message-pin-current]").evaluate((button) => button.click());
    await reducedPage.locator("[data-item-id='answer-target'][data-pin-highlight]").waitFor();
    await reducedPage.evaluate(() => {
      window.__hub105ScrollIntoView = [];
      window.__hub105StartTrace();
    });
    await reducedPage.locator("[data-message-pin-current]").evaluate((button) => button.click());
    await reducedPage.waitForTimeout(50);
    assert.deepEqual(
      await reducedPage.evaluate(() => window.__hub105ScrollIntoView
        .filter((call) => call.itemId === "answer-target")
        .map((call) => call.behavior)),
      ["auto"],
    );
    await reducedPage.close();
  } finally {
    await browser.close();
  }
});

test("production message pin UI exposes carousel, list, unavailable state, pin action and exact highlight", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await openProductionUi(page);
    await seed(page);
    assert.equal(await page.locator("[data-message-pin-shelf]").isVisible(), true);
    const shelfPinColors = await page.locator(".message-pin-shelf-icon").evaluate((icon) => ({
      color: getComputedStyle(icon).color,
      fill: getComputedStyle(icon.querySelector("path")).fill,
    }));
    assert.equal(shelfPinColors.fill, shelfPinColors.color);
    assert.equal(await page.locator("[data-message-pin-position]").textContent(), "1 из 2");
    assert.equal(await page.locator("[data-message-pin='']").getAttribute("aria-pressed"), "true");
    await capture(page, "web-desktop-multiple");

    await page.locator("[data-message-pins-open]").click();
    assert.equal(await page.locator("[data-message-pins-modal]").getAttribute("open"), "");
    assert.equal(await page.locator("[data-message-pin-id]").count(), 2);
    assert.equal(await page.locator("[data-message-pin-id='pin-missing'] [data-message-pin-jump]").isDisabled(), true);
    await capture(page, "web-desktop-list-unavailable");

    await page.locator("[data-message-pins-close]").click();
    await page.evaluate(() => window.AgentHub.focusMessage({ turnId: "turn-1", itemId: "answer-1" }));
    assert.equal(await page.locator("[data-item-id='answer-1']").getAttribute("data-pin-highlight"), "");
    await capture(page, "web-desktop-jump-highlight");
    await page.evaluate(() => window.AgentHub.setMessagePins([{
      id: "pin-1",
      streamId: "stream-1",
      messageKey: "message:v1:answer",
      provider: "codex",
      taskThreadId: "thread-old",
      turnThreadId: "thread-old",
      turnId: "turn-1",
      itemId: "answer-1",
      role: "agent",
      preview: "Точный закреплённый ответ",
      author: "Codex",
      time: "2026-09-06T10:00:00.000Z",
      available: true,
    }]));
    await capture(page, "web-desktop-single");
  } finally {
    await browser.close();
  }
});

test("mobile production pin list is a bottom sheet with touch-sized controls", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await openProductionUi(page);
    await seed(page, { mobile: true });
    const current = await page.locator("[data-message-pin-current]").boundingBox();
    const position = await page.locator("[data-message-pin-position]").boundingBox();
    assert.ok(current.x + current.width <= position.x);
    await capture(page, "mobile-web-multiple");
    await page.locator("[data-message-pins-open]").click();
    const modal = page.locator("[data-message-pins-modal]");
    const box = await modal.boundingBox();
    assert.ok(box.y + box.height >= 770 && box.y + box.height <= 790);
    const target = await page.locator("[data-message-pin-remove='pin-1']").boundingBox();
    assert.ok(target.height >= 44);
    await capture(page, "mobile-web-list-unavailable");
  } finally {
    await browser.close();
  }
});

test("narrow VS Code WebView uses the shared responsive pin bottom sheet", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 900 }, deviceScaleFactor: 2 });
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return null; }, setState() {} });
    });
    await openProductionUi(page);
    await seed(page);
    await page.locator("[data-message-pins-open]").click();
    const box = await page.locator("[data-message-pins-modal]").boundingBox();
    assert.ok(box.y + box.height >= 826 && box.y + box.height <= 846);
    await capture(page, "vscode-webview-narrow-list");
  } finally {
    await browser.close();
  }
});

test("pin mutations preserve deterministic carousel selection and rollback", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  const pinA = messagePin("pin-a", "message:v1:a", "Закрепление A");
  const pinB = messagePin("pin-b", "message:v1:b", "Закрепление B");
  const pinC = messagePin("pin-c", "message:v1:c", "Закрепление C");
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      let mutationSequence = 0;
      if (typeof crypto.randomUUID !== "function") Object.defineProperty(crypto, "randomUUID", {
        value: () => `00000000-0000-4000-8000-${String(++mutationSequence).padStart(12, "0")}`,
      });
    });
    await openProductionUi(page);
    await seed(page);
    await page.evaluate(() => {
      window.__messagePinIntents = [];
      document.addEventListener("agenthub:intent", (event) => {
        if (event.detail?.type === "message-pin:set") window.__messagePinIntents.push(event.detail);
      });
      window.AgentHub.setMessages("task-1", [{
        id: "message-1",
        provider: "codex",
        threadId: "thread-old",
        turnId: "turn-1",
        itemId: "answer-1",
        messageKey: "message:v1:answer",
        pinEligible: true,
        role: "agent",
        author: "Codex",
        text: "Точный закреплённый ответ",
        time: "2026-09-06T10:00:00.000Z",
      }, {
        id: "message-new",
        provider: "codex",
        threadId: "thread-new",
        turnId: "turn-new",
        itemId: "user-new",
        messageKey: "message:v1:new",
        pinEligible: true,
        role: "user",
        author: "Вы",
        text: "Новое закрепление",
        time: "2026-09-06T10:01:00.000Z",
      }]);
    });
    const initialPins = [pinA, pinB];
    await page.evaluate((pins) => window.AgentHub.setMessagePins(pins), initialPins);

    await page.locator("[data-message-pin-next]").click();
    assert.equal(await page.locator("[data-message-pin-position]").textContent(), "2 из 2");
    const newMessage = page.locator("[data-chat-log] .msg-stack", {
      has: page.locator("[data-item-id='user-new']"),
    });
    const newMessagePin = newMessage.locator("[data-message-pin]");
    assert.equal(await newMessagePin.isDisabled(), false);
    await newMessagePin.evaluate((button) => button.click());
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Новое закрепление");
    assert.equal(await page.locator("[data-message-pin-position]").textContent(), "1 из 3");

    await page.evaluate((pins) => window.AgentHub.setMessagePins(pins), initialPins);
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Новое закрепление");
    const committedNew = messagePin("pin-new", "message:v1:new", "Новое закрепление");
    committedNew.role = "user";
    committedNew.author = "Вы";
    const committedPins = [committedNew, ...initialPins];
    await page.evaluate((pins) => window.AgentHub.setMessagePins(pins), committedPins);
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Новое закрепление");
    const pinIntent = await page.evaluate(() => window.__messagePinIntents.at(-1));
    await page.evaluate(({ mutationId, pins }) => {
      window.AgentHub.completeMessagePinMutation(mutationId, { messagePins: pins });
    }, { mutationId: pinIntent.mutationId, pins: committedPins });
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Новое закрепление");
    assert.equal(await page.locator("[data-message-pin-position]").textContent(), "1 из 3");

    await page.evaluate((pins) => {
      window.AgentHub.setMessagePins([]);
      window.AgentHub.setMessagePins(pins);
    }, [pinA, pinB, pinC]);
    await page.locator("[data-message-pin-next]").click();
    await page.locator("[data-message-pins-open]").click();
    await page.locator("[data-message-pin-remove='pin-b']").click();
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Закрепление C");
    assert.equal(await page.locator("[data-message-pin-position]").textContent(), "2 из 2");
    const middleIntent = await page.evaluate(() => window.__messagePinIntents.at(-1));
    await page.evaluate(({ mutationId, pins }) => {
      window.AgentHub.completeMessagePinMutation(mutationId, { messagePins: pins });
    }, { mutationId: middleIntent.mutationId, pins: [pinA, pinC] });
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Закрепление C");
    await page.locator("[data-message-pins-close]").click();

    await page.evaluate((pins) => {
      window.AgentHub.setMessagePins([]);
      window.AgentHub.setMessagePins(pins);
    }, [pinA, pinB, pinC]);
    await page.locator("[data-message-pin-previous]").click();
    await page.locator("[data-message-pins-open]").click();
    await page.locator("[data-message-pin-remove='pin-c']").click();
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Закрепление B");
    assert.equal(await page.locator("[data-message-pin-position]").textContent(), "2 из 2");
    const lastIntent = await page.evaluate(() => window.__messagePinIntents.at(-1));
    await page.evaluate(({ mutationId, pins }) => {
      window.AgentHub.completeMessagePinMutation(mutationId, { messagePins: pins });
    }, { mutationId: lastIntent.mutationId, pins: [pinA, pinB] });
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Закрепление B");
    await page.locator("[data-message-pins-close]").click();

    await page.evaluate((pins) => {
      window.AgentHub.setMessagePins([]);
      window.AgentHub.setMessagePins(pins);
    }, [pinA, pinB, pinC]);
    await page.locator("[data-message-pin-next]").click();
    await page.locator("[data-message-pins-open]").click();
    await page.locator("[data-message-pin-remove='pin-b']").click();
    const rollbackIntent = await page.evaluate(() => window.__messagePinIntents.at(-1));
    await page.evaluate((mutationId) => {
      window.AgentHub.completeMessagePinMutation(mutationId, { error: "Не удалось открепить" });
    }, rollbackIntent.mutationId);
    assert.equal(await page.locator("[data-message-pin-id]").count(), 3);
    assert.equal(await page.locator("[data-message-pin-current] .message-pin-current-preview").textContent(), "Закрепление B");
    assert.equal(await page.locator("[data-message-pin-position]").textContent(), "2 из 3");
  } finally {
    await browser.close();
  }
});
