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

function navigationTask({
  streamId = "stream-1",
  threadId = "thread-current",
  selected = streamId === "stream-1",
  running = false,
} = {}) {
  return {
    provider: "codex",
    threadId,
    streamId,
    workspaceId: "workspace-1",
    workspaceName: "Agent Hub",
    streamName: streamId === "stream-1" ? "Диалоги" : "Релиз-менеджер",
    title: streamId === "stream-1" ? "Диалоги" : "Релиз-менеджер",
    displayTitle: streamId === "stream-1" ? "Диалоги" : "Релиз-менеджер",
    selected,
    running,
    ...(running ? { run: { executionOwner: "vscode" } } : {}),
    lastAnswerAt: "2026-09-08T07:00:00.000Z",
  };
}

function navigationSnapshot({ version = "snapshot-1", pinAvailable = true, pinPresent = true, running = false } = {}) {
  const pin = {
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
    available: pinAvailable,
  };
  return {
    version,
    tasks: [
      navigationTask({ running }),
      navigationTask({ streamId: "stream-2", threadId: "thread-other", selected: false }),
    ],
    workspaces: [{
      id: "workspace-1",
      name: "Agent Hub",
      streams: [
        {
          id: "stream-1",
          name: "Диалоги",
          threads: [{ provider: "codex", threadId: "thread-current" }],
        },
        {
          id: "stream-2",
          name: "Релиз-менеджер",
          threads: [{ provider: "codex", threadId: "thread-other" }],
        },
      ],
    }],
    messagePins: pinPresent ? [pin] : [],
    settings: {},
    selected: {
      provider: "codex",
      threadId: "thread-current",
      streamId: "stream-1",
    },
  };
}

function navigationHistory({ streamId = "stream-1", threadId = "thread-current" } = {}) {
  const start = 80;
  const items = Array.from({ length: 20 }, (_, offset) => {
    const index = start + offset;
    return {
      id: `${streamId}-turn-${index}`,
      provider: "codex",
      threadId,
      completed: true,
      status: "completed",
      terminalRevision: 1,
      startedAt: `2026-09-08T06:${String(index % 60).padStart(2, "0")}:00.000Z`,
      completedAt: `2026-09-08T06:${String(index % 60).padStart(2, "0")}:30.000Z`,
      messages: [{
        itemId: `${streamId}-answer-${index}`,
        messageKey: `message:v1:${streamId}:${index}`,
        pinEligible: true,
        role: "agent",
        text: `Ответ ${streamId} ${index}\n\n${"Контекст строки. ".repeat(18)}`,
      }],
    };
  });
  return {
    provider: "codex",
    threadId,
    streamId,
    start,
    end: start + items.length,
    total: 100,
    messageTotal: 100,
    nextBefore: String(start),
    version: `history-current:${streamId}`,
    items,
  };
}

function navigationFocusedTurn() {
  return {
    provider: "codex",
    taskThreadId: "thread-current",
    turnThreadId: "thread-current",
    turnId: "turn-target",
    status: "completed",
    startedAt: "2026-09-08T06:30:00.000Z",
    completedAt: "2026-09-08T06:30:30.000Z",
    messages: [{
      itemId: "answer-target",
      messageKey: "message:v1:target",
      pinEligible: true,
      role: "agent",
      text: `Точное закреплённое сообщение\n\n${"Контекст строки. ".repeat(18)}`,
      time: "2026-09-08T06:30:30.000Z",
    }],
    focusItemId: "answer-target",
  };
}

async function openProductionNavigationUi(page, { surface = "web", delayInitialHistory = false } = {}) {
  let snapshot = navigationSnapshot();
  const actions = [];
  const requests = [];
  const pageErrors = [];
  let initialHistoryDelayed = false;
  let releaseInitialHistory;
  let markInitialHistoryStarted;
  const initialHistoryGate = new Promise((resolve) => { releaseInitialHistory = resolve; });
  const initialHistoryStarted = new Promise((resolve) => { markInitialHistoryStarted = resolve; });
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
      const params = body.params ?? {};
      actions.push(body.action);
      requests.push(body);
      let result = {};
      if (body.action === "open-task") {
        const other = params.streamId === "stream-2";
        result = {
          snapshot,
          history: navigationHistory(other
            ? { streamId: "stream-2", threadId: "thread-other" }
            : undefined),
        };
      } else if (body.action === "open-turn") {
        result = {
          snapshot,
          history: navigationHistory(),
          focusedTurn: navigationFocusedTurn(),
          focusedMessage: { turnId: "turn-target", itemId: "answer-target", role: "agent" },
        };
      } else if (body.action === "task-history") {
        if (delayInitialHistory && params.streamId === "stream-1" && !initialHistoryDelayed) {
          initialHistoryDelayed = true;
          markInitialHistoryStarted();
          await initialHistoryGate;
        }
        result = delayInitialHistory
          ? navigationHistory(params.streamId === "stream-2"
            ? { streamId: "stream-2", threadId: "thread-other" }
            : undefined)
          : {
            provider: "codex",
            threadId: params.threadId,
            streamId: params.streamId,
            notModified: true,
            version: `history-current:${params.streamId}`,
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
  if (delayInitialHistory) {
    try {
      await Promise.race([
        initialHistoryStarted,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`initial task-history did not start: ${JSON.stringify(requests)}`)),
          5_000,
        )),
      ]);
    } catch (error) {
      releaseInitialHistory();
      throw error;
    }
  }
  return {
    actions,
    requests,
    releaseInitialHistory: () => releaseInitialHistory(),
    setSnapshot(next) {
      snapshot = next;
    },
  };
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
      const { actions } = await openProductionNavigationUi(page, { surface: surface.surface });
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

