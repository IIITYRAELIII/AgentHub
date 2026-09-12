import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Полоса активности живёт на псевдоэлементе карточки, поэтому новый узел
// начинает её заново. Проверяем настоящий путь рендера: данные меняются через
// публичный API оболочки, DOM никто не подменяет вручную.
const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const THEME_CATALOG = JSON.stringify([{
  id: "orbit", name: "Orbit", color: "#080b11", aliases: [], assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);
const SNAPSHOT = {
  apiVersion: 3, version: "stream-status-identity", server: { status: "online" },
  tasks: [], workspaces: [], archivedWorkspaces: [], boardTasks: [], boardLayout: { columnOrder: [] },
  deferredInputs: [], messageReceipts: [], pendingApprovals: [],
  settings: {
    provider: "codex", models: [], modelOptionsByProvider: {}, reasoningOptions: [],
    reasoningOptionsByProvider: {}, modeOptions: [],
    quickMessages: { global: [], workspaces: {}, streams: {} },
  },
};
const WORKSPACE_CARD = '.task-workspace-item[data-workspace-id="workspace-1"]';
const FOLDER_CARD = '.task-workspace-folder .task-workspace-item[data-workspace-id="workspace-2"]';
const STREAM_TAB = '.stream-tab[data-stream-tab-id="stream-0"]';

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  if (/\.svg$/u.test(pathname)) return "image/svg+xml";
  if (/\.json$/u.test(pathname)) return "application/json";
  return "application/octet-stream";
}

async function openShell(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${THEME_CATALOG}</script></head>`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    if (url.pathname === "/api/snapshot") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SNAPSHOT) });
    }
    if (url.pathname === "/api/control") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, result: SNAPSHOT }),
      });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      return route.fulfill({ status: 404, body: "Not found" });
    }
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
  await page.goto("https://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
  await page.evaluate(() => { document.documentElement.dataset.streamStatusEffect = "impulse"; });
}

// Настоящий путь обновления: снимок приносит новые данные потоков.
async function publishSnapshot(page, { tick, running = true, streamName = "Первый", selectedIndex = 0 }) {
  await page.evaluate(({ tick, running, streamName, selectedIndex }) => {
    const base = {
      status: running ? "running" : "ready",
      statusLabel: running ? "Идёт" : "Готов",
      running,
      unread: false,
      streamSettings: {},
    };
    window.AgentHub.setWorkspaces(
      [{ id: "workspace-1", name: "Первый", settings: {} },
        { id: "workspace-2", name: "Второй", settings: { catalogFolder: "Папка" } }],
      ["workspace:workspace-1", "workspace:workspace-2", "notes"],
    );
    window.AgentHub.setTasks([0, 1].map((index) => ({
      ...base,
      id: `task-${index}`,
      selected: index === selectedIndex,
      workspaceId: "workspace-1",
      workspaceName: "Первый",
      streamId: `stream-${index}`,
      streamName: index === 0 ? streamName : "Второй",
      streamOrdinal: index + 1,
      provider: "codex",
      agentLabel: "Codex",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      lastActivity: new Date(Date.now() - (tick * 1000)).toISOString(),
      progressStage: `Этап ${tick}`,
    })).concat([{
      ...base,
      id: "task-folder",
      selected: false,
      workspaceId: "workspace-2",
      workspaceName: "Второй",
      workspaceSettings: { catalogFolder: "Папка" },
      streamId: "stream-folder",
      streamName: "В папке",
      streamOrdinal: 1,
      provider: "codex",
      agentLabel: "Codex",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      lastActivity: new Date(Date.now() - (tick * 1000)).toISOString(),
    }]));
  }, { tick, running, streamName, selectedIndex });
}

// Метка ставится один раз и переживает обновление только вместе с самим узлом.
async function markRenderedNodes(page, { card, tab }) {
  await page.evaluate(({ card, tab }) => {
    document.querySelector(card).identityProbe = "workspace";
    const folder = document.querySelector(".task-workspace-folder .task-workspace-item[data-workspace-id=\"workspace-2\"]");
    if (folder) folder.identityProbe = "folder";
    const node = document.querySelector(tab);
    node.identityProbe = "tab";
    node.querySelector(".stream-tab-status-layer").identityProbe = "layer";
  }, { card, tab });
}

async function readState(page, { card, tab }) {
  return page.evaluate(({ card, tab }) => {
    const cardNode = document.querySelector(card);
    const tabNode = document.querySelector(tab);
    const layerNode = tabNode?.querySelector(".stream-tab-status-layer") ?? null;
    const animationTime = (node) => {
      const animation = node?.getAnimations({ subtree: true })
        .find((item) => String(item.animationName ?? "").startsWith("stream-"));
      return animation ? Math.round(Number(animation.currentTime) || 0) : null;
    };
    return {
      cardKept: cardNode?.identityProbe === "workspace",
      folderKept: document.querySelector(".task-workspace-folder .task-workspace-item[data-workspace-id=\"workspace-2\"]")?.identityProbe === "folder",
      tabKept: tabNode?.identityProbe === "tab",
      layerKept: layerNode?.identityProbe === "layer",
      cardRunning: cardNode ? "running" in cardNode.dataset : null,
      cardSelected: cardNode?.getAttribute("aria-pressed") ?? null,
      tabRunning: tabNode ? "running" in tabNode.dataset : null,
      tabCurrent: tabNode ? "current" in tabNode.dataset : null,
      tabTitle: tabNode?.querySelector(".stream-tab-title")?.textContent ?? "",
      cardTime: animationTime(cardNode),
      layerTime: animationTime(layerNode),
    };
  }, { card, tab });
}

async function launch(chromium) {
  if (process.platform === "win32") return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true });
}

test("активная полоса переживает обновления снимка на обеих поверхностях", async () => {
  const { chromium } = await import("playwright");
  const browser = await launch(chromium);
  const nodes = { card: WORKSPACE_CARD, tab: STREAM_TAB };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openShell(page);
    await publishSnapshot(page, { tick: 0 });
    await page.waitForSelector(STREAM_TAB);
    await markRenderedNodes(page, nodes);

    const before = await readState(page, nodes);
    assert.equal(before.cardRunning, true, "карточка Workspace должна быть отмечена как идущая");
    assert.equal(before.tabRunning, true, "вкладка Stream должна быть отмечена как идущая");
    assert.equal(before.tabCurrent, true, "выбранная вкладка Stream не отмечена как текущая");
    assert.ok(Number.isInteger(before.cardTime), "у карточки Workspace нет анимации состояния");
    assert.ok(Number.isInteger(before.layerTime), "у слоя статуса вкладки нет анимации состояния");

    // Несколько обновлений подряд, как при обычном опросе снимка.
    let last = before;
    for (let tick = 1; tick <= 4; tick += 1) {
      await publishSnapshot(page, { tick });
      await page.waitForTimeout(320);
      const current = await readState(page, nodes);
      assert.equal(current.cardKept, true, `обновление ${tick}: карточка Workspace пересоздана`);
      assert.equal(current.folderKept, true, `обновление ${tick}: карточка Workspace внутри папки пересоздана`);
      assert.equal(current.tabKept, true, `обновление ${tick}: вкладка Stream пересоздана`);
      assert.equal(current.layerKept, true, `обновление ${tick}: слой статуса вкладки пересоздан`);
      assert.ok(current.cardTime >= last.cardTime,
        `обновление ${tick}: анимация карточки началась заново (${last.cardTime} -> ${current.cardTime})`);
      assert.ok(current.layerTime >= last.layerTime,
        `обновление ${tick}: анимация вкладки началась заново (${last.layerTime} -> ${current.layerTime})`);
      last = current;
    }
    assert.ok(last.cardTime > before.cardTime + 600,
      `анимация карточки не продвинулась: ${before.cardTime} -> ${last.cardTime}`);
    assert.ok(last.layerTime > before.layerTime + 600,
      `анимация вкладки не продвинулась: ${before.layerTime} -> ${last.layerTime}`);

    // Переиспользованный узел обязан показывать новые данные.
    await publishSnapshot(page, { tick: 5, running: false, streamName: "Переименованный", selectedIndex: 1 });
    await page.waitForTimeout(120);
    const updated = await readState(page, nodes);
    assert.equal(updated.cardKept, true, "карточка Workspace пересоздана при смене статуса");
    assert.equal(updated.tabKept, true, "вкладка Stream пересоздана при смене статуса");
    assert.equal(updated.cardRunning, false, "снятый признак работы не отражён на карточке Workspace");
    assert.equal(updated.tabRunning, false, "снятый признак работы не отражён на вкладке Stream");
    assert.equal(updated.tabTitle, "Переименованный", "переиспользованная вкладка показывает старое имя");
    assert.equal(updated.tabCurrent, false, "переиспользованная вкладка удержала прежний выбор");
    assert.equal(updated.cardSelected, "true", "карточка того же Workspace перестала быть выбранной");
    await page.close();
  } finally {
    await browser.close();
  }
});

// Зеркало условия из VSCodeExtension/vscode-bootstrap.js: наблюдатель движения
// возобновляет приостановленные анимации, когда в документ попадает узел с
// признаком активности. Обновление обязано по-прежнему давать ему такой повод.
const MOTION_TARGET_SELECTOR = [
  ".rain",
  ".motes",
  '.stream-tab[data-running]',
  '.stream-tab[data-answer-ready]',
  '.task-workspace-item[data-running]',
  '.task-workspace-item[data-unread]',
].join(",");

test("обновление оставляет наблюдателю движения повод возобновить анимации", async () => {
  const { chromium } = await import("playwright");
  const browser = await launch(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openShell(page);
    await publishSnapshot(page, { tick: 0 });
    await page.waitForSelector(STREAM_TAB);
    await page.evaluate((selector) => {
      window.motionHints = 0;
      const addsMotion = (record) => {
        if (record.type === "attributes") return true;
        return [...record.addedNodes].some((node) => (
          node?.matches?.(selector) || node?.querySelector?.(selector)
        ));
      };
      new MutationObserver((records) => {
        if (records.some(addsMotion)) window.motionHints += 1;
      }).observe(document.body, {
        attributeFilter: ["data-running", "data-answer-ready", "data-unread"],
        attributes: true,
        childList: true,
        subtree: true,
      });
    }, MOTION_TARGET_SELECTOR);

    await publishSnapshot(page, { tick: 1 });
    await page.waitForTimeout(120);
    assert.ok(await page.evaluate(() => window.motionHints) > 0,
      "после обновления наблюдатель движения не получил ни одного повода");
    await page.close();
  } finally {
    await browser.close();
  }
});

test("при уменьшении движения обновления не создают и не возобновляют анимации", async () => {
  const { chromium } = await import("playwright");
  const browser = await launch(chromium);
  const nodes = { card: WORKSPACE_CARD, tab: STREAM_TAB };
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await openShell(page);
    await publishSnapshot(page, { tick: 0 });
    await page.waitForSelector(STREAM_TAB);
    await markRenderedNodes(page, nodes);

    const statusAnimations = () => page.evaluate(() => document.getAnimations()
      .filter((animation) => String(animation.animationName ?? "").startsWith("stream-"))
      .map((animation) => animation.playState));
    assert.deepEqual(await statusAnimations(), [],
      "при уменьшении движения анимации состояния не должны существовать");

    for (let tick = 1; tick <= 3; tick += 1) {
      await publishSnapshot(page, { tick });
      await page.waitForTimeout(160);
    }
    assert.deepEqual(await statusAnimations(), [],
      "обновление создало анимацию состояния вопреки выбору пользователя");

    const kept = await readState(page, nodes);
    assert.equal(kept.cardKept, true, "карточка Workspace пересоздана при уменьшении движения");
    assert.equal(kept.tabKept, true, "вкладка Stream пересоздана при уменьшении движения");
    assert.equal(kept.layerKept, true, "слой статуса вкладки пересоздан при уменьшении движения");
    assert.equal(kept.cardTime, null, "у карточки появилось время анимации при уменьшении движения");
    assert.equal(kept.layerTime, null, "у слоя статуса появилось время анимации при уменьшении движения");
    await context.close();
  } finally {
    await browser.close();
  }
});
