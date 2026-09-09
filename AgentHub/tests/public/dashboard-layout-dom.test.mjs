import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const THEMES = (await readdir(new URL("themes/", WEB_APP_ROOT), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const TEST_THEME_CATALOG = JSON.stringify(THEMES.map((id) => ({
  id,
  name: id,
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
})));

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

async function launchEdge(chromium) {
  if (process.platform === "win32") return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true });
}

async function openFixture(page) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "agent-hub.test") return route.abort();
    if (requestUrl.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("<!-- agent-hub-theme-styles -->", THEMES.map((id) => `<link rel="stylesheet" href="/themes/${id}/theme.css">`).join(""))
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    if (requestUrl.pathname === "/work-log.css") {
      return route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
    }
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
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
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => window.AgentHub && window.AgentHubTaskBoard);
  await page.evaluate(() => {
    window.__boardActions = [];
    document.addEventListener("agenthub:board-action", (event) => {
      window.__boardActions.push(JSON.parse(JSON.stringify(event.detail)));
    });
  });
}

const workspaces = [
  { id: "one", name: "Agent HUB", streams: [{ id: "stream", name: "Nova", displayName: "Nova" }] },
  { id: "two", name: "DevOps", streams: [] },
];
const task = (id, values = {}) => ({
  id, taskNumber: `HUB-${id}`, title: `Задача ${id}`, text: `Задача ${id}`,
  description: "Описание задачи", bucket: "workspace", workspaceId: "one",
  workflowStatus: "new", status: "open", revision: 1, attachments: [], checklist: [],
  ...values,
});
const tasks = [
  task("1"), task("2", { workflowStatus: "testing" }),
  task("3", { workspaceId: "two", workflowStatus: "in_progress" }),
  task("4", { bucket: "notes", workspaceId: null }),
  task("5", { bucket: "backlog", workspaceId: null }),
  task("6", { workflowStatus: "done" }),
  task("7", { status: "done", workflowStatus: "done" }),
];

async function setBoard(page, boardWorkspaces = workspaces) {
  await page.evaluate(({ tasks, workspaces }) => {
    document.documentElement.dataset.view = "dashboard";
    window.AgentHubTaskBoard.setSnapshot({ tasks, workspaces, columnOrder: ["notes", "workspace:two", "workspace:one"] });
  }, { tasks, workspaces: boardWorkspaces });
}

async function dropTask(page, taskId, target) {
  const dataTransfer = await page.evaluateHandle((id) => {
    const transfer = new DataTransfer();
    window.AgentHubTaskReferences.beginDrag(transfer, { id, title: id });
    return transfer;
  }, taskId);
  await target.dispatchEvent("drop", { dataTransfer });
  await page.evaluate(() => window.AgentHubTaskReferences.endDrag());
  await dataTransfer.dispose();
  return page.evaluate(() => window.__boardActions.at(-1));
}

