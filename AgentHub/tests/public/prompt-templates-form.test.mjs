import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

// Все prompt-шаблоны правятся одной формой. Проверяется настоящий путь: данные
// приходят снимком, форму открывают из тех же мест, где раньше стоял строчный
// редактор, а результат читается через намерение сохранения и композер.
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
const SCOPES = "[data-prompt-templates-scopes]";
const EDITOR = "[data-prompt-templates-editor]";
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

const savedQuickMessages = (page) => page.evaluate(() => window.__promptTemplateIntents
  .filter((item) => item.type === "selection:set" && item.key === "quickMessages")
  .at(-1)?.value ?? null);

const saveCount = (page) => page.evaluate(() => window.__promptTemplateIntents
  .filter((item) => item.type === "selection:set" && item.key === "quickMessages").length);

const activeScope = (page) => page.locator(`${SCOPES} [aria-pressed="true"]`)
  .getAttribute("data-prompt-templates-scope");

const rowTitles = (page) => page.locator(`${EDITOR} [data-quick-message-title]`).evaluateAll(
  (nodes) => nodes.map((node) => node.value),
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
    assert.equal(await page.locator(".settings-panel [data-quick-message-row]").count(), 0,
      "строчный редактор остался в панели настроек");
    await page.locator("[data-settings-global-quick-messages]").click();
    assert.equal(await page.locator("[data-prompt-templates-modal]").evaluate((node) => node.open), true);
    assert.equal(await activeScope(page), "global");
    assert.deepEqual(await rowTitles(page), ["Принято"]);
    assert.equal(await page.locator("[data-prompt-templates-note]").textContent(),
      "Видны во всех Workspace и Stream.");

    // Область переключается внутри формы, данные областей остаются раздельными.
    await page.locator(`${SCOPES} [data-prompt-templates-scope="workspace"]`).click();
    assert.deepEqual(await rowTitles(page), ["Workspace"]);
    await page.locator(`${SCOPES} [data-prompt-templates-scope="stream"]`).click();
    assert.deepEqual(await rowTitles(page), ["Stream"]);
    assert.deepEqual(
      await page.locator(`${SCOPES} .prompt-templates-scope-name`).allTextContents(),
      ["Глобальные", "Agent HUB", "Dashboard"],
    );

    await page.keyboard.press("Escape");
    assert.equal(await page.locator("[data-prompt-templates-modal]").evaluate((node) => node.open), false);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.promptTemplatesOpen), "global",
      "фокус не вернулся на кнопку входа в форму");
    await page.locator("[data-panel-close]").click();

    await page.locator('[data-workspace-select="workspace-1"]').dblclick();
    await page.locator("[data-workspace-card-quick-messages]").click();
    assert.equal(await activeScope(page), "workspace");
    assert.deepEqual(await rowTitles(page), ["Workspace"]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.locator('.stream-tabs-track [data-stream-tab-id="stream-1"]').dblclick();
    await page.locator("[data-dialog-stream-quick-messages]").click();
    assert.equal(await activeScope(page), "stream");
    assert.deepEqual(await rowTitles(page), ["Stream"]);
    assert.equal(await saveCount(page), 0, "форма сохранила данные без нажатия «Сохранить»");
  } finally {
    await context.close();
  }
});

