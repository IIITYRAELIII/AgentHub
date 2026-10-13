import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const assets = new URL("../../assets/web-app/", import.meta.url);
const captures = new URL("../../WIP/mobile-dialogs-captures/", import.meta.url);
const tasks = [
  { id: "a1", workspaceId: "a", workspaceName: "AgentHub", streamId: "s1", streamName: "Дизайн",
    provider: "codex", agentLabel: "Codex", modelLabel: "GPT-5.6-Sol", selected: true, running: true,
    lastAnswer: "Собери релиз-ноты по задачам спринта: что добавили, что починили и на что обратить внимание.",
    lastActivity: "2026-10-14T10:24:00Z", context: { percent: 86, usedTokens: 86000, modelContextWindow: 100000 },
    branch: "main", runtimeLabel: "LOCAL", workspaceSettings: { catalogFolder: "РАБОТА" } },
  { id: "a2", workspaceId: "a", workspaceName: "AgentHub", streamId: "s2", streamName: "Диалоги",
    provider: "codex", agentLabel: "Codex", modelLabel: "GPT-5.6-Sol", unread: true,
    lastAnswer: "Точный закреплённый ответ готов к использованию.", lastActivity: "2026-10-14T08:52:00Z",
    workspaceSettings: { catalogFolder: "РАБОТА" } },
  { id: "b1", workspaceId: "b", workspaceName: "Utilities", streamId: "s3", streamName: "Sync",
    provider: "claude", agentLabel: "Claude", modelLabel: "Sonnet", lastAnswer: "Другой Workspace",
    workspaceSettings: { catalogFolder: "РАБОТА" } },
];

async function open(page, { vscode = false, transport = null, seed = true } = {}) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((vscode) => { if (vscode) window.__agentHubVscode = true; }, vscode);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/api/snapshot" && transport) return route.fulfill({
      contentType: "application/json", body: JSON.stringify(transport.snapshot()),
    });
    if (url.pathname === "/api/control" && transport) return route.fulfill({
      contentType: "application/json", body: JSON.stringify(await transport.control(route.request().postDataJSON())),
    });
    if (url.pathname === "/") {
      let body = await readFile(new URL("index.html", assets), "utf8");
      body = body.replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/gu, "");
      if (!transport) body = body.replace(/\s*<script src="\/hub-client\.js" defer><\/script>/gu, "");
      body = body.replace("</head>", '<script type="application/json" data-theme-catalog>[{"id":"orbit","name":"Orbit","color":"#080b11","aliases":[],"assets":{},"backgrounds":[{"id":"none","name":"Нет","assetUrl":"","preload":false}]}]</script></head>');
      return route.fulfill({ contentType: "text/html; charset=utf-8", body });
    }
    try {
      const relative = url.pathname.replace(/^\//u, "");
      const body = await readFile(relative === "work-log.css" ? new URL("../../work-log.css", import.meta.url) : new URL(relative, assets));
      return route.fulfill({ contentType: /\.css$/u.test(relative) ? "text/css" : /\.(js|mjs)$/u.test(relative) ? "text/javascript" : "image/png", body });
    } catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("https://agent-hub.test/");
  await page.waitForFunction(() => window.AgentHub && window.AgentHubMobileDialogs);
  if (transport || !seed) return errors;
  await page.evaluate((tasks) => {
    window.testIntents = [];
    document.addEventListener("agenthub:intent", (event) => window.testIntents.push(event.detail));
    AgentHub.setWorkspaces([
      { id: "a", name: "AgentHub", settings: { catalogFolder: "РАБОТА" }, streams: [] },
      { id: "b", name: "Utilities", settings: { catalogFolder: "РАБОТА" }, streams: [] },
    ]);
    AgentHub.setTasks(tasks);
    AgentHub.setMessages("a1", [
      { id: "u1", role: "user", author: "Вы", messageKey: "message:user-1", pinEligible: true,
        text: "Собери релиз-ноты по задачам спринта", time: "2026-10-14T14:52:00Z" },
      { id: "r1", role: "agent", author: "Codex", messageKey: "message:final-1", pinEligible: true,
        text: "Точный закреплённый ответ\n\n## Что добавили\n- Новый экран настроек окружения\n- Улучшения в поиске по диалогам", time: "2026-10-14T15:00:00Z" },
    ]);
    AgentHub.setSelection({ quickMessages: { global: [
      { title: "продолжай", text: "продолжай" }, { title: "исправь", text: "исправь" },
    ], workspaces: {}, streams: {} } });
    AgentHub.setMessagePins([{ id: "pin-1", streamId: "s1", messageKey: "message:final-1",
      provider: "codex", taskThreadId: "t1", turnThreadId: "t1", turnId: "turn-1", itemId: "r1",
      role: "agent", preview: "Точный закреплённый ответ", available: true }]);
    AgentHub.setConnection("online");
  }, tasks);
  return errors;
}