test("Dashboard separates settings from filters and restores Workspace grouping", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    await openFixture(page);
    await setBoard(page, workspaces.map((workspace) => ({ ...workspace, settings: { catalogFolder: 'Team' } })));
    const changeView = async (view) => {
      await page.getByRole('button', { name: 'Настройки доски', exact: true }).click();
      await page.locator(`[data-task-board-view="${view}"]`).click();
    };
    await page.locator('[data-board-scope="workspace:one"]').click();
    assert.equal(await page.locator('.task-board-toolbar [data-task-board-view]').count(), 0);
    await page.locator('[data-task-board-filter-toggle]').click();
    assert.equal(await page.locator('[data-task-board-filter-controls] [data-task-status-language]').count(), 0);
    assert.equal(await page.locator('[data-task-board-completed-toggle]').isVisible(), true);
    await page.locator('[data-task-board-settings-toggle]').click();
    assert.equal(await page.locator('#task-board-settings').isVisible(), true);
    assert.equal(await page.locator('[data-task-status-language="ru"]').isVisible(), true);
    await page.locator('[data-task-board-view="workspaces"]').click();
    assert.equal(await page.locator('.task-board-sidebar').isVisible(), false);
    assert.ok((await page.locator('[data-task-board-columns]').boundingBox()).x < 25);
    const columns = page.locator('[data-task-board-columns] .task-board-column');
    assert.deepEqual(await columns.locator('h2').allTextContents(), ['Бэклог', 'DevOps', 'Agent HUB', 'Заметки']);
    const workspace = page.locator('[data-task-board-columns] [data-board-destination="workspace:one"]');
    assert.equal(await workspace.locator('[data-board-task-id]').count(), 3);
    assert.equal(await workspace.locator('[data-board-task-id="2"] .board-task-status').isVisible(), true);
    const row = workspace.locator('[data-board-task-id="2"]');
    const statusBox = await row.locator('.board-task-status').boundingBox();
    const streamBox = await row.locator('.board-task-executor').boundingBox();
    assert.ok(statusBox.x >= streamBox.x + streamBox.width, 'status is to the right of the stream');
    assert.equal(statusBox.y, streamBox.y);
    await workspace.getByRole('button', { name: 'Создать', exact: true }).click();
    assert.equal(await workspace.locator('textarea').isVisible(), true);
    assert.deepEqual(await dropTask(page, '1', page.locator('[data-task-board-columns] [data-board-destination="workspace:two"]')),
      { type: 'move', id: '1', bucket: 'workspace', workspaceId: 'two', beforeId: null });
    await changeView('statuses');
    assert.equal(await page.locator('.task-board-sidebar').isVisible(), true);
    assert.equal(await page.locator('[data-board-scope="workspace:one"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-board-scope="folder:Team"]').click();
    await changeView('workspaces');
    assert.equal(await columns.count(), 4, 'hidden folder selection does not restrict Workspace view');
    await page.reload();
    await setBoard(page);
    assert.equal(await page.locator('[data-task-board-view="workspaces"]').getAttribute('aria-pressed'), 'true');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.task-board-sidebar').isVisible(), false);
    assert.ok((await page.locator('[data-task-board-columns]').boundingBox()).y < 200);
    await changeView('statuses');
    assert.equal(await page.locator('.is-status-testing').count(), 1);
  } finally { await browser.close(); }
});

test("Dashboard saves each task opening mode and retains drafts when switching", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    await openFixture(page);
    await setBoard(page);
    const chooseMode = async (mode) => {
      await page.locator('[data-task-board-settings-toggle]').click();
      await page.locator(`[data-task-open-mode="${mode}"]`).click();
    };
    const row = page.locator('[data-task-board-columns] [data-board-task-id="1"]');
    const dialog = page.locator('[data-task-card-modal]');
    await chooseMode('modal');
    await row.dblclick();
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), true);
    assert.equal(await page.locator('.task-card-backdrop').count(), 0);
    assert.equal(await page.locator('[data-task-board]').evaluate((el) => el.classList.contains('has-open-task')), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-task-card-modal]').open);
    await chooseMode('side');
    await row.dblclick();
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), false);
    await row.press('Shift+Enter');
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), false);
    await page.locator('[data-task-card-edit-toggle]').click();
    await page.locator('[data-task-card-title]').fill('Сохранить черновик');
    await chooseMode('modal');
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), true);
    assert.equal(await page.locator('[data-task-card-title]').inputValue(), 'Сохранить черновик');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-task-card-modal]').open);
    await chooseMode('both');
    await row.dblclick();
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), true);
    assert.equal(await page.locator('.task-card-backdrop').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-task-card-modal]').matches(':modal'));
    assert.equal(await dialog.isVisible(), true);
    await page.keyboard.press('Escape');
    await chooseMode('side');
    await page.reload();
    await setBoard(page);
    await row.click();
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('[data-task-card-modal]').matches(':modal'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-task-card-modal]').open);
    await page.locator('[data-task-board-settings-toggle]').click();
    const box = await page.locator('#task-board-settings').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.equal(await page.locator('[data-task-open-mode="side"]').getAttribute('aria-pressed'), 'true');
  } finally { await browser.close(); }
});

