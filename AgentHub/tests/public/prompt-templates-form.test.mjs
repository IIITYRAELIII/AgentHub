import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

// Все prompt-шаблоны правятся одной общей формой. Проверяется настоящий путь:
// данные приходят снимком, форму открывают оттуда же, где раньше стоял
// встроенный редактор, а результат читается через намерение сохранения,
// композер и настоящую геометрию.
const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const THEME_CATALOG = JSON.stringify([{
  id: "orbit", name: "Orbit", color: "#080b11", aliases: [], assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);
const SNAPSHOT = {
  apiVersion: 3, version: "prompt-templates-form", server: { status: "online" },
  tasks: [], workspaces: [], archivedWorkspaces: [], boardTasks: [], boardLayout: { columnOrder: [] },
  deferredInputs: [], messageReceipts: [], pendingApprovals: [],
  settings: {
    provider: "codex", models: [], modelOptionsByProvider: {}, reasoningOptions: [],
    reasoningOptionsByProvider: {}, modeOptions: [],
    quickMessages: { global: [], workspaces: {}, streams: {} },
  },
};
const MODAL = "[data-prompt-templates-modal]";
const SCOPES = "[data-prompt-templates-scopes]";
const EDITOR = "[data-prompt-templates-editor]";
const ENTRY = {
  global: "[data-settings-global-quick-messages-entry]",
  workspace: "[data-workspace-card-quick-messages-entry]",
  stream: "[data-dialog-stream-quick-messages-entry]",
};
const LONG_TITLE = "Очень длинное название prompt-шаблона для узкой панели настроек";
const LONG_TEXT = "Разверни ответ подробно и без сокращений, ".repeat(6);

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  if (/\.svg$/u.test(pathname)) return "image/svg+xml";
  return "application/octet-stream";
}

// Один процесс браузера на файл: контексты изолированы, закрытие процесса
// стоит секунды и делается один раз.
let sharedBrowserPromise = null;

function sharedBrowser(chromium) {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = process.platform === "win32"
      ? chromium.launch({ channel: "msedge", headless: true })
      : chromium.launch({ headless: true });
  }
  return sharedBrowserPromise;
}

after(async () => {
  const pending = sharedBrowserPromise;
  sharedBrowserPromise = null;
  if (pending) await (await pending).close();
});

async function openPage(viewport) {
  const { chromium } = await import("playwright");
  const browser = await sharedBrowser(chromium);
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: source
          .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
          .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
          .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
          .replace("</head>", `<script type="application/json" data-theme-catalog>${THEME_CATALOG}</script></head>`),
      });
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
  return { context, page };
}

async function seed(page, quickMessages) {
  await page.evaluate((messages) => {
    window.__promptTemplateIntents = [];
    document.addEventListener("agenthub:intent", (event) => {
      window.__promptTemplateIntents.push(structuredClone(event.detail));
    });
    window.AgentHub.setWorkspaces(
      [{ id: "workspace-1", name: "Agent HUB", settings: {} }],
      ["workspace:workspace-1", "notes"],
    );
    window.AgentHub.setSelection({ quickMessages: messages });
    window.AgentHub.setTasks([{
      id: "task-1",
      selected: true,
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-1",
      streamName: "Dashboard",
      streamOrdinal: 1,
      provider: "codex",
      agentLabel: "Codex",
      status: "ready",
      statusLabel: "Готов",
      lastActivity: "2026-09-08T08:00:00.000Z",
      running: false,
      unread: false,
      streamSettings: {},
    }]);
  }, quickMessages);
}

const openForm = async (page, scope) => {
  await page.locator(ENTRY[scope]).click();
  await page.waitForFunction(() => document.querySelector("[data-prompt-templates-modal]")?.open === true);
};

const savedQuickMessages = (page) => page.evaluate(() => window.__promptTemplateIntents
  .filter((item) => item.type === "selection:set" && item.key === "quickMessages")
  .at(-1)?.value ?? null);

const lastMutationId = (page) => page.evaluate(() => window.__promptTemplateIntents
  .filter((item) => item.type === "selection:set" && item.key === "quickMessages")
  .at(-1)?.mutationId ?? "");

const activeScope = (page) => page.locator(`${SCOPES} [aria-pressed="true"]`)
  .getAttribute("data-prompt-templates-scope");

const summaries = (page) => page.locator(`${EDITOR} .quick-message-editor-title`).allTextContents();

