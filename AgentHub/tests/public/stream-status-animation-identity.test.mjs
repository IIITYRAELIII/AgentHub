import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Полоса активности живёт на псевдоэлементе карточки, поэтому новый узел
// начинает её заново. Проверяем настоящий путь рендера: данные меняются через
// публичный API оболочки, DOM никто не подменяет вручную.
const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = createRequire(import.meta.url)("../../theme-registry.cjs");
const THEME_REGISTRY = loadThemeRegistry(fileURLToPath(WEB_APP_ROOT));
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

async function openShell(page, { allThemes = false } = {}) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = renderThemeHtml(source, {
        ...THEME_REGISTRY,
        themes: THEME_REGISTRY.themes.filter((theme) => allThemes || theme.id === "orbit"),
      })
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "");
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
async function publishSnapshot(page, { tick, running = true, unread = false, finalRevision = 0, streamName = "Первый", selectedIndex = 0 }) {
  await page.evaluate(({ tick, running, unread, finalRevision, streamName, selectedIndex }) => {
    const base = {
      status: running ? "running" : "ready",
      statusLabel: running ? "Идёт" : "Готов",
      running,
      unread,
      latestFinal: finalRevision > 0
        ? { provider: "codex", threadId: "thread-final", turnId: "turn-final", revision: finalRevision }
        : null,
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
  }, { tick, running, unread, finalRevision, streamName, selectedIndex });
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

const STATUS_SURFACES = [
  STREAM_TAB,
  WORKSPACE_CARD,
  '.activity-stream-item[data-activity-task-id="task-0"]',
];

async function motionState(page) {
  return page.evaluate((selectors) => selectors.map((selector) => {
    const node = document.querySelector(selector);
    const target = node?.querySelector(".stream-tab-status-layer") ?? node;
    const animation = target?.getAnimations({ subtree: true })
      .find((item) => item.effect?.target === target && item.effect?.pseudoElement);
    const pseudo = animation?.effect?.pseudoElement;
    const style = target && pseudo ? getComputedStyle(target, pseudo) : null;
    return {
      selector,
      kept: window.statusSurfaceNodes?.get(selector) === node,
      time: animation ? Number(animation.currentTime) : null,
      playState: animation?.playState ?? null,
      transform: style?.transform ?? null,
      opacity: style?.opacity ?? null,
      running: node?.hasAttribute("data-running") ?? false,
      unread: (node?.hasAttribute("data-unread") || node?.hasAttribute("data-answer-ready")) ?? false,
      offscreen: node?.hasAttribute("data-stream-offscreen") ?? false,
    };
  }), STATUS_SURFACES);
}

async function rememberStatusSurfaces(page) {
  await page.evaluate((selectors) => {
    window.statusSurfaceNodes = new Map(selectors.map((selector) => [selector, document.querySelector(selector)]));
  }, STATUS_SURFACES);
}

async function waitForMotionProgress(page, before, delta = 100) {
  await page.waitForFunction(({ selectors, before, delta }) => selectors.every((selector, index) => {
    const node = document.querySelector(selector);
    const target = node?.querySelector(".stream-tab-status-layer") ?? node;
    const animation = target?.getAnimations({ subtree: true })
      .find((item) => item.effect?.target === target && item.effect?.pseudoElement);
    return animation && Number(animation.currentTime) > before[index].time + delta;
  }), { selectors: STATUS_SURFACES, before, delta }, { timeout: 5000 });
}

async function applyViewSetting(page, key, value) {
  await page.evaluate((detail) => document.dispatchEvent(new CustomEvent("agenthub:stream-view-settings-change", {
    detail,
  })), { key, value });
}

for (const theme of ["jedi-archives", "bespin"]) {
  test(`${theme}: обновления сохраняют движение и дают вспышке ответа завершиться`, async () => {
    const { chromium } = await import("playwright");
    const browser = await launch(chromium);
    try {
      const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openShell(page, { allThemes: true });
      await page.locator("[data-theme-select]").selectOption(theme, { force: true });
      await publishSnapshot(page, { tick: 0 });
      await rememberStatusSurfaces(page);
      await page.waitForTimeout(220);
      const before = await motionState(page);
      for (let tick = 1; tick <= 4; tick += 1) {
        await publishSnapshot(page, { tick });
        await page.waitForTimeout(160);
      }
      await waitForMotionProgress(page, before, 400);
      const running = await motionState(page);
      for (let index = 0; index < running.length; index += 1) {
        const current = running[index];
        assert.equal(current.kept, true, `${current.selector}: узел заменён при обновлении`);
        assert.equal(current.offscreen, false, `${current.selector}: видимая карточка ошибочно скрыта`);
        assert.equal(current.playState, "running");
        assert.ok(current.time > before[index].time + 400,
          `${current.selector}: ход стоит на начальных кадрах (${before[index].time} -> ${current.time})`);
        assert.notEqual(current.transform, before[index].transform, `${current.selector}: видимый эффект не движется`);
      }

      await publishSnapshot(page, { tick: 5, running: false, unread: true, finalRevision: 1 });
      await page.waitForTimeout(180);
      const arrival = await motionState(page);
      for (let tick = 6; tick <= 8; tick += 1) {
        await publishSnapshot(page, { tick, running: false, unread: true, finalRevision: 1 });
        await page.waitForTimeout(150);
      }
      const continuing = await motionState(page);
      for (let index = 0; index < continuing.length; index += 1) {
        const current = continuing[index];
        assert.equal(current.running, false);
        assert.equal(current.unread, true);
        assert.equal(current.playState, "running", `${current.selector}: вспышка оборвана тем же final revision`);
        assert.ok(current.time > arrival[index].time + 250, `${current.selector}: вспышка началась заново`);
      }
      // Вспышка ограничена CSS, статичная отметка после неё — ожидаемое состояние.
      await page.waitForTimeout(3000);
      await publishSnapshot(page, { tick: 9, running: false, unread: true, finalRevision: 1 });
      for (const current of await motionState(page)) assert.equal(current.time, null, "старый ответ повторно анимируется");
      await publishSnapshot(page, { tick: 10, running: false, unread: true, finalRevision: 2 });
      await page.waitForTimeout(120);
      for (const current of await motionState(page)) {
        assert.equal(current.playState, "running", "новая ревизия не запустила новую вспышку");
        assert.ok(current.time < 800, "новый ответ унаследовал время старой вспышки");
      }
      await publishSnapshot(page, { tick: 11, running: false, unread: false, finalRevision: 2 });
      for (const current of await motionState(page)) {
        assert.equal(current.unread, false);
        assert.equal(current.time, null, "прочитанный ответ продолжает анимироваться");
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

test("общий механизм движения работает во всех зарегистрированных темах", async () => {
  const { chromium } = await import("playwright");
  const browser = await launch(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await openShell(page, { allThemes: true });
    let tick = 0;
    for (const theme of THEME_REGISTRY.themes) {
      await page.locator("[data-theme-select]").selectOption(theme.id, { force: true });
      await publishSnapshot(page, { tick: tick++ });
      await rememberStatusSurfaces(page);
      await page.waitForTimeout(180);
      const before = await motionState(page);
      await publishSnapshot(page, { tick: tick++ });
      const reattached = await motionState(page);
      for (let index = 0; index < reattached.length; index += 1) {
        assert.ok(reattached[index].time >= before[index].time,
          `${theme.id}/${reattached[index].selector}: время сброшено (${before[index].time} -> ${reattached[index].time})`);
      }
      await waitForMotionProgress(page, before);
      const after = await motionState(page);
      for (let index = 0; index < after.length; index += 1) {
        assert.equal(after[index].kept, true, `${theme.id}: ${after[index].selector} пересоздан`);
        assert.equal(after[index].playState, "running", `${theme.id}: ${after[index].selector} не движется`);
        assert.ok(after[index].time > before[index].time + 100, `${theme.id}: время анимации не продвинулось`);
      }
    }
  } finally {
    await browser.close();
  }
});

test("эффекты, смена Stream и возврат к диалогам сохраняют семантику движения", async () => {
  const { chromium } = await import("playwright");
  const browser = await launch(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await openShell(page, { allThemes: true });
    let tick = 0;
    for (const theme of ["jedi-archives", "bespin"]) {
      await page.locator("[data-theme-select]").selectOption(theme, { force: true });
      for (const style of ["edge", "fill"]) {
        await applyViewSetting(page, "streamStatusStyle", style);
        for (const effect of ["impulse", "scanner", "energy", "breath", "thread", "sediment", "echo", "calm", "off"]) {
          await applyViewSetting(page, "streamStatusEffect", effect);
          await publishSnapshot(page, { tick: tick++ });
          await page.waitForTimeout(160);
          const before = await motionState(page);
          await publishSnapshot(page, { tick: tick++, selectedIndex: 1 });
          const reattached = await motionState(page);
          if (!["calm", "off"].includes(effect)) {
            for (let index = 0; index < reattached.length; index += 1) {
              assert.ok(reattached[index].time >= before[index].time,
                `${theme}/${style}/${effect}: время сброшено при смене Stream`);
            }
            await waitForMotionProgress(page, before, 80);
          }
          for (const current of await motionState(page)) {
            if (["calm", "off"].includes(effect)) assert.equal(current.time, null);
            else assert.equal(current.playState, "running");
          }
          if (["impulse", "scanner", "energy", "breath", "echo"].includes(effect)) {
            const finalRevision = tick + 1;
            await publishSnapshot(page, { tick: tick++, running: false, unread: true, finalRevision });
            await page.waitForTimeout(100);
            const arrival = await motionState(page);
            await publishSnapshot(page, { tick: tick++, running: false, unread: true, finalRevision });
            await waitForMotionProgress(page, arrival, 50);
          }
        }
      }
      await applyViewSetting(page, "streamStatusEffect", "impulse");
      await publishSnapshot(page, { tick: tick++ });
      await page.locator('[data-view-button="dashboard"]').click();
      await page.locator('[data-view-button="chat"]').click();
      await page.waitForTimeout(160);
      for (const state of await motionState(page)) {
        assert.equal(state.offscreen, false, `${theme}: видимый Stream остался offscreen после возврата`);
        assert.equal(state.playState, "running");
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      await publishSnapshot(page, { tick: tick++ });
      for (const state of await motionState(page)) assert.equal(state.time, null, "reduced motion проигнорирован");
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
  } finally {
    await browser.close();
  }
});
