import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const assets = new URL("../../assets/web-app/", import.meta.url);
const captures = new URL("../../WIP/mobile-dialogs-captures/", import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = createRequire(import.meta.url)("../../theme-registry.cjs");
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

async function open(page, { vscode = false, transport = null, seed = true, themeRegistry = null } = {}) {
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
      if (themeRegistry) body = renderThemeHtml(body, themeRegistry);
      else body = body.replace("</head>", '<script type="application/json" data-theme-catalog>[{"id":"orbit","name":"Orbit","color":"#080b11","aliases":[],"assets":{},"backgrounds":[{"id":"none","name":"Нет","assetUrl":"","preload":false}]}]</script></head>');
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

async function drawerContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const values = [...context.getImageData(0, 0, 1, 1).data]; values[3] /= 255; return values;
    };
    const over = (a, b) => [...a.slice(0, 3).map((c, i) => c * a[3] + b[i] * (1 - a[3])), 1];
    const bg = (node) => {
      if (!node) return rgba(getComputedStyle(document.documentElement).getPropertyValue("--bg"));
      const color = rgba(getComputedStyle(node).backgroundColor);
      return color[3] === 1 ? color : over(color, bg(node.parentElement));
    };
    const luminance = (channels) => channels.slice(0, 3).map((c) => c / 255)
      .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    const drawer = document.querySelector("[data-mobile-workspace-drawer]");
    const selectors = [".mobile-navigation-head strong", ".task-rail-title > span:first-child",
      ".task-count", "[data-task-filter]", ".task-workspace-name", ".task-workspace-folder-name",
      ".task-workspace-folder-count", "[data-mobile-workspace-edit]", "[data-mobile-folder-rename]",
      ".mobile-workspace-footer button", ".mobile-workspace-footer svg", ".mobile-navigation-head button", ".task-workspace-folder-glyph"];
    const results = [];
    for (const selector of selectors) for (const node of drawer.querySelectorAll(selector)) {
      if (!node.getClientRects().length || node.closest("[hidden]")) continue;
      const style = getComputedStyle(node);
      const color = rgba(style.color); color[3] *= Number(style.opacity);
      results.push({ selector, minimum: selector.includes("edit]") || selector.includes("rename]") || selector.includes("glyph") || selector.includes("svg") ? 3 : 4.5,
        foreground: style.color, background: bg(node), ratio: ratio(over(color, bg(node)), bg(node)) });
      if (node.matches("input")) {
        const placeholder = getComputedStyle(node, "::placeholder");
        const c = rgba(placeholder.color); c[3] *= Number(placeholder.opacity);
        results.push({ selector: "search-placeholder", minimum: 4.5,
          foreground: placeholder.color, background: bg(node), ratio: ratio(over(c, bg(node)), bg(node)) });
        results.push({ selector: "search-border", minimum: 3, ratio: ratio(over(rgba(style.borderTopColor), bg(node)), bg(node)) });
      }
    }
    const focused = document.activeElement;
    if (drawer.contains(focused)) {
      const s = getComputedStyle(focused);
      results.push({ selector: "focus-indicator", minimum: 3, width: parseFloat(s.outlineWidth),
        ratio: ratio(over(rgba(s.outlineColor), bg(focused)), bg(focused)) });
    }
    const selected = drawer.querySelector(".task-workspace-item[data-selected]");
    if (selected) results.push({ selector: "selected-marker", minimum: 3,
      ratio: ratio(over(rgba(getComputedStyle(selected).borderLeftColor), bg(selected)), bg(selected)) });
    const scrim = rgba(getComputedStyle(drawer, "::backdrop").backgroundColor);
    const geometry = [...drawer.querySelectorAll(".task-workspace-item, .task-workspace-folder-summary")]
      .filter((node) => node.getClientRects().length).map((node) => {
        const box = node.getBoundingClientRect(); const glyph = node.matches("summary")
          ? node.closest("[data-mobile-folder-row]")?.querySelector("[data-mobile-folder-rename]") : node.querySelector("[data-mobile-workspace-edit]");
        const button = glyph?.getBoundingClientRect(), svg = glyph?.querySelector("svg")?.getBoundingClientRect();
        const badge = node.querySelector(".task-workspace-folder-count")?.getBoundingClientRect();
        return { folder: node.matches("summary"), height: box.height,
          target: button ? [button.width, button.height] : null,
          glyph: svg ? [svg.width, svg.height] : null, badgeClear: !badge || !button || badge.right <= button.left,
          sameLine: !button || (button.top >= box.top && button.bottom <= box.bottom),
          image: getComputedStyle(node).backgroundImage, shadow: getComputedStyle(node).boxShadow };
      });
    return { results, overflow: drawer.scrollWidth - drawer.clientWidth,
      opaque: rgba(getComputedStyle(drawer).backgroundColor)[3], scrimAlpha: scrim[3],
      modal: drawer.matches(":modal"), background: getComputedStyle(drawer).backgroundColor, geometry };
  });
}