const conflict = (page) => page.evaluate(() => ({
  visible: document.querySelector("[data-prompt-templates-conflict]")?.hidden === false,
  text: document.querySelector("[data-prompt-templates-conflict-text]")?.textContent ?? "",
  marked: Boolean(document.querySelector("[data-prompt-templates-scopes] [data-prompt-templates-diverged]")),
}));

// Правка идёт тем же путём, что и у пользователя: значение в поле и штатные
// события. Сохранение в этой сборке происходит сразу, отдельной кнопки нет.
const editTitle = (page, value) => page.locator(`${EDITOR} [data-quick-message-title]`).first()
  .evaluate((node, next) => {
    node.value = next;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);

// Ввод без ухода из поля: change ещё не случился, черновик живёт только в
// состоянии редактора. Дальше приходит чужое обновление — терять его нельзя.
const typeTitle = (page, value) => page.locator(`${EDITOR} [data-quick-message-title]`).first()
  .evaluate((node, next) => {
    node.value = next;
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);

const writeCount = (page) => page.evaluate(() => window.__promptTemplateIntents
  .filter((item) => item.type === "selection:set" && item.key === "quickMessages").length);

const pushSelection = (page, quickMessages) => page.evaluate(
  (messages) => window.AgentHub.setSelection({ quickMessages: messages }),
  quickMessages,
);

test("общая форма открывается из настроек, карточки Workspace и карточки Stream", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: { "stream-1": [{ title: "Stream", text: "Stream prompt" }] },
    });

    await page.locator('[data-panel-open="settings"]').click();
    assert.equal(await page.locator(MODAL).isVisible(), false);
    assert.equal(await page.locator('.settings-panel [data-quick-message-action-mode]').count(), 0);
    assert.equal(await page.locator('.quick-messages-settings-row .setting-name').textContent(), 'Prompt-шаблоны');
    assert.equal(await page.locator(".settings-panel [data-quick-message-row]").count(), 0,
      "встроенный редактор остался в панели настроек");
    await openForm(page, "global");
    const actionSelect = page.locator(`${MODAL} [data-quick-message-action-mode]`);
    const actionShell = actionSelect.locator('..');
    const actionButton = actionShell.locator('button').first();
    await actionButton.click();
    const actionMenu = await actionButton.getAttribute('aria-controls');
    await page.locator(`#${actionMenu} [data-value="send"]`).click();
    assert.equal(await actionSelect.inputValue(), 'send');
    assert.equal(await page.evaluate(() => window.__promptTemplateIntents
      .filter((item) => item.type === 'selection:set' && item.key === 'quickMessageActionMode')
      .at(-1)?.value), 'send');
    const actionRect = await actionShell.boundingBox();
    const scopeRect = await page.locator(SCOPES).boundingBox();
    assert.ok(actionRect.y + actionRect.height <= scopeRect.y);
    assert.equal(await activeScope(page), "global");
    assert.deepEqual(await summaries(page), ["Принято"]);
    assert.equal(await page.locator("[data-prompt-templates-note]").textContent(),
      "Видны во всех Workspace и Stream.");

    // Область переключается внутри формы, данные областей остаются раздельными.
    await page.locator(`${SCOPES} [data-prompt-templates-scope="workspace"]`).click();
    assert.deepEqual(await summaries(page), ["Workspace"]);
    await page.locator(`${SCOPES} [data-prompt-templates-scope="stream"]`).click();
    assert.deepEqual(await summaries(page), ["Stream"]);
    assert.deepEqual(
      await page.locator(`${SCOPES} .prompt-templates-scope-name`).allTextContents(),
      ["Глобальные", "Agent HUB", "Dashboard"],
    );
    assert.deepEqual(
      await page.locator(`${SCOPES} .prompt-templates-scope-count`).allTextContents(),
      ["1", "1", "1"],
    );

    // Escape снимает только верхний слой: панель настроек под формой остаётся.
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(MODAL).evaluate((node) => node.open), false);
    assert.equal(await page.locator(MODAL).isVisible(), false);
    assert.equal(await page.locator(".settings-panel").evaluate((node) => node.hidden), false,
      "Escape закрыл вместе с формой и панель настроек");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.promptTemplatesOpen), "global",
      "фокус не вернулся на кнопку входа");
    await page.locator("[data-panel-close]").click();

    await page.locator('[data-workspace-select="workspace-1"]').dblclick();
    await openForm(page, "workspace");
    assert.equal(await activeScope(page), "workspace");
    assert.deepEqual(await summaries(page), ["Workspace"]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.locator('.stream-tabs-track [data-stream-tab-id="stream-1"]').dblclick();
    await openForm(page, "stream");
    assert.equal(await activeScope(page), "stream");
    assert.deepEqual(await summaries(page), ["Stream"]);
  } finally {
    await context.close();
  }
});