test("Backlog stays separate in every scope and hides status in docked and modal cards", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    await openFixture(page);
    await setBoard(page, workspaces.map((workspace) => ({ ...workspace, settings: { catalogFolder: "Team" } })));
    const board = page.locator('[data-task-board-columns]');
    assert.equal(await page.locator('[data-board-scope="all"]').textContent(), 'Все задачи · 6');
    for (const scope of ['all', 'workspace:one', 'folder:Team', 'notes']) {
      await page.locator(`[data-board-scope="${scope}"]`).click();
      assert.equal(await board.locator('[data-board-task-id="5"]').count(), 1);
      assert.equal(await board.locator('.is-backlog [data-board-task-id="5"]').count(), 1);
      assert.equal(await board.locator('[class*="is-status-"] [data-board-task-id="5"]').count(), 0);
    }
    const backlog = board.locator('[data-board-task-id="5"]');
    await backlog.click();
    const field = page.locator('[data-task-card-modal] .task-card-status-field');
    for (const theme of THEMES) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await backlog.locator('.board-task-status').isVisible(), false, theme);
      assert.equal(await field.isVisible(), false, theme);
    }
    await backlog.dblclick();
    assert.equal(await page.locator('[data-task-card-modal]').evaluate((el) => el.matches(':modal')), true);
    assert.equal(await field.isVisible(), false);
    await page.keyboard.press('Escape');
    const actionCount = await page.evaluate(() => window.__boardActions.length);
    await dropTask(page, '5', board.locator('.is-status-testing'));
    assert.equal(await page.evaluate(() => window.__boardActions.length), actionCount);
    await page.keyboard.press('Escape');
    await page.locator('[data-board-scope="all"]').click();
    await board.locator('[data-board-task-id="1"]').click();
    assert.equal(await field.isVisible(), true, 'status returns for a Workspace task');
    assert.equal(await page.evaluate(() => window.__boardActions.length), 0, 'hiding status never changes task data');
  } finally { await browser.close(); }
});

test("Dashboard preserves scope, create, filter and native drop commands", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    await openFixture(page);
    await setBoard(page);
    const board = page.locator("[data-task-board-columns]");
    assert.equal(await board.locator(".task-board-column").count(), 6);
    assert.equal(await board.locator(".is-backlog").count(), 1);
    assert.equal(await board.locator('[data-board-task-id="6"]').count(), 1, "workflow Done remains visible until closed");
    assert.equal(await board.locator('[data-board-task-id="1"]').getAttribute("draggable"), "true");
    const scopes = await page.locator("[data-task-board-scopes] button").allTextContents();
    assert.match(scopes[1], /Заметки/u);
    assert.match(scopes[2], /DevOps/u);
    await page.getByRole("button", { name: /^Agent HUB ·/u }).click();
    assert.equal(await board.locator('[data-board-task-id="3"]').count(), 0);
    assert.equal(await board.locator('[data-board-task-id="4"]').count(), 0);
    assert.equal(await board.locator('[data-board-task-id="5"]').count(), 1);
    await page.getByRole("button", { name: "Создать", exact: true }).click();
    assert.equal(await board.locator(".task-board-inline-create textarea").isVisible(), true);
    await page.getByRole("button", { name: /^Заметки ·/u }).click();
    assert.equal(await board.locator('[data-board-task-id="4"]').count(), 1);
    assert.equal(await board.locator('[data-board-task-id="1"]').count(), 0);
    await page.getByRole("button", { name: /^Все задачи ·/u }).click();
    assert.deepEqual(await dropTask(page, "1", page.locator('.is-status-testing')), { type: "status", id: "1", status: "testing" });
    const actionCount = await page.evaluate(() => window.__boardActions.length);
    await dropTask(page, "1", page.locator('.is-status-testing'));
    assert.equal(await page.evaluate(() => window.__boardActions.length), actionCount, "one pending status operation");
    await page.evaluate(() => window.AgentHubTaskBoard.finishAction({ type: "status", id: "1", succeeded: true }));
    assert.deepEqual(await dropTask(page, "1", page.getByRole("button", { name: /^DevOps ·/u })), { type: "move", id: "1", bucket: "workspace", workspaceId: "two", beforeId: null });
    await page.getByRole("button", { name: /^Agent HUB ·/u }).click();
    assert.deepEqual(await dropTask(page, "1", page.locator(".is-backlog")), { type: "move", id: "1", bucket: "backlog", beforeId: null });
    await page.getByRole("button", { name: /^Все задачи ·/u }).click();
    assert.equal(await page.locator("[data-task-board-filter-controls]").isVisible(), false);
    await page.locator("[data-task-board-filter-toggle]").click();
    assert.equal(await page.locator("[data-task-board-filter-controls]").isVisible(), true);
    await page.locator('[data-task-board-settings-toggle]').click();
    await page.locator('[data-task-status-language="ru"]').click();
    await page.locator('[data-task-board-settings-toggle]').click();
    assert.match(await page.locator(".is-status-testing h2").textContent(), /Тест/u);
    await page.locator("[data-task-board-completed-toggle]").click();
    assert.equal(await board.locator(".board-task-card").count(), 1);
    assert.equal(await board.locator('[data-board-task-id="7"]').count(), 1);
  } finally { await browser.close(); }
});