test("Mobile Workspace drawer contrast survives every shipped theme and background", async () => {
  const registry = loadThemeRegistry(fileURLToPath(assets));
  const baseline = process.env.HUB111_DRAWER_BASELINE === "1";
  const directory = new URL("../../WIP/mobile-drawer-pencil-captures/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
  const failures = [], measurements = [];
  try {
    for (const width of baseline ? [390] : [320, 360, 390, 430]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const errors = await open(page, { themeRegistry: registry });
      await page.evaluate(() => {
        const drawer = document.querySelector("[data-mobile-workspace-drawer]");
        drawer.addEventListener("beforetoggle", (event) => {
          if (event.newState !== "open") return;
          window.drawerFrameColors = [];
          const record = () => window.drawerFrameColors.push({
            drawer: getComputedStyle(drawer).backgroundColor,
            rail: getComputedStyle(drawer.querySelector(".task-rail")).backgroundColor,
            text: getComputedStyle(drawer.querySelector(".task-workspace-name")).color,
            expectedText: getComputedStyle(document.documentElement).getPropertyValue("--mobile-navigation-text").trim(),
          });
          record(); requestAnimationFrame(() => { if (drawer.open) record(); });
        });
      });
      if (!baseline) await page.evaluate((tasks) => {
        AgentHub.setWorkspaces([{ id: "a", name: "AgentHub", settings: { catalogFolder: "РАБОТА" } },
          { id: "b", name: "Utilities", settings: { catalogFolder: "РАБОТА" } },
          { id: "c", name: "Workspace с очень длинным названием для проверки строки вне папки", settings: {} }]);
        AgentHub.setTasks([...tasks, { id: "c1", streamId: "c-stream", workspaceId: "c",
          workspaceName: "Workspace с очень длинным названием для проверки строки вне папки", streamName: "Long", provider: "codex", workspaceSettings: {} }]);
      }, tasks);
      const check = async (state, theme, background) => {
        const result = await drawerContrast(page);
        measurements.push({ ...result, width, theme, backgroundId: background, state });
        if (!result.modal || result.opaque !== 1 || result.scrimAlpha < 0.5 || result.overflow > 1) failures.push({ width, theme, background, state, result });
        for (const metric of result.results) if (metric.ratio < metric.minimum || metric.width === 0) {
          failures.push({ width, theme, backgroundId: background, state, ...metric });
        }
        if (!baseline) for (const row of result.geometry) {
          if (row.height < 44 || row.height > (row.folder ? 44 : 48) || !row.sameLine || !row.badgeClear || row.target?.some((value) => value < 44)
            || row.glyph?.some((value) => value < 20 || value > 22) || row.image !== "none") failures.push({ width, theme, backgroundId: background, state, geometry: row });
        }
      };
      for (const theme of registry.themes.filter((theme) => !baseline || theme.id === "orange")) {
        await page.locator("[data-theme-select]").evaluate((select, id) => { select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); }, theme.id);
        await page.waitForFunction((id) => document.documentElement.dataset.theme === id, theme.id);
        for (const background of theme.backgrounds) {
          await page.locator("[data-background-select]").evaluate((select, id) => { select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); }, background.id);
          await page.waitForFunction((id) => document.documentElement.dataset.background === id, background.id);
          await page.locator("[data-mobile-workspaces-open]").click();
          if (!baseline) {
            await page.waitForFunction(() => window.drawerFrameColors.length >= 2);
            const frames = await page.evaluate(() => ({ samples: window.drawerFrameColors, surface: document.documentElement.dataset.surface, innerWidth }));
            assert.equal(frames.samples.every((sample) => sample.drawer === sample.rail && sample.drawer === frames.samples[0].drawer), true, JSON.stringify({ theme: theme.id, width, frames }));
          }
          await check("default-selected", theme.id, background.id);
          if (!baseline && [320, 390].includes(width) && background.id === theme.id && ["orange", "orbit"].includes(theme.id)) {
            await page.screenshot({ path: fileURLToPath(new URL(`${theme.id}-density-${width}.png`, directory)) });
          }
          await page.locator("[data-task-filter]").focus();
          await check("search-focus", theme.id, background.id);
          await page.locator('[data-workspace-select="b"]').hover();
          await check("hover", theme.id, background.id);
          await page.keyboard.press("Tab");
          await page.locator('[data-workspace-select="a"] [data-mobile-workspace-edit]').focus();
          await check("keyboard-focus", theme.id, background.id);
          if (!baseline) {
            await page.locator('[data-mobile-folder-row] [data-mobile-folder-rename]').focus();
            await check("folder-keyboard-focus", theme.id, background.id);
            await page.locator('[data-workspace-select="a"] [data-mobile-workspace-edit]').click();
            await check("workspace-edit", theme.id, background.id);
            assert.equal(await page.locator("[data-mobile-workspace-drawer]").evaluate((d) => d.open), true);
            await page.keyboard.press("Escape");
            await page.waitForFunction(() => !document.querySelector("[data-workspace-card-modal]").open);
            await page.waitForFunction(() => document.activeElement?.matches('[data-workspace-select="a"] [data-mobile-workspace-edit]'));
            assert.equal(await page.locator('[data-workspace-select="a"] [data-mobile-workspace-edit]').evaluate((n) => document.activeElement === n), true);
            await page.locator('[data-mobile-folder-row] [data-mobile-folder-rename]').click();
            await check("folder-rename", theme.id, background.id);
            await page.evaluate(() => AgentHub.navigateBack());
            await page.waitForFunction(() => !document.querySelector("[data-mobile-drawer-rename]").open && document.activeElement?.matches('[data-mobile-folder-rename]'));
            assert.equal(await page.locator("[data-mobile-workspace-drawer]").evaluate((d) => d.open), true);
            assert.equal(await page.locator('[data-mobile-folder-row] [data-mobile-folder-rename]').evaluate((n) => document.activeElement === n), true);
          }
          if (width === 390 && background.id === theme.id && ["orange", "orbit"].includes(theme.id)) {
            await page.screenshot({ path: fileURLToPath(new URL(`${theme.id}-${baseline ? "before" : "after"}-390.png`, directory)) });
          }
          await page.keyboard.press("Escape");
        }
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
  await writeFile(new URL(baseline ? "before-matrix.json" : "contrast-matrix.json", directory), JSON.stringify({ measurements, failures }, null, 2));
  assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 12)));
});

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
    await page.locator('[data-workspace-select="a"] [data-mobile-workspace-edit]').click();
    await save("workspace-edit-390.png");
    assert.equal(await page.locator("[data-workspace-card-modal]").evaluate((d) => d.open), true);
    await page.evaluate(() => AgentHub.navigateBack());
    await page.waitForFunction(() => !document.querySelector("[data-workspace-card-modal]").open && document.activeElement?.matches('[data-mobile-workspace-edit]'));
    assert.equal(await page.locator('[data-workspace-select="a"] [data-mobile-workspace-edit]').evaluate((node) => document.activeElement === node), true);
    await page.locator('[data-mobile-folder-row] [data-mobile-folder-rename]').click();
    await save("folder-rename-390.png");
    await page.evaluate(() => AgentHub.navigateBack());
    await page.waitForFunction(() => !document.querySelector("[data-mobile-drawer-rename]").open && document.activeElement?.matches('[data-mobile-folder-rename]'));
    assert.equal(await page.locator('[data-mobile-folder-row] [data-mobile-folder-rename]').evaluate((node) => document.activeElement === node), true);
    await page.locator('[data-mobile-folder-row] [data-mobile-folder-rename]').click();
    assert.equal(await page.locator("[data-text-dialog]").isVisible(), true);
    await page.evaluate(() => AgentHub.navigateBack());
    await page.waitForFunction(() => !document.querySelector("[data-mobile-drawer-rename]").open && document.activeElement?.matches('[data-mobile-folder-rename]'));
    assert.equal(await page.locator('[data-mobile-folder-row] [data-mobile-folder-rename]').evaluate((node) => document.activeElement === node), true);
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