test("правка в форме сохраняется по своей области и применяется в композере", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await openForm(page, "global");
    await page.locator(`${EDITOR} [data-quick-message-add]`).click();
    await page.locator(`${EDITOR} [data-quick-message-title]`).nth(1).fill("Продолжай");
    await page.locator(`${EDITOR} [data-quick-message-text]`).nth(1).fill("Продолжай работу");
    await page.locator(`${EDITOR} [data-quick-message-text]`).nth(1).dispatchEvent("change");
    assert.deepEqual((await savedQuickMessages(page)).global, [
      { title: "Принято", text: "Принято" },
      { title: "Продолжай", text: "Продолжай работу" },
    ]);

    // Соседняя область правкой не задета.
    await page.locator(`${SCOPES} [data-prompt-templates-scope="workspace"]`).click();
    await editTitle(page, "Workspace v2");
    const saved = await savedQuickMessages(page);
    assert.deepEqual(saved.workspaces["workspace-1"], [{ title: "Workspace v2", text: "Workspace prompt" }]);
    assert.equal(saved.global.length, 2);

    await page.locator("[data-prompt-templates-done]").click();
    assert.equal(await page.locator(MODAL).evaluate((node) => node.open), false);
    assert.equal(await page.locator("[data-settings-global-quick-messages-count]").textContent(), "2 шаблона");

    await page.locator("[data-panel-close]").click();
    await page.locator('[data-composer-quick-messages] [data-quick-message-index]')
      .filter({ hasText: "Продолжай" }).click();
    assert.ok((await page.locator("[data-composer-input]").inputValue()).includes("Продолжай работу"),
      "шаблон не подставился в поле ввода");
  } finally {
    await context.close();
  }
});

test("непочатая область следует входящему обновлению снимка", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await openForm(page, "global");
    assert.deepEqual(await summaries(page), ["Принято"]);

    await page.evaluate(() => window.AgentHub.setSelection({
      quickMessages: {
        global: [{ title: "Извне", text: "Извне prompt" }],
        workspaces: { "workspace-1": [{ title: "Workspace извне", text: "Workspace извне prompt" }] },
        streams: {},
      },
    }));
    assert.deepEqual(await summaries(page), ["Извне"], "открытая форма не подхватила обновление");
    assert.deepEqual(await conflict(page), { visible: false, text: "", marked: false });

    await page.locator(`${SCOPES} [data-prompt-templates-scope="workspace"]`).click();
    assert.deepEqual(await summaries(page), ["Workspace извне"]);
  } finally {
    await context.close();
  }
});

test("незаписанный черновик и внешнее изменение той же области дают явное расхождение", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: {},
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await openForm(page, "global");
    await editTitle(page, "Моя правка");

    // Транспорт отказал: черновик остаётся в редакторе, запись не состоялась.
    const mutationId = await lastMutationId(page);
    assert.ok(mutationId, "сохранение не сообщило идентификатор операции");
    await page.evaluate((id) => window.AgentHub.rejectSelection("quickMessages", id), mutationId);
    assert.equal(await page.locator(`${EDITOR} [data-quick-message-error]`).isVisible(), true);
    assert.deepEqual(await summaries(page), ["Моя правка"]);
    assert.deepEqual(await conflict(page), { visible: false, text: "", marked: false },
      "расхождение показано до внешнего изменения");

    // Ту же область меняют снаружи: подменять черновик молча нельзя.
    await page.evaluate(() => window.AgentHub.setSelection({
      quickMessages: { global: [{ title: "Извне", text: "Извне prompt" }], workspaces: {}, streams: {} },
    }));
    const diverged = await conflict(page);
    assert.equal(diverged.visible, true, "расхождение не показано");
    assert.equal(diverged.marked, true, "область с расхождением не помечена");
    assert.ok(diverged.text.includes("изменились"), diverged.text);
    assert.deepEqual(await summaries(page), ["Моя правка"], "черновик потерян");

    // Выбор остаётся за человеком и делается явно.
    await page.locator("[data-prompt-templates-reload]").click();
    assert.deepEqual(await summaries(page), ["Извне"]);
    assert.deepEqual(await conflict(page), { visible: false, text: "", marked: false });
    assert.equal(await page.locator(`${EDITOR} [data-quick-message-error]`).isHidden(), true);
  } finally {
    await context.close();
  }
});