test("Dashboard detail is a theme-safe grid panel and becomes a modal on narrow screens", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page);
    await setBoard(page, [...workspaces, ...Array.from({ length: 20 }, (_, index) => ({
      id: `extra-${index}`, name: `Дополнительный Workspace ${index}`, streams: [],
    }))]);
    await page.locator('[data-task-board-columns] [data-board-task-id="1"]').click();
    const dialog = page.locator("[data-task-card-modal]");
    for (const theme of THEMES) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const boxes = await page.evaluate(() => {
        const box = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width };
        };
        return { board: box("[data-task-board-columns]"), detail: box("[data-task-card-modal]"), toolbar: box(".task-board-toolbar"),
          filter: box("[data-task-board-filter-toggle]"), scopes: box("[data-task-board-scopes]"),
          modal: document.querySelector("[data-task-card-modal]").matches(":modal") };
      });
      assert.equal(boxes.modal, false, theme);
      assert.ok(boxes.board.right <= boxes.detail.x + 1, `${theme}: board does not overlap detail`);
      assert.ok(Math.abs(boxes.board.y - boxes.detail.y) < 1, `${theme}: aligned top boundaries`);
      assert.ok(boxes.toolbar.bottom <= boxes.detail.y + 1, `${theme}: full-width toolbar above panel`);
      assert.ok(boxes.filter.right <= boxes.toolbar.right, `${theme}: filters stay inside toolbar with many Workspaces`);
      assert.ok(boxes.scopes.right <= boxes.filter.x, `${theme}: scopes scroll without covering filters`);
      assert.ok(boxes.board.x >= 8 && boxes.detail.right < 1487, `${theme}: small outer gutters`);
      assert.equal(await page.locator('.task-board-row-head').first().evaluate((el) => {
        const cells = [...el.children].map((child) => child.getBoundingClientRect());
        return cells.every((cell, index) => index === 0 || cells[index - 1].right <= cell.x);
      }), true, `${theme}: metadata headings do not overlap`);
      assert.equal(await page.locator("[data-task-preview-title]").textContent(), "Задача 1");
    }
    await page.locator("[data-task-card-edit-toggle]").click();
    await page.locator("[data-task-card-title]").fill("Черновик без потери");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("[data-task-card-modal]").matches(":modal"));
    assert.equal(await dialog.evaluate((el) => el.matches(":modal")), true);
    assert.equal(await page.locator("[data-task-card-title]").inputValue(), "Черновик без потери");
    const mobile = await dialog.boundingBox();
    assert.ok(mobile.x >= 0 && mobile.x + mobile.width <= 391);
    await page.setViewportSize({ width: 1487, height: 1058 });
    await page.waitForFunction(() => !document.querySelector("[data-task-card-modal]").matches(":modal"));
    assert.equal(await dialog.evaluate((el) => el.matches(":modal")), false);
    assert.equal(await page.locator("[data-task-card-title]").inputValue(), "Черновик без потери");
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator('[data-task-board-columns] [data-board-task-id="1"]').evaluate((el) => document.activeElement === el), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("Dashboard groups existing folders, selects their Workspaces and opens the standard card on double click", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page);
    const groupedWorkspaces = workspaces.map((workspace) => ({ ...workspace, settings: { catalogFolder: "Команда" } }));
    await setBoard(page, groupedWorkspaces);
    const rows = page.locator("[data-task-board-columns]");
    const first = rows.locator('[data-board-task-id="1"]');
    assert.equal(await first.locator(".board-task-workspace").textContent(), "Agent HUB");
    const metadata = await first.evaluate((el) => {
      const box = (selector) => el.querySelector(selector).getBoundingClientRect().toJSON();
      return { id: box('.board-task-number'), workspace: box('.board-task-workspace'),
        stream: box('.board-task-executor'), title: box('.board-task-title') };
    });
    assert.equal(metadata.id.y, metadata.workspace.y);
    assert.equal(metadata.id.y, metadata.stream.y);
    assert.ok(metadata.id.right <= metadata.workspace.x);
    assert.ok(metadata.workspace.right <= metadata.stream.x);
    assert.ok(metadata.title.y >= metadata.workspace.bottom);
    assert.equal(metadata.title.x, metadata.id.x);
    const sidebar = page.locator('.task-board-sidebar');
    const sidebarBox = await sidebar.boundingBox();
    assert.ok(sidebarBox.x >= 8);
    assert.ok(sidebarBox.x + sidebarBox.width <= (await rows.boundingBox()).x);
    const folder = page.locator('[data-board-scope="folder:Команда"]');
    await folder.click();
    assert.equal(await rows.locator('[data-board-task-id="4"]').count(), 0);
    assert.equal(await rows.locator('[data-board-task-id="3"]').count(), 1);
    assert.equal(await rows.locator('.is-backlog').count(), 1);
    const toggle = page.getByRole('button', { name: 'Выбрать Workspace в папке Команда' });
    const member = sidebar.locator('[data-board-scope="workspace:one"]');
    await toggle.click();
    assert.equal(await member.isVisible(), false);
    await toggle.click();
    assert.equal(await member.isVisible(), true);
    await member.click();
    assert.equal(await rows.locator('[data-board-task-id="3"]').count(), 0);
    assert.equal(await first.locator('.board-task-workspace').textContent(), '');
    await first.click();
    const dialog = page.locator("[data-task-card-modal]");
    assert.equal(await dialog.evaluate((el) => el.matches(":modal")), false);
    await first.dblclick();
    assert.equal(await dialog.evaluate((el) => el.matches(":modal")), true);
    assert.equal(await page.locator("[data-task-card-title]").isVisible(), true);
    const backdrop = page.locator('.task-card-backdrop');
    assert.equal(await backdrop.isVisible(), true, 'right panel remains visible beneath the modal');
    assert.equal(await backdrop.getAttribute('inert'), '');
    assert.deepEqual(await backdrop.locator('[id], [data-task-card-title]').evaluateAll((elements) => elements.map((el) => ({ tag: el.tagName, id: el.id, data: el.getAttribute('data-task-card-title') }))), [], 'one editor identity');
    const dockBefore = await backdrop.boundingBox();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-task-card-modal]').matches(':modal'));
    assert.equal(await dialog.isVisible(), true, 'modal dismissal retains the right panel');
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), false);
    assert.equal(await backdrop.count(), 0);
    assert.equal((await dialog.boundingBox()).x, dockBefore.x);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    await rows.locator('[data-board-task-id="2"]').dblclick();
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), true, 'double click from a later column with the panel closed');
    assert.equal(await page.locator('[data-task-card-title]').inputValue(), 'Задача 2');
    await page.locator('[data-task-card-title]').fill('Черновик в модальной карточке');
    await page.locator('[data-task-card-close]').click();
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), false);
    assert.equal(await page.locator('[data-task-card-title]').inputValue(), 'Черновик в модальной карточке');
    await page.keyboard.press('Escape');
    await first.press('Shift+Enter');
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), true);
    await page.mouse.click(2, 2);
    assert.equal(await dialog.isVisible(), true, 'outside dismissal retains the panel');
    assert.equal(await dialog.evaluate((el) => el.matches(':modal')), false);
    await page.keyboard.press('Escape');
    assert.deepEqual(await dropTask(page, '1', sidebar.locator('[data-board-scope="workspace:two"]')),
      { type: 'move', id: '1', bucket: 'workspace', workspaceId: 'two', beforeId: null });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileSidebar = await sidebar.boundingBox();
    assert.ok(mobileSidebar.x >= 0 && mobileSidebar.x + mobileSidebar.width <= 390);
    await sidebar.locator('[data-board-scope="workspace:two"]').click();
    assert.equal(await rows.locator('[data-board-task-id="1"]').count(), 0);
    assert.equal(await rows.locator('[data-board-task-id="3"]').count(), 1);
    await setBoard(page, workspaces);
    assert.equal(await page.locator(".task-board-folder").count(), 0);
    await page.setViewportSize({ width: 1487, height: 1058 });
    await page.locator('[data-board-scope="all"]').click();
    const clickPoint = await first.boundingBox();
    await first.click();
    const previousRow = await first.elementHandle();
    await setBoard(page, [...workspaces, { id: "three", name: "Another", streams: [] }]);
    assert.equal(await previousRow.evaluate((el) => el.isConnected), false);
    const secondClick = { detail: 2, button: 0, clientX: clickPoint.x + clickPoint.width / 2, clientY: clickPoint.y + clickPoint.height / 2 };
    await first.dispatchEvent('click', secondClick);
    await first.dispatchEvent('dblclick', secondClick);
    assert.equal(await dialog.evaluate((el) => el.matches(":modal")), false, "a replaced row cannot inherit a double click");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