test("Mobile dialogs scope, modal navigation, Back, drafts and responsive parity", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
  await mkdir(captures, { recursive: true });
  try {
    for (const width of [320, 360, 390, 430]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const errors = await open(page);
      assert.equal(await page.locator("html").getAttribute("data-mobile-dialogs-enabled"), "");
      assert.deepEqual(await page.locator('[data-mobile-stream-list] h2').allTextContents(), ["Все потоки"]);
      assert.equal(await page.locator('[data-mobile-stream-list] [data-mobile-stream-id="s3"]').count(), 0);
      await page.screenshot({ path: path.join(captures.pathname.replace(/^\/(?:([A-Z]:))/u, "$1"), `list-${width}.png`) });
      await page.locator("[data-mobile-workspaces-open]").click();
      assert.equal(await page.locator("[data-mobile-workspace-drawer]").evaluate((d) => d.open), true);
      assert.equal(await page.locator('[data-mobile-workspace-action="workspace-new"]').isVisible(), true);
      if (width === 390) await page.screenshot({ path: new URL("drawer-390.png", captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
      await page.locator('[data-workspace-select="b"] .task-workspace-name').click();
      assert.equal(await page.locator('[data-mobile-stream-list] [data-mobile-stream-id="s1"]').count(), 0);
      assert.equal(await page.locator('[data-mobile-stream-list] [data-mobile-stream-id="s3"]').count(), 1);
      await page.locator("[data-mobile-workspaces-open]").click();
      await page.locator('[data-workspace-select="a"] .task-workspace-name').click();
      await page.locator('[data-mobile-stream-list] [data-mobile-stream-id="s1"]').first().click();
      assert.equal(await page.locator("html").getAttribute("data-mobile-conversation"), "");
      assert.equal(await page.locator("[data-stream-tabs]").isVisible(), false);
      assert.equal(await page.locator("[data-composer-input]").isVisible(), true);
      assert.equal(await page.locator("[data-context-usage]").isVisible(), true);
      await page.locator("[data-context-usage]").click();
      assert.equal(await page.locator("[data-context-usage-modal]").evaluate((node) => node.matches(":modal") && node.scrollWidth <= node.clientWidth), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("[data-context-usage]").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("[data-context-usage]").evaluate((node) => document.activeElement === node), true);
      assert.equal(await page.locator('[data-composer-quick-messages]').isVisible(), true);
      await page.locator("[data-composer-input]").fill("Черновик сохраняется");
      if (width === 390) await page.screenshot({ path: new URL("stream-390.png", captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
      await page.locator("[data-mobile-stream-switch]").click();
      assert.equal(await page.locator('[data-mobile-stream-switcher] [data-mobile-stream-id="s3"]').count(), 0);
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => !document.querySelector("[data-mobile-stream-switcher]").open);
      assert.equal(await page.locator("html").getAttribute("data-mobile-conversation"), "");
      await page.locator("[data-mobile-conversation-back]").click();
      await page.locator('[data-mobile-stream-list] [data-mobile-stream-id="s1"]').first().click();
      assert.equal(await page.locator("[data-composer-input]").inputValue(), "Черновик сохраняется");
      await page.locator('[data-mobile-dialogs-tab="more"]').click();
      assert.deepEqual(await page.locator(".mobile-more-entry span").allTextContents(), ["Статистика", "Оформление", "Сервер", "Настройки AgentHub"]);
      if (width === 390) await page.screenshot({ path: new URL("more-390.png", captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => !document.querySelector("[data-mobile-more-sheet]").open);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator("[data-dialog-settings-toggle]").click();
      assert.equal(await page.locator("[data-dialog-settings]").evaluate((d) => d.open), true);
      await page.evaluate(() => AgentHub.navigateBack());
      await page.waitForFunction(() => !document.querySelector("[data-dialog-settings]").open);
      assert.equal(await page.locator("html").getAttribute("data-mobile-conversation"), "");
      await page.locator("[data-context-usage]").click();
      await page.evaluate(() => AgentHub.navigateBack());
      assert.equal(await page.locator("[data-context-usage-modal]").evaluate((d) => d.open), false);
      await page.evaluate(() => AgentHub.navigateBack());
      assert.equal(await page.locator("html").getAttribute("data-mobile-conversation"), null);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test("mobile parity paths expose Workspace/archive, Stream actions and readable core glyphs", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const save = async (name) => page.screenshot({ path: new URL(name, captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
  try {
    const errors = await open(page);
    await page.evaluate(() => AgentHub.setArchivedWorkspaces([
      { id: "archived", name: "Архивный Workspace", kind: "user", streams: [] },
    ]));
    await page.locator("[data-mobile-workspaces-open]").click();
    assert.match(await page.locator('[data-mobile-workspace-action="workspace-archive-open"]').innerText(), /\(1\)/u);
    await save("drawer-parity-390.png");
    await page.locator('[data-workspace-select="a"] [data-mobile-workspace-menu]').click();
    await save("workspace-menu-390.png");
    await page.getByRole("menuitem", { name: "Редактировать…", exact: true }).click();
    assert.equal(await page.locator("[data-workspace-card-modal]").evaluate((d) => d.open), true);
    await page.evaluate(() => AgentHub.navigateBack());
    await page.waitForFunction(() => document.querySelector("[data-mobile-workspace-drawer]").open);
    assert.equal(await page.locator('[data-workspace-select="a"] [data-mobile-workspace-menu]').evaluate((node) => document.activeElement === node), true);
    await page.locator('[data-workspace-folder-kind="folder"] [data-mobile-folder-menu]').click();
    await save("folder-menu-390.png");
    await page.evaluate(() => AgentHub.navigateBack());
    await page.waitForFunction(() => document.querySelector("[data-mobile-workspace-drawer]").open);
    assert.equal(await page.locator('[data-workspace-folder-kind="folder"] [data-mobile-folder-menu]').evaluate((node) => document.activeElement === node), true);
    await page.locator('[data-workspace-folder-kind="folder"] [data-mobile-folder-menu]').click();
    await page.getByRole("menuitem", { name: "Переименовать папку…", exact: true }).click();
    assert.equal(await page.locator("[data-text-dialog]").isVisible(), true);
    await page.evaluate(() => AgentHub.navigateBack());
    await page.waitForFunction(() => document.querySelector("[data-mobile-workspace-drawer]").open);
    assert.equal(await page.locator('[data-workspace-folder-kind="folder"] [data-mobile-folder-menu]').evaluate((node) => document.activeElement === node), true);
    await page.locator('[data-mobile-workspace-action="workspace-archive-open"]').click();
    assert.equal(await page.getByRole("button", { name: "Восстановить", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Удалить окончательно", exact: true }).isVisible(), true);
    await save("archive-390.png");
    await page.evaluate(() => AgentHub.navigateBack());
    await page.locator('[data-mobile-stream-list] [data-mobile-stream-id="s1"]').first().click();
    await page.locator("[data-mobile-stream-switch]").click();
    await save("switcher-390.png");
    await page.evaluate(() => AgentHub.navigateBack());
    await page.locator("[data-dialog-settings-toggle]").click();
    for (const selector of ["[data-stream-card-pin]", "[data-stream-card-workspace]",
      "[data-stream-card-rotate]", "[data-stream-card-continue-provider]", "[data-stream-card-move]", "[data-stream-card-archive]"]) {
      assert.equal(await page.locator(selector).isVisible(), true, selector);
    }
    await save("stream-actions-390.png");
    await page.evaluate(() => AgentHub.navigateBack());
    await page.locator("[data-context-usage]").click();
    const contextLayout = await page.locator("[data-context-usage-modal]").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const header = node.querySelector("header").getBoundingClientRect();
      const section = node.querySelector("section").getBoundingClientRect();
      const footer = node.querySelector("footer").getBoundingClientRect();
      return { modal: node.matches(":modal"), opaque: getComputedStyle(node).backgroundColor,
        withinViewport: rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
        ordered: header.bottom <= section.top && section.bottom <= footer.top,
        action: node.querySelector("[data-context-usage-compact]").textContent,
        footerTargets: [...node.querySelectorAll("footer button")].map((b) => b.getBoundingClientRect().height) };
    });
    assert.equal(contextLayout.modal, true);
    assert.equal(contextLayout.ordered, true, JSON.stringify(contextLayout));
    assert.equal(contextLayout.withinViewport, true);
    assert.match(contextLayout.opaque, /^rgb\(/u);
    assert.equal(contextLayout.action, "Свернуть контекст");
    assert.ok(contextLayout.footerTargets.every((height) => height >= 44));
    await save("context-390.png");
    await page.evaluate(() => AgentHub.navigateBack());
    assert.equal(await page.locator('[data-message-pin]').count(), 2);
    assert.equal(await page.locator('[data-message-edit]').isVisible(), true);
    assert.equal(await page.locator('[data-message-repeat]').isVisible(), true);
    await save("message-actions-390.png");
    const metrics = await page.evaluate(() => {
      const selected = ["[data-composer-send]", "[data-chat-stop]", "[data-context-usage]",
        "[data-mobile-conversation-back]", "[data-mobile-stream-switch]", ".composer-slash", ".composer-attach"];
      return selected.map((selector) => {
        const node = document.querySelector(selector);
        const rect = node.getBoundingClientRect();
        const svg = node.querySelector("svg");
        return { selector, width: rect.width, height: rect.height,
          color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor,
          glyph: svg?.getAttribute("data-phosphor-icon"), glyphWidth: svg?.getBoundingClientRect().width };
      });
    });
    for (const metric of metrics) {
      assert.ok(metric.width >= 44 && metric.height >= 44, JSON.stringify(metric));
    }
    assert.ok(metrics.find((m) => m.selector === "[data-composer-send]").glyphWidth >= 22);
    assert.ok(metrics.find((m) => m.selector === "[data-chat-stop]").glyphWidth >= 22);
    const contrast = await page.evaluate(() => {
      const rgb = (value) => value.match(/[\d.]+/gu).map(Number);
      const luminance = (channels) => channels.slice(0, 3).map((c) => c / 255)
        .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const background = rgb(getComputedStyle(document.querySelector(".chat")).backgroundColor);
      return [".mobile-dialogs-nav [aria-pressed='false']", ".stream-chat-meta", ".msg-actions button"]
        .map((selector) => {
          const color = rgb(getComputedStyle(document.querySelector(selector)).color);
          const foreground = color.slice(0, 3).map((c, i) => c * (color[3] ?? 1) + background[i] * (1 - (color[3] ?? 1)));
          const a = luminance(foreground), b = luminance(background);
          return { selector, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
    });
    for (const result of contrast) assert.ok(result.ratio >= 4.5, JSON.stringify(result));
    await page.locator("[data-composer-input]").fill("Готовый prompt");
    await save("composer-enabled-390.png");
    await page.locator("[data-composer-input]").fill("");
    assert.equal(await page.locator("[data-composer-send]").isDisabled(), true);
    await save("composer-disabled-390.png");
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

test("mobile initial loading and failed-load retry keep explicit states", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    const errors = await open(page, { seed: false });
    assert.equal(await page.locator("[data-mobile-stream-list]").getAttribute("aria-busy"), "true");
    await page.screenshot({ path: new URL("loading-390.png", captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
    await page.evaluate(() => {
      window.testIntents = [];
      document.addEventListener("agenthub:intent", (event) => window.testIntents.push(event.detail));
      AgentHub.setConnection("offline");
    });
    assert.match(await page.locator("[data-mobile-stream-list]").innerText(), /Не удалось загрузить/u);
    for (const selector of [".mobile-dialogs-top", ".mobile-dialogs h1", "[data-mobile-workspace-label]", "[data-mobile-stream-filter]", "[data-mobile-workspaces-open]"]) {
      assert.equal(await page.locator(selector).isVisible(), true, selector);
    }
    await page.getByRole("button", { name: "Повторить подключение" }).click();
    assert.equal(await page.evaluate(() => window.testIntents.at(-1).type), "connection:retry");
    await page.screenshot({ path: new URL("loading-error-390.png", captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

test("real hub-client previews, creates in the chosen Workspace and restores an empty scope after reload", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const commands = [];
  const snapshot = {
    apiVersion: 3, version: "mobile-transport-1", server: { status: "online" },
    tasks: tasks.map((task) => ({ ...task, threadId: `thread-${task.streamId}`, lastAnswerAt: task.lastActivity })),
    workspaces: [
      { id: "a", name: "AgentHub", streams: [
        { id: "s1", name: "Дизайн", threads: [{ provider: "codex", threadId: "thread-s1" }] },
        { id: "s2", name: "Диалоги", threads: [{ provider: "codex", threadId: "thread-s2" }] },
      ] },
      { id: "b", name: "Utilities", streams: [
        { id: "s3", name: "Sync", threads: [{ provider: "claude", threadId: "thread-s3" }] },
      ] },
      { id: "empty", name: "Пустой Workspace", streams: [] },
    ],
    archivedWorkspaces: [], boardTasks: [], deferredInputs: [], messageReceipts: [], pendingApprovals: [],
    selected: { streamId: "s1", provider: "codex", threadId: "thread-s1" },
    settings: { provider: "codex", model: "gpt-5.6-sol", modelOptionsByProvider: {}, models: [],
      reasoningOptions: [], reasoningOptionsByProvider: {}, modeOptions: [],
      quickMessages: { global: [], streams: {}, workspaces: {} } },
  };
  try {
    const errors = await open(page, { transport: {
      snapshot: () => snapshot,
      control: async (request) => {
        commands.push(request);
        if (request.action === "create-stream") {
          snapshot.workspaces[0].streams.push({ id: "s-new", name: "Новый Stream", threads: [] });
          snapshot.version = "mobile-transport-2";
          return { ok: true, result: { ...snapshot, createdStream: { id: "s-new" } } };
        }
        return { ok: true, result: snapshot };
      },
    } });
    await page.waitForFunction(() => document.querySelector('[data-mobile-stream-id="s1"]'));
    assert.match(await page.locator('[data-mobile-stream-list]').innerText(), /Собери релиз-ноты/u);
    await page.locator("[data-mobile-stream-create]").click();
    await page.waitForFunction(() => document.querySelector("[data-dialog-settings]").open);
    assert.equal(commands.filter((request) => request.action === "create-stream").length, 1);
    assert.equal(commands.find((request) => request.action === "create-stream").params.workspaceId, "a");
    assert.equal(await page.locator("html").getAttribute("data-mobile-conversation"), "");
    await page.evaluate(() => AgentHub.navigateBack());
    await page.locator("[data-mobile-conversation-back]").click();
    await page.locator("[data-mobile-workspaces-open]").click();
    await page.locator('[data-workspace-select="empty"] .task-workspace-name').click();
    await page.reload();
    await page.waitForFunction(() => document.querySelector("[data-mobile-workspace-label]")?.textContent === "Пустой Workspace");
    assert.equal(await page.locator('[data-mobile-stream-list] [data-mobile-stream-id]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

test("Desktop and narrow VS Code host retain existing navigation and composer", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
  try {
    for (const [width, vscode] of [[1280, false], [520, true], [390, true]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = await open(page, { vscode });
      assert.equal(await page.locator("html").getAttribute("data-mobile-dialogs-enabled"), null);
      assert.equal(await page.locator("[data-task-rail]").evaluate((rail) => rail.parentElement.matches("[data-workspace]")), true);
      assert.equal(await page.locator("[data-mobile-dialogs-nav]").isVisible(), false);
      assert.equal(await page.locator("[data-mobile-stream-switch]").isVisible(), false);
      assert.equal(await page.locator("[data-mobile-conversation-back]").isVisible(), false);
      await page.evaluate(() => AgentHub.showSelectedTask());
      assert.equal(await page.locator("[data-composer-input]").isVisible(), true);
      await page.screenshot({ path: new URL(`host-${vscode ? "webview" : "web"}-${width}.png`, captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test("Mobile empty scope, long names, offline retry, focus containment and viewport height", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    const errors = await open(page);
    await page.evaluate(() => {
      AgentHub.setWorkspaces([
        { id: "a", name: "AgentHub", settings: {}, streams: [] },
        { id: "empty", name: "Пустой Workspace с очень длинным названием без потери доступа к меню", streams: [] },
      ]);
      AgentHub.patchTask("a1", { streamName: "Очень длинный Stream с названием, которое должно уместиться на узком экране" });
    });
    await page.screenshot({ path: new URL("long-320.png", captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
    await page.locator("[data-mobile-workspaces-open]").click();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.closest("[data-mobile-workspace-drawer]") !== null), true);
    await page.locator('[data-workspace-select="empty"] .task-workspace-name').click();
    assert.match(await page.locator("[data-mobile-stream-list]").innerText(), /пока нет Stream/u);
    await page.locator("[data-mobile-stream-create]").click();
    assert.equal(await page.evaluate(() => window.testIntents.at(-1).workspaceId), "empty");
    await page.evaluate(() => AgentHub.setConnection("offline"));
    await page.getByRole("button", { name: "Повторить подключение" }).click();
    assert.equal(await page.evaluate(() => window.testIntents.at(-1).type), "connection:retry");
    await page.screenshot({ path: new URL("offline-empty-320.png", captures).pathname.replace(/^\/(?:([A-Z]:))/u, "$1") });
    await page.locator("[data-mobile-stream-filter]").fill("missing");
    assert.match(await page.locator("[data-mobile-stream-list]").innerText(), /Ничего не найдено/u);
    await page.locator("[data-mobile-workspaces-open]").click();
    // Backdrop pointerdown closes the exact modal and returns focus.
    await page.mouse.click(315, 300);
    assert.equal(await page.locator("[data-mobile-workspace-drawer]").evaluate((d) => d.open), false);
    await page.evaluate(() => { AgentHub.selectTask("a1"); AgentHub.showSelectedTask(); });
    await page.setViewportSize({ width: 320, height: 450 });
    assert.equal(await page.locator("[data-composer-input]").isVisible(), true);
    assert.equal(await page.locator("[data-composer-send]").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});