test("набранный, но ещё не сохранённый черновик переживает чужое обновление области", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: {},
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await openForm(page, "global");
    await typeTitle(page, "Набираю");
    assert.equal(await writeCount(page), 0, "ввод без ухода из поля уже что-то записал");

    await pushSelection(page, {
      global: [{ title: "Извне", text: "Извне prompt" }],
      workspaces: {},
      streams: {},
    });
    assert.equal(
      await page.locator(`${EDITOR} [data-quick-message-title]`).first().inputValue(),
      "Набираю",
      "чужое обновление затёрло набранный черновик",
    );
    const diverged = await conflict(page);
    assert.equal(diverged.visible, true, "расхождение не показано");
    assert.equal(diverged.marked, true, "область с расхождением не помечена");
  } finally {
    await context.close();
  }
});

test("при расхождении области ни одна правка не уходит в запись", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: {},
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await openForm(page, "global");
    await editTitle(page, "Моя правка");
    const mutationId = await lastMutationId(page);
    assert.ok(mutationId, "сохранение не сообщило идентификатор операции");
    await page.evaluate((id) => window.AgentHub.rejectSelection("quickMessages", id), mutationId);

    await pushSelection(page, {
      global: [{ title: "Извне", text: "Извне prompt" }],
      workspaces: {},
      streams: {},
    });
    assert.equal((await conflict(page)).visible, true, "расхождение не показано");
    const before = await writeCount(page);

    // Любая попытка записи при расхождении обязана ничего не отправлять.
    await page.locator(`${EDITOR} [data-quick-message-title]`).first().evaluate((node) => {
      node.value = "Повторная правка";
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator(`${EDITOR} [data-quick-message-add]`).dispatchEvent("click");
    await page.locator(`${EDITOR} [data-quick-message-row]`).first()
      .locator('[data-quick-message-action="delete"]').dispatchEvent("click");
    await page.locator("[data-prompt-templates-done]").dispatchEvent("click");

    assert.equal(await writeCount(page), before, "при расхождении ушла запись");
    assert.equal((await conflict(page)).visible, true, "расхождение снялось само");
    assert.equal(await page.locator(MODAL).evaluate((node) => node.open), true,
      "форма закрылась, не разобрав расхождение");

    // Явное решение возвращает работу в обычное русло.
    await page.locator("[data-prompt-templates-reload]").click();
    assert.deepEqual(await conflict(page), { visible: false, text: "", marked: false });
    assert.deepEqual(await summaries(page), ["Извне"]);
    await editTitle(page, "После разбора");
    assert.equal(await writeCount(page), before + 1, "после разбора запись не прошла");
    assert.deepEqual((await savedQuickMessages(page)).global, [
      { title: "После разбора", text: "Извне prompt" },
    ]);
  } finally {
    await context.close();
  }
});

test("правка одной области не затирает чужое обновление другой", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await openForm(page, "global");
    await page.locator(`${SCOPES} [data-prompt-templates-scope="workspace"]`).click();
    await typeTitle(page, "Workspace черновик");

    // Снаружи меняется соседняя область, которую никто не правил.
    await pushSelection(page, {
      global: [{ title: "Извне", text: "Извне prompt" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: {},
    });
    assert.equal((await conflict(page)).visible, false, "расхождение показано не по адресу");

    await page.locator(`${EDITOR} [data-quick-message-title]`).first().dispatchEvent("change");
    const saved = await savedQuickMessages(page);
    assert.deepEqual(saved.global, [{ title: "Извне", text: "Извне prompt" }],
      "запись правленой области затёрла чужое обновление соседней");
    assert.deepEqual(saved.workspaces["workspace-1"], [
      { title: "Workspace черновик", text: "Workspace prompt" },
    ]);

    // Непочатая область при возврате показывает пришедшее снаружи значение.
    await page.locator(`${SCOPES} [data-prompt-templates-scope="global"]`).click();
    assert.deepEqual(await summaries(page), ["Извне"]);
  } finally {
    await context.close();
  }
});


