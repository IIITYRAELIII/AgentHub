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