test("форма сохраняет правки сразу нескольких областей, отмена их отбрасывает", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await page.locator("[data-settings-global-quick-messages]").click();
    await page.locator(`${EDITOR} [data-quick-message-add]`).click();
    await page.locator(`${EDITOR} [data-quick-message-title]`).nth(1).fill("Продолжай");
    await page.locator(`${EDITOR} [data-quick-message-text]`).nth(1).fill("Продолжай работу");
    await page.locator(`${SCOPES} [data-prompt-templates-scope="workspace"]`).click();
    await page.locator(`${EDITOR} [data-quick-message-text]`).first().fill("Workspace prompt v2");
    // Возврат к первой области: несохранённая правка не потерялась.
    await page.locator(`${SCOPES} [data-prompt-templates-scope="global"]`).click();
    assert.deepEqual(await rowTitles(page), ["Принято", "Продолжай"]);

    await page.locator("[data-prompt-templates-save]").click();
    assert.equal(await page.locator("[data-prompt-templates-modal]").evaluate((node) => node.open), false);
    assert.equal(await saveCount(page), 1, "одна форма сохранила правки не одним намерением");
    assert.deepEqual(await savedQuickMessages(page), {
      global: [
        { title: "Принято", text: "Принято" },
        { title: "Продолжай", text: "Продолжай работу" },
      ],
      streams: {},
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt v2" }] },
    });
    assert.equal(await page.locator("[data-settings-global-quick-messages-count]").textContent(), "2 шаблона");

    // Сохранённый шаблон применяется кнопкой композера.
    await page.locator("[data-panel-close]").click();
    await page.locator('[data-composer-quick-messages] [data-quick-message-index]')
      .filter({ hasText: "Продолжай" }).click();
    assert.ok((await page.locator("[data-composer-input]").inputValue()).includes("Продолжай работу"),
      "шаблон не подставился в поле ввода");

    await page.locator('[data-panel-open="settings"]').click();
    await page.locator("[data-settings-global-quick-messages]").click();
    await page.locator(`${EDITOR} [data-quick-message-title]`).first().fill("Отменяемое");
    await page.locator("[data-prompt-templates-cancel]").click();
    assert.equal(await saveCount(page), 1, "отмена сохранила правку");
    await page.locator("[data-settings-global-quick-messages]").click();
    assert.deepEqual(await rowTitles(page), ["Принято", "Продолжай"],
      "отменённая правка вернулась в форму");
  } finally {
    await context.close();
  }
});

// Пока форма открыта, снимок может принести чужое обновление. Непочатая область
// обязана его подхватить, а сохранение — не вернуть на место устаревшие значения.
const pushSelection = (page, quickMessages) => page.evaluate(
  (messages) => window.AgentHub.setSelection({ quickMessages: messages }),
  quickMessages,
);

const conflictState = (page) => page.evaluate(() => ({
  visible: document.querySelector("[data-prompt-templates-conflict]")?.hidden === false,
  saveDisabled: document.querySelector("[data-prompt-templates-save]")?.disabled ?? null,
  text: document.querySelector("[data-prompt-templates-conflict-text]")?.textContent ?? "",
}));

test("непочатая область следует входящему обновлению и не затирает его сохранением", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await page.locator("[data-settings-global-quick-messages]").click();
    assert.deepEqual(await rowTitles(page), ["Принято"]);

    await pushSelection(page, {
      global: [{ title: "Извне", text: "Извне prompt" }],
      workspaces: { "workspace-1": [{ title: "Workspace извне", text: "Workspace извне prompt" }] },
      streams: {},
    });
    assert.deepEqual(await rowTitles(page), ["Извне"], "открытая форма не подхватила входящее обновление");
    assert.deepEqual(await conflictState(page), { visible: false, saveDisabled: false, text: "" });

    await page.locator("[data-prompt-templates-save]").click();
    assert.equal(await saveCount(page), 0, "форма сохранила устаревшие значения без единой правки");
    await page.locator("[data-settings-global-quick-messages]").click();
    assert.deepEqual(await rowTitles(page), ["Извне"]);
  } finally {
    await context.close();
  }
});

test("правка другой области сохраняется, а входящее обновление активной остаётся", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await page.locator("[data-settings-global-quick-messages]").click();
    await page.locator(`${SCOPES} [data-prompt-templates-scope="workspace"]`).click();
    await page.locator(`${EDITOR} [data-quick-message-text]`).first().fill("Workspace prompt v2");
    await page.locator(`${SCOPES} [data-prompt-templates-scope="global"]`).click();

    await pushSelection(page, {
      global: [{ title: "Извне", text: "Извне prompt" }],
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }] },
      streams: {},
    });
    assert.deepEqual(await rowTitles(page), ["Извне"], "непочатая активная область не обновилась");

    await page.locator("[data-prompt-templates-save]").click();
    assert.deepEqual(await savedQuickMessages(page), {
      global: [{ title: "Извне", text: "Извне prompt" }],
      streams: {},
      workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace prompt v2" }] },
    });
  } finally {
    await context.close();
  }
});