// Черновик может остаться в области, до которой из текущего окна не дотянуться:
// её Workspace сейчас не открыт. Такое расхождение обязано подождать своего
// Workspace, а не запирать форму, открытую в другом месте.
async function seedTwoWorkspaces(page, quickMessages) {
  await page.evaluate((messages) => {
    window.__promptTemplateIntents = [];
    document.addEventListener("agenthub:intent", (event) => {
      window.__promptTemplateIntents.push(structuredClone(event.detail));
    });
    window.AgentHub.setWorkspaces(
      [
        { id: "workspace-1", name: "Первый", settings: {} },
        { id: "workspace-2", name: "Второй", settings: {} },
      ],
      ["workspace:workspace-1", "workspace:workspace-2", "notes"],
    );
    window.AgentHub.setSelection({ quickMessages: messages });
    window.AgentHub.setTasks([
      {
        id: "task-1",
        selected: true,
        workspaceId: "workspace-1",
        workspaceName: "Первый",
        streamId: "stream-1",
        streamName: "Dashboard",
        streamOrdinal: 1,
        provider: "codex",
        agentLabel: "Codex",
        status: "ready",
        statusLabel: "Готов",
        lastActivity: "2026-09-08T08:00:00.000Z",
        running: false,
        unread: false,
        streamSettings: {},
      },
      {
        id: "task-2",
        selected: false,
        workspaceId: "workspace-2",
        workspaceName: "Второй",
        streamId: "stream-2",
        streamName: "Второй поток",
        streamOrdinal: 1,
        provider: "codex",
        agentLabel: "Codex",
        status: "ready",
        statusLabel: "Готов",
        lastActivity: "2026-09-08T08:00:00.000Z",
        running: false,
        unread: false,
        streamSettings: {},
      },
    ]);
  }, quickMessages);
}

const openWorkspaceCard = async (page, workspaceId) => {
  await page.locator(`[data-workspace-select="${workspaceId}"]`).dblclick();
  await page.waitForFunction(() => document.querySelector("[data-workspace-card-modal]")?.open === true);
};

test("расхождение в недоступной области не запирает форму, открытую в другой", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seedTwoWorkspaces(page, {
      global: [{ title: "Общий", text: "Общий prompt" }],
      workspaces: {
        "workspace-1": [{ title: "Первый шаблон", text: "Первый prompt" }],
        "workspace-2": [{ title: "Второй шаблон", text: "Второй prompt" }],
      },
      streams: {},
    });

    // В первом Workspace остаётся набранный, но ещё не записанный черновик.
    await openWorkspaceCard(page, "workspace-1");
    await openForm(page, "workspace");
    assert.equal(await activeScope(page), "workspace");
    await typeTitle(page, "Черновик первого");
    assert.equal(await writeCount(page), 0);
    await page.locator("[data-prompt-templates-done]").click();
    assert.equal(await page.locator(MODAL).evaluate((node) => node.open), false,
      "форма не закрылась, пока расхождения ещё не было");
    await page.locator("[data-workspace-card-close]").click();

    // Ту же область меняют снаружи, пока её Workspace закрыт.
    await pushSelection(page, {
      global: [{ title: "Общий", text: "Общий prompt" }],
      workspaces: {
        "workspace-1": [{ title: "Первый извне", text: "Первый извне prompt" }],
        "workspace-2": [{ title: "Второй шаблон", text: "Второй prompt" }],
      },
      streams: {},
    });

    // Во втором Workspace форма обязана работать и закрываться штатно.
    await openWorkspaceCard(page, "workspace-2");
    await openForm(page, "workspace");
    assert.deepEqual(await summaries(page), ["Второй шаблон"]);
    assert.equal((await conflict(page)).visible, false,
      "чужое расхождение показано там, где его не разобрать");
    const before = await writeCount(page);
    await page.locator("[data-prompt-templates-done]").click();
    assert.equal(await page.locator(MODAL).evaluate((node) => node.open), false,
      "форма второго Workspace заперта чужим расхождением");
    assert.equal(await writeCount(page), before, "закрытие формы что-то записало");
    await page.locator("[data-workspace-card-close]").click();

    // Черновик и расхождение дожидаются своего Workspace.
    await openWorkspaceCard(page, "workspace-1");
    await openForm(page, "workspace");
    assert.deepEqual(
      await page.locator(`${EDITOR} [data-quick-message-title]`).first().inputValue(),
      "Черновик первого",
      "отложенный черновик потерян",
    );
    const diverged = await conflict(page);
    assert.equal(diverged.visible, true, "расхождение не показано в своей области");
    assert.equal(diverged.marked, true);
    assert.equal(await page.locator("[data-prompt-templates-done]").evaluate((node) => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return document.querySelector("[data-prompt-templates-modal]")?.open;
    }), true, "доступное расхождение перестало держать закрытие");

    await page.locator("[data-prompt-templates-reload]").click();
    assert.deepEqual(await summaries(page), ["Первый извне"]);
    assert.deepEqual(await conflict(page), { visible: false, text: "", marked: false });
    await page.locator("[data-prompt-templates-done]").click();
    assert.equal(await page.locator(MODAL).evaluate((node) => node.open), false);
  } finally {
    await context.close();
  }
});