test("production pin navigation survives stale and fresh history until an explicit return", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  const surfaces = [
    { surface: "web", viewport: { width: 1280, height: 800 } },
    { surface: "vscode", viewport: { width: 720, height: 900 } },
    { surface: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  ].filter((scenario) => !process.env.AGENT_HUB_TEST_SURFACE
    || process.env.AGENT_HUB_TEST_SURFACE === scenario.surface);
  const targetPosition = (page) => page.evaluate(() => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const target = document.querySelector("[data-chat-log] [data-item-id='answer-target']");
    return {
      scrollTop: scroll.scrollTop,
      top: target?.getBoundingClientRect().top ?? null,
    };
  });
  const refreshOpenStreamWith = async (page, controller, snapshot) => {
    controller.setSnapshot(snapshot);
    // Refresh this still-open focused window. Ordinary Stream replacement
    // legitimately releases a closed column's history (ADR-HUB-343).
    const response = page.waitForResponse((candidate) => {
      if (!candidate.url().endsWith("/api/control")) return false;
      const body = candidate.request().postDataJSON();
      return body?.action === "open-task" && body?.params?.streamId === "stream-1";
    });
    await page.locator(".stream-tabs-track [data-stream-tab-id='stream-1']").evaluate((button) => button.click());
    await response;
  };
  try {
    for (const scenario of surfaces) {
      const page = await browser.newPage({
        viewport: scenario.viewport,
        deviceScaleFactor: scenario.deviceScaleFactor ?? 1,
      });
      page.setDefaultTimeout(5_000);
      const controller = await openProductionNavigationUi(page, {
        surface: scenario.surface,
        delayInitialHistory: true,
      });

      await page.locator("[data-message-pin-current]").evaluate((button) => button.click());
      const target = page.locator("[data-chat-log] [data-item-id='answer-target']");
      await target.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.activeElement?.dataset?.itemId === "answer-target");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(
        () => requestAnimationFrame(resolve),
      )));
      const focusedPosition = await targetPosition(page);

      const staleHistoryResponse = page.waitForResponse((candidate) => {
        if (!candidate.url().endsWith("/api/control")) return false;
        const body = candidate.request().postDataJSON();
        return body?.action === "task-history" && body?.params?.streamId === "stream-1";
      });
      controller.releaseInitialHistory();
      await staleHistoryResponse;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(
        () => requestAnimationFrame(resolve),
      )));
      assert.equal(await target.isVisible(), true);
      const afterStale = await targetPosition(page);
      assert.ok(Math.abs(afterStale.scrollTop - focusedPosition.scrollTop) <= 2);
      assert.ok(Math.abs(afterStale.top - focusedPosition.top) <= 2);

      const freshHistoryResponse = page.waitForResponse((candidate) => {
        if (!candidate.url().endsWith("/api/control")) return false;
        const body = candidate.request().postDataJSON();
        return body?.action === "open-task" && body?.params?.streamId === "stream-1";
      });
      try {
        await Promise.all([
          freshHistoryResponse,
          refreshOpenStreamWith(page, controller, navigationSnapshot({ version: "snapshot-2" })),
        ]);
      } catch (error) {
        throw new Error(`${error.message}; requests=${JSON.stringify(controller.requests)}`);
      }
      await page.waitForTimeout(80);
      assert.equal(await target.isVisible(), true);

      await page.locator("[data-message-pin-current]").evaluate((button) => button.click());
      await page.waitForFunction(() => document.activeElement?.dataset?.itemId === "answer-target");
      assert.equal(await target.getAttribute("data-pin-highlight"), "");

      const returnBottom = page.locator("[data-chat-scroll-down]");
      await returnBottom.evaluate((button) => button.click());
      await page.waitForFunction(() => !document.querySelector("[data-chat-log] [data-item-id='answer-target']"));
      assert.equal(await page.locator("[data-chat-log] [data-item-id='stream-1-answer-99']").isVisible(), true);

      await page.locator("[data-message-pin-current]").evaluate((button) => button.click());
      await target.waitFor({ state: "visible" });
      await refreshOpenStreamWith(page, controller, navigationSnapshot({
        version: "snapshot-3",
        pinAvailable: false,
      }));
      await page.waitForFunction(() => !document.querySelector("[data-chat-log] [data-item-id='answer-target']"));
      assert.equal(await page.locator("[data-message-pin-current]").isDisabled(), true);

      await refreshOpenStreamWith(page, controller, navigationSnapshot({ version: "snapshot-4" }));
      await page.locator("[data-message-pin-current]").evaluate((button) => button.click());
      await target.waitFor({ state: "visible" });
      await refreshOpenStreamWith(page, controller, navigationSnapshot({ version: "snapshot-5", pinPresent: false }));
      await page.waitForFunction(() => !document.querySelector("[data-chat-log] [data-item-id='answer-target']"));
      assert.equal(await page.locator("[data-message-pin-shelf]").isHidden(), true);
      await page.close();
    }
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