test("правка и внешнее обновление одной области дают явный конфликт без перетирания", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [{ title: "Принято", text: "Принято" }],
      workspaces: {},
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await page.locator("[data-settings-global-quick-messages]").click();
    await page.locator(`${EDITOR} [data-quick-message-title]`).first().fill("Моя правка");

    await pushSelection(page, {
      global: [{ title: "Извне", text: "Извне prompt" }],
      workspaces: {},
      streams: {},
    });
    const conflict = await conflictState(page);
    assert.equal(conflict.visible, true, "конфликт не показан");
    assert.equal(conflict.saveDisabled, true, "сохранение осталось доступным при конфликте");
    assert.ok(conflict.text.includes("изменились в другом месте"), conflict.text);
    assert.deepEqual(await rowTitles(page), ["Моя правка"], "черновик пользователя потерян");

    // Отправка формы помимо кнопки тоже не должна перетирать чужое значение.
    await page.locator("[data-prompt-templates-form]").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(await saveCount(page), 0, "конфликт перетёрт отправкой формы");
    assert.equal(await page.locator("[data-prompt-templates-modal]").evaluate((node) => node.open), true);

    await page.locator("[data-prompt-templates-reload]").click();
    assert.deepEqual(await rowTitles(page), ["Извне"]);
    assert.deepEqual(await conflictState(page), { visible: false, saveDisabled: false, text: "" });
  } finally {
    await context.close();
  }
});

test("порядок и удаление шаблонов работают в общей форме", async () => {
  const { context, page } = await openPage({ width: 1280, height: 900 });
  try {
    await seed(page, {
      global: [
        { title: "Первый", text: "Первый prompt" },
        { title: "Второй", text: "Второй prompt" },
        { title: "Третий", text: "Третий prompt" },
      ],
      workspaces: {},
      streams: {},
    });

    await page.locator('[data-panel-open="settings"]').click();
    await page.locator("[data-settings-global-quick-messages]").click();
    await page.locator(`${EDITOR} [data-quick-message-action="down"]`).first().click();
    assert.deepEqual(await rowTitles(page), ["Второй", "Первый", "Третий"]);
    // Фокус переезжает вместе со строкой, клавиатура не теряет место.
    assert.deepEqual(await page.evaluate(() => ({
      action: document.activeElement?.dataset?.quickMessageAction ?? null,
      row: document.activeElement?.closest("[data-quick-message-row]")?.dataset?.quickMessageRow ?? null,
    })), { action: "down", row: "1" });

    await page.locator(`${EDITOR} [data-quick-message-action="delete"]`).last().click();
    assert.deepEqual(await rowTitles(page), ["Второй", "Первый"]);

    await page.locator("[data-prompt-templates-save]").click();
    assert.deepEqual((await savedQuickMessages(page)).global, [
      { title: "Второй", text: "Второй prompt" },
      { title: "Первый", text: "Первый prompt" },
    ]);
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
        };
      });
      assert.ok(panel.overflow <= 1, `панель настроек прокручивается вбок на ${panel.overflow} px`);
      assert.ok(panel.documentOverflow <= 1, `страница прокручивается вбок на ${panel.documentOverflow} px`);
      if (screenshotDirectory) {
        await mkdir(screenshotDirectory, { recursive: true });
        await writeFile(
          path.join(screenshotDirectory, `settings-${surface}.png`),
          await page.screenshot({ fullPage: false }),
        );
      }

      await page.locator("[data-settings-global-quick-messages]").click();
      const form = await page.evaluate(() => {
        const fields = document.querySelector(".prompt-templates-fields");
        const rect = fields.getBoundingClientRect();
        const rows = [...fields.querySelectorAll("[data-quick-message-row]")];
        const actions = rows.flatMap((row) => [...row.querySelectorAll("[data-quick-message-action]")]);
        return {
          overflow: fields.scrollWidth - fields.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rows: rows.length,
          actions: actions.length,
          hiddenActions: actions.filter((node) => {
            const box = node.getBoundingClientRect();
            return box.width < 1 || box.height < 1 || box.right > rect.right + 1 || box.left < rect.left - 1;
          }).length,
          textWidths: rows.map((row) => Math.round(
            row.querySelector("[data-quick-message-text]").getBoundingClientRect().width,
          )),
        };
      });
      assert.equal(form.rows, 3);
      assert.equal(form.actions, 9, "не все кнопки порядка и удаления отрисованы");
      assert.ok(form.overflow <= 1, `форма прокручивается вбок на ${form.overflow} px`);
      assert.ok(form.documentOverflow <= 1, `страница с формой прокручивается вбок на ${form.documentOverflow} px`);
      assert.equal(form.hiddenActions, 0, "кнопки строки вышли за пределы формы или схлопнулись");
      assert.ok(Math.min(...form.textWidths) >= 120,
        `поле текста сжалось до ${Math.min(...form.textWidths)} px`);

      // Кнопка удаления остаётся именно кликабельной, а не только видимой.
      await page.locator(`${EDITOR} [data-quick-message-action="delete"]`).first().click();
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