test("drawer pencils open existing edit and rename directly without selecting or collapsing", async () => {
  const registry = loadThemeRegistry(fileURLToPath(assets));
  const directory = new URL("../../WIP/mobile-drawer-pencil-captures/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
  try {
    for (const width of [320, 360, 390, 430]) for (const theme of ["orange", "orbit"]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true,
        colorScheme: theme === "orange" ? "light" : "dark" });
      const page = await context.newPage();
      const errors = await open(page, { themeRegistry: registry });
      await page.locator("[data-theme-select]").evaluate((select, id) => { select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); }, theme);
      await page.evaluate(() => {
        window.drawerClosedCount = 0;
        document.querySelector("[data-mobile-workspace-drawer]").addEventListener("close", () => window.drawerClosedCount++);
      });
      const save = async (state) => {
        if ([320, 390].includes(width)) await page.screenshot({ path: fileURLToPath(new URL(`${theme}-${state}-${width}.png`, directory)) });
      };
      const drawer = page.locator("[data-mobile-workspace-drawer]");
      const workspaceModal = page.locator("[data-workspace-card-modal]");
      const renameModal = page.locator("[data-mobile-drawer-rename]");
      const workspaceOpener = page.locator('[data-workspace-select="b"] [data-mobile-workspace-edit]');
      const folderOpener = page.locator('[data-mobile-folder-rename]');
      const settledFocus = async (selector) => page.waitForFunction((selector) => document.activeElement?.matches(selector)
        && !document.querySelector("[data-workspace-card-modal]").open && !document.querySelector("[data-mobile-drawer-rename]").open, selector, { timeout: 5000 })
        .catch(async (error) => { throw new Error(JSON.stringify(await page.evaluate(() => ({ focus: document.activeElement?.outerHTML,
          folders: [...document.querySelectorAll('[data-workspace-folder-kind="folder"]')].map((n) => ({ id: n.dataset.workspaceFolderName,
            label: n.querySelector('[data-mobile-folder-rename]')?.getAttribute('aria-label') })) }))), { cause: error }); });
      await page.locator("[data-mobile-workspaces-open]").click();
      await save("default");
      assert.equal(await page.locator("[data-mobile-drawer-menu], [data-mobile-workspace-menu], [data-mobile-folder-menu]").count(), 0);
      for (const [opener, name] of [[workspaceOpener, "Редактировать Workspace «Utilities»"], [folderOpener, "Переименовать папку «РАБОТА»"]]) {
        assert.equal(await opener.getAttribute("aria-label"), name);
        assert.equal(await opener.getAttribute("title"), name);
        assert.equal(await opener.getAttribute("aria-haspopup"), "dialog");
        assert.deepEqual(await opener.evaluate((n) => ({ glyph: n.querySelector("svg").dataset.phosphorIcon,
          target: [n.getBoundingClientRect().width, n.getBoundingClientRect().height],
          size: [n.querySelector("svg").getBoundingClientRect().width, n.querySelector("svg").getBoundingClientRect().height],
          nested: !!n.parentElement.closest("button, summary") })), { glyph: "pencil-simple", target: [44, 44], size: [22, 22], nested: false });
        assert.deepEqual(await opener.evaluate((n) => {
          const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
          n.dispatchEvent(menu);
          const key = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
          n.dispatchEvent(key);
          return { contextPrevented: menu.defaultPrevented, keyPrevented: key.defaultPrevented,
            customMenu: !!document.querySelector('.workspace-context-menu:not([hidden])') };
        }), { contextPrevented: false, keyPrevented: false, customMenu: false });
      }
      assert.equal(await workspaceOpener.evaluate((n) => n.parentElement.querySelector("[data-mobile-workspace-select]")?.parentElement === n.parentElement
        && n.parentElement.getAttribute("role") !== "button"), true);
      await workspaceOpener.focus(); await page.keyboard.press("Tab"); await workspaceOpener.focus();
      await save("workspace-keyboard-focus");
      await page.keyboard.press("Enter");
      assert.equal(await workspaceModal.evaluate((d) => d.matches(":modal")), true);
      assert.equal(await page.locator("[data-workspace-card-name]").inputValue(), "Utilities");
      assert.equal(await drawer.evaluate((d) => d.open), true);
      assert.equal(await page.locator('[data-workspace-select="a"] [data-mobile-workspace-select]').getAttribute("aria-pressed"), "true");
      await save("workspace-edit");
      await page.evaluate(() => history.back());
      await settledFocus('[data-workspace-select="b"] [data-mobile-workspace-edit]');
      assert.equal(await page.evaluate(() => window.drawerClosedCount), 0);
      await workspaceOpener.click();
      await page.locator("[data-workspace-card-cancel]").click();
      await settledFocus('[data-workspace-select="b"] [data-mobile-workspace-edit]');
      await workspaceOpener.focus(); await page.keyboard.press("Space");
      assert.equal(await workspaceModal.evaluate((d) => d.open), true);
      await page.keyboard.press("Escape");
      await settledFocus('[data-workspace-select="b"] [data-mobile-workspace-edit]');

      // The pencil is outside summary, stays visible when collapsed and cannot toggle it.
      const folder = page.locator('[data-workspace-folder-kind="folder"] details');
      await folder.locator("summary").click();
      assert.equal(await folder.evaluate((d) => d.open), false);
      assert.equal(await folderOpener.isVisible(), true);
      await folderOpener.focus(); await page.keyboard.press("Tab"); await folderOpener.focus();
      await save("folder-keyboard-focus");
      await page.keyboard.press("Space");
      assert.equal(await renameModal.evaluate((d) => d.matches(":modal")), true);
      assert.equal(await folder.evaluate((d) => d.open), false);
      assert.equal(await page.locator("[data-text-dialog-input]").inputValue(), "РАБОТА");
      assert.equal(await drawer.evaluate((d) => d.open), true);
      assert.equal(await renameModal.evaluate((d) => {
        const box = d.getBoundingClientRect(), style = getComputedStyle(d), inner = getComputedStyle(d.querySelector(".text-dialog"));
        return box.left >= 16 && innerWidth - box.right >= 16 && box.width <= 356
          && parseFloat(style.borderTopWidth) === 1 && parseFloat(style.borderRadius) === 12
          && inner.backgroundColor === "rgba(0, 0, 0, 0)" && parseFloat(inner.borderTopWidth) === 0 && inner.boxShadow === "none"
          && [...d.querySelectorAll("input:not([hidden]), button:not([hidden])")].filter((n) => n.getClientRects().length).every((n) => n.getBoundingClientRect().height >= 44);
      }), true);
      await save("folder-rename");
      for (let index = 0; index < 5; index++) {
        await page.keyboard.press(index % 2 ? "Shift+Tab" : "Tab");
        assert.equal(await renameModal.evaluate((d) => d.contains(document.activeElement)), true);
      }
      await page.keyboard.press("Escape");
      await settledFocus("[data-mobile-folder-rename]");
      await folderOpener.focus(); await page.keyboard.press("Enter");
      await page.locator("[data-text-dialog-cancel]").click();
      await settledFocus("[data-mobile-folder-rename]");
      await folderOpener.click();
      await page.evaluate(() => AgentHub.navigateBack());
      await settledFocus("[data-mobile-folder-rename]");
      await folderOpener.click();
      await page.mouse.click(4, 100);
      await settledFocus("[data-mobile-folder-rename]");
      assert.equal(await drawer.evaluate((d) => d.open), true);
      assert.equal(await page.evaluate(() => window.drawerClosedCount), 0);
      await folder.locator("summary").click();

      // Existing mutation owner still addresses the explicit row, not selection A.
      await workspaceOpener.click();
      await page.locator("[data-workspace-card-name]").fill("Utilities renamed");
      await page.locator("[data-workspace-card-form]").evaluate((form) => form.requestSubmit());
      await settledFocus('[data-workspace-select="b"] [data-mobile-workspace-edit]');
      assert.equal(await page.evaluate(() => window.testIntents.find((i) => i.type === "workspace:update")?.workspaceId), "b");
      await folderOpener.click();
      await page.locator("[data-text-dialog-input]").fill("ДРУГАЯ");
      await page.locator("[data-text-dialog-form]").evaluate((form) => form.requestSubmit());
      await settledFocus("[data-mobile-folder-rename]");
      assert.equal(await page.evaluate(() => window.testIntents.filter((i) => i.type === "workspace:folder-rename").length), 1);

      await folderOpener.click();
      await page.evaluate((tasks) => {
        AgentHub.setWorkspaces([{ id: "a", name: "AgentHub", settings: { catalogFolder: "НОВАЯ" } },
          { id: "b", name: "Utilities", settings: { catalogFolder: "НОВАЯ" } }]);
        AgentHub.setTasks(tasks.map((task) => ({ ...task, workspaceSettings: { catalogFolder: "НОВАЯ" } })));
        AgentHub.renameWorkspaceFolderCatalog("РАБОТА", "НОВАЯ");
      }, tasks);
      await page.keyboard.press("Escape");
      await settledFocus('[data-mobile-folder-rename][aria-label="Переименовать папку «НОВАЯ»"]');
      await workspaceOpener.click();
      await page.evaluate((tasks) => {
        AgentHub.setWorkspaces([{ id: "a", name: "AgentHub", settings: { catalogFolder: "РАБОТА" } }]);
        AgentHub.setTasks(tasks.filter((task) => task.workspaceId === "a"));
      }, tasks);
      await page.keyboard.press("Escape");
      await settledFocus('[data-workspace-select="a"] [data-mobile-workspace-edit]');
      await page.evaluate(() => AgentHub.navigateBack());
      await page.waitForFunction(() => !document.querySelector("[data-mobile-workspace-drawer]").open && window.drawerClosedCount === 1);
      if (width === 430 && theme === "orbit") {
        await page.setViewportSize({ width: 1280, height: 844 });
        await page.waitForFunction(() => !document.documentElement.hasAttribute("data-mobile-dialogs-enabled"));
        assert.equal(await page.locator("[data-mobile-workspace-select], [data-mobile-workspace-edit], [data-mobile-folder-row], [data-mobile-folder-rename]").count(), 0);
        assert.equal(await page.locator('[data-workspace-select="a"]').getAttribute("role"), "button");
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
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
      assert.equal(await page.locator("[data-mobile-workspace-edit], [data-mobile-folder-rename], [data-mobile-folder-row]").count(), 0);
      assert.equal(await page.locator('[data-workspace-select="a"]').evaluate((row) => {
        const event = new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true });
        row.dispatchEvent(event); return event.defaultPrevented;
      }), true);
      await page.getByRole("menuitem", { name: "Редактировать…", exact: true }).click();
      assert.equal(await page.locator("[data-workspace-card-name]").inputValue(), "AgentHub");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator('[data-workspace-folder-kind="folder"] summary').evaluate((summary) => {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
        summary.dispatchEvent(event); return event.defaultPrevented;
      }), true);
      await page.getByRole("menuitem", { name: "Переименовать папку…", exact: true }).click();
      assert.equal(await page.locator("[data-text-dialog-input]").inputValue(), "РАБОТА");
      await page.locator("[data-text-dialog-cancel]").click();
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