for (const [surface, viewport] of [
  ["narrow", { width: 390, height: 844 }],
  ["regular", { width: 1440, height: 900 }],
]) {
  test(`форма и панель настроек не переполняются по горизонтали (${surface})`, async () => {
    const { context, page } = await openPage(viewport);
    const screenshotDirectory = String(process.env.HUB219_QA_SCREENSHOT_DIR ?? "").trim();
    try {
      await seed(page, {
        global: [
          { title: LONG_TITLE, text: LONG_TEXT },
          { title: "Второй", text: "Второй prompt" },
          { title: "Третий", text: "Третий prompt" },
        ],
        workspaces: {},
        streams: {},
      });

      await page.locator('[data-panel-open="settings"]').click();
      const panel = await page.evaluate(() => {
        const body = document.querySelector(".settings-body");
        return {
          overflow: body.scrollWidth - body.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          entryWidth: Math.round(
            document.querySelector("[data-settings-global-quick-messages-entry]").getBoundingClientRect().width,
          ),
        };
      });
      assert.ok(panel.overflow <= 1, `панель настроек прокручивается вбок на ${panel.overflow} px`);
      assert.ok(panel.documentOverflow <= 1, `страница прокручивается вбок на ${panel.documentOverflow} px`);
      assert.ok(panel.entryWidth > 40, `кнопка входа схлопнулась до ${panel.entryWidth} px`);
      if (screenshotDirectory) {
        await mkdir(screenshotDirectory, { recursive: true });
        await writeFile(
          path.join(screenshotDirectory, `settings-${surface}.png`),
          await page.screenshot({ fullPage: false }),
        );
      }

      await openForm(page, "global");
      const form = await page.evaluate(() => {
        const fields = document.querySelector(".prompt-templates-fields");
        const rect = fields.getBoundingClientRect();
        const rows = [...fields.querySelectorAll("[data-quick-message-row]")];
        // Свёрнутые подробности строки скрыты по построению аккордеона, поэтому
        // проверяются только те кнопки, которые сейчас показаны.
        const actions = rows
          .flatMap((row) => [...row.querySelectorAll("[data-quick-message-action]")])
          .filter((node) => node.offsetParent !== null);
        return {
          overflow: fields.scrollWidth - fields.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rows: rows.length,
          outside: actions.filter((node) => {
            const box = node.getBoundingClientRect();
            return box.width < 1 || box.height < 1 || box.right > rect.right + 1 || box.left < rect.left - 1;
          }).length,
          openDetails: fields.querySelectorAll(".quick-message-editor-details:not([hidden])").length,
          visibleActions: actions.length,
        };
      });
      assert.equal(form.rows, 3);
      assert.equal(form.openDetails, 1);
      assert.ok(form.overflow <= 1, `форма прокручивается вбок на ${form.overflow} px`);
      assert.ok(form.documentOverflow <= 1, `страница с формой прокручивается вбок на ${form.documentOverflow} px`);
      assert.ok(form.visibleActions >= 5, `показано только ${form.visibleActions} кнопок строки`);
      assert.equal(form.outside, 0, "кнопки строки вышли за пределы формы или схлопнулись");

      // Удаление остаётся именно кликабельным, а не только видимым.
      await page.locator(`${EDITOR} [data-quick-message-row]`).first()
        .locator('[data-quick-message-action="delete"]').click();
      assert.equal(await page.locator(`${EDITOR} [data-quick-message-row]`).count(), 2);

      if (screenshotDirectory) {
        await writeFile(
          path.join(screenshotDirectory, `prompt-templates-${surface}.png`),
          await page.screenshot({ fullPage: false }),
        );
      }
    } finally {
      await context.close();
    }
  });
}
