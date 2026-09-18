import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";

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

async function openFixture(page, { grouping = 'off' } = {}) {
  if (grouping != null) await page.addInitScript((value) => {
    if (localStorage.getItem('agent-hub.dashboard.group-workspaces') == null) {
      localStorage.setItem('agent-hub.dashboard.group-workspaces', value);
    }
  }, grouping);
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

test("Task card opens exact journal links and fences on-demand Git previews", { timeout: 30_000 }, async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(5_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openFixture(page);
      await page.evaluate(({ tasks, workspaces }) => {
        document.documentElement.dataset.view = "dashboard";
        tasks[0].workLog = [
          { provider: "codex", threadId: "old-thread", taskThreadId: "parent-thread", turnId: "exact-turn",
            summary: "Ревью без правок", status: "completed", createdAt: "2026-09-15T00:00:00Z" },
          { provider: "claude", summary: "Старая запись без адреса", status: "completed" },
        ];
        window.AgentHubTaskBoard.setSnapshot({ tasks, workspaces });
      }, { tasks, workspaces });
      await page.locator('[data-board-task-id="1"]').first().click();
      const panel = page.locator(".task-card-modal");
      assert.equal(await panel.getByText("Изменённые файлы", { exact: true }).count(), 0);
      const link = panel.getByRole("link", { name: "Ревью без правок" });
      assert.equal(await link.count(), 1);
      assert.equal(await link.getAttribute("href"), "#/chat/codex/parent-thread/turn/old-thread/exact-turn");
      await panel.getByRole("button", { name: "Git Diff", exact: true }).click();
      const first = await page.evaluate(() => window.__boardActions.at(-1));
      assert.equal(first.type, "diff");
      assert.equal(first.id, "1");
      await panel.getByRole("button", { name: "Git Diff", exact: true }).click();
      const second = await page.evaluate(() => window.__boardActions.at(-1));
      await page.evaluate(({ first, second }) => {
        window.AgentHubTaskBoard.showDiff({ ...second, result: { repositories: [
          { branch: "HUB-1", projectRoot: "task/worktree", text: "diff --git a/app.js b/app.js\n+new code" },
        ], truncated: true } });
        window.AgentHubTaskBoard.showDiff({ ...first, error: "stale error" });
      }, { first, second });
      const diff = panel.locator("[data-task-card-diff]");
      assert.match(await diff.textContent(), /new code/u);
      assert.match(await diff.textContent(), /Показана часть diff/u);
      assert.doesNotMatch(await diff.textContent(), /stale error/u);
      if (process.env.AGENT_HUB_QA_SCREENSHOT) {
        await page.screenshot({ path: process.env.AGENT_HUB_QA_SCREENSHOT.replace(".png", "-" + width + ".png") });
      }
      await link.click();
      assert.match(page.url(), /#\/chat\/codex\/parent-thread\/turn\/old-thread\/exact-turn$/u);
      await page.locator('[data-board-task-id="2"]').first().click();
      await page.evaluate((old) => window.AgentHubTaskBoard.showDiff({
        ...old, error: "wrong Task",
      }), second);
      assert.equal(await panel.locator("[data-task-card-diff]").isVisible(), false);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("Task description editor submits text beyond the former character limit", { timeout: 20_000 }, async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page);
    await setBoard(page);
    await page.locator('[data-board-task-id="1"]').first().click();
    await page.locator("[data-task-card-edit-toggle]").click();
    const editor = page.locator("[data-task-card-description]");
    const description = "Полное описание 🚀 ".repeat(3_000).trim();
    await editor.fill("");
    await editor.focus();
    await page.keyboard.insertText(description);
    assert.equal(await editor.inputValue(), description);
    await page.locator(".task-card-modal").getByRole("button", { name: "Сохранить изменения", exact: true }).click();
    const action = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(action.type, "update");
    assert.equal(action.description, description);
    if (process.env.AGENT_HUB_QA_SCREENSHOT) {
      await page.screenshot({ path: process.env.AGENT_HUB_QA_SCREENSHOT });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("Task creation form submits complete long text", { timeout: 20_000 }, async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5_000);
    await openFixture(page);
    await setBoard(page);
    await page.locator("[data-task-board-settings-toggle]").click();
    await page.locator('[data-task-board-view="workspaces"]').click();
    await page.locator(".task-board-create-button").first().click();
    const input = page.locator(".task-board-inline-create textarea").first();
    const text = "Требования 🚀 ".repeat(3_000).trim();
    await input.focus();
    await page.keyboard.insertText(text);
    assert.equal(await input.inputValue(), text);
    await page.locator(".task-board-inline-create").first().getByRole("button", { name: "Добавить", exact: true }).click();
    const action = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(action.type, "create");
    assert.equal(action.text, text);
  } finally {
    await browser.close();
  }
});

test("Blocked Dashboard status is red and retains its prerequisite across snapshots", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openFixture(page);
      const blocked = task("42", { title: "Подключить фоны", workflowStatus: "blocked",
        blockedBy: { taskId: "41", taskNumber: "HUB-41" } });
      await page.evaluate(({ blocked, workspaces }) => {
        document.documentElement.dataset.view = "dashboard";
        window.AgentHubTaskBoard.setSnapshot({ tasks: [blocked], workspaces });
      }, { blocked, workspaces });
      const card = page.locator('[data-board-task-id="42"]').first();
      const badge = card.locator('[data-workflow-status="blocked"]');
      assert.equal(await badge.textContent(), "Blocked");
      assert.equal(await badge.evaluate((el) => getComputedStyle(el).color), "rgb(229, 72, 77)");
      assert.notEqual(await page.locator(".is-status-blocked .task-board-column-head h2").evaluate((el) => getComputedStyle(el).color), "rgb(229, 72, 77)");
      assert.notEqual(await card.locator(".board-task-blocked-reason").evaluate((el) => getComputedStyle(el).color), "rgb(229, 72, 77)");
      assert.equal(await card.locator(".board-task-blocked-reason").textContent(), "Ожидает релиза HUB-41");
      await card.click();
      assert.equal(await page.locator(".task-card-modal[open]").count(), 1);
      await page.keyboard.press("Escape");
      await page.evaluate(({ blocked, workspaces }) => window.AgentHubTaskBoard.setSnapshot({
        tasks: [{ ...blocked, revision: 2 }], workspaces,
      }), { blocked, workspaces });
      assert.equal(await badge.textContent(), "Blocked");
      await page.locator('[data-task-board-settings-toggle]').click();
      await page.locator('[data-task-board-view="workspaces"]').click();
      assert.equal(await badge.isVisible(), true);
      assert.equal(await badge.evaluate((el) => getComputedStyle(el).color), "rgb(229, 72, 77)");
      await page.screenshot({ path: path.join(os.tmpdir(), `hub235-blocked-${width}.png`) });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

async function dropTask(page, taskId, target, { confirmMove = false } = {}) {
  const dataTransfer = await page.evaluateHandle((id) => {
    const transfer = new DataTransfer();
    window.AgentHubTaskReferences.beginDrag(transfer, { id, title: id });
    return transfer;
  }, taskId);
  await target.dispatchEvent("drop", { dataTransfer });
  await page.evaluate(() => window.AgentHubTaskReferences.endDrag());
  await dataTransfer.dispose();
  if (confirmMove) {
    await page.locator('[data-task-move-modal]').getByRole('button', { name: 'Перенести', exact: true }).click();
  }
  return page.evaluate(() => {
    const { requestId: _requestId, ...action } = window.__boardActions.at(-1) || {};
    return action;
  });
}

test("Status drops choose ownership, confirm Workspace changes and await the exact move result", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1752, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await openFixture(page, { grouping: 'on' });
    await setBoard(page);
    const target = page.locator('[data-task-board-group="workspace:two"] .is-status-testing');
    const source = page.locator('.is-backlog [data-board-task-id="5"]');
    await source.dragTo(target);
    const move = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(move.type, 'move');
    assert.equal(move.id, '5');
    assert.equal(move.workspaceId, 'two');
    assert.ok(move.requestId);
    assert.equal(await page.evaluate(() => window.__boardActions.length), 1, 'status waits for the move receipt');
    await page.evaluate(move => window.AgentHubTaskBoard.finishAction({ ...move, requestId: 'other', succeeded: true }), move);
    assert.equal(await page.evaluate(() => window.__boardActions.length), 1, 'unrelated receipt cannot advance a move');
    await page.evaluate(({ move, tasks, workspaces }) => {
      const moved = tasks.map(task => task.id === '5' ? { ...task, bucket: 'workspace', workspaceId: 'two', revision: 2 } : task);
      window.AgentHubTaskBoard.setSnapshot({ tasks: moved, workspaces });
      window.AgentHubTaskBoard.finishAction({ ...move, succeeded: true });
      window.AgentHubTaskBoard.finishAction({ ...move, succeeded: true });
    }, { move, tasks, workspaces });
    const status = await page.evaluate(() => window.__boardActions.at(-1));
    assert.deepEqual(status, { type: 'status', id: '5', status: 'testing', requestId: move.requestId });
    assert.equal(await page.evaluate(() => window.__boardActions.length), 2, 'one status command even after a duplicate receipt');
    await page.evaluate(status => window.AgentHubTaskBoard.finishAction({ ...status, succeeded: false }), status);
    assert.equal(await page.getByText('Задача перенесена, но изменить статус не удалось. Текущий статус сохранён.', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('[data-task-board-group="workspace:two"] .is-status-new [data-board-task-id="5"]').count(), 1, 'failed status retains the confirmed location and actual status');
    await setBoard(page);
    await page.evaluate(() => { window.__boardActions = []; });
    await page.locator('[data-task-board-group="workspace:one"] [data-board-task-id="1"]').dragTo(target);
    const dialog = page.locator('[data-task-move-modal]');
    assert.equal(await dialog.isVisible(), true);
    assert.match(await dialog.textContent(), /Agent HUB.*DevOps.*Привязка к потоку будет снята/su);
    assert.equal(await page.evaluate(() => window.__boardActions.length), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__boardActions.length), 0, 'Escape cancels without side effects');
    await dropTask(page, '1', target);
    await dialog.getByRole('button', { name: 'Перенести', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__boardActions.length), 1);
    const crossMove = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(crossMove.workspaceId, 'two');
    await page.evaluate(move => window.AgentHubTaskBoard.finishAction({ ...move, succeeded: false }), crossMove);
    assert.equal(await page.evaluate(() => window.__boardActions.length), 1, 'failed placement never sends a status command');
    assert.equal(await page.locator('[data-task-board-group="workspace:one"] [data-board-task-id="1"]').count(), 1);
    await dropTask(page, '1', target);
    await page.evaluate(({ tasks, workspaces }) => window.AgentHubTaskBoard.setSnapshot({
      tasks: tasks.map(task => task.id === '1' ? { ...task, revision: 9 } : task), workspaces,
    }), { tasks, workspaces });
    await dialog.getByRole('button', { name: 'Перенести', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__boardActions.length), 1, 'changed Task invalidates the open confirmation');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("Flat status drop from Backlog asks for a Workspace only when the destination is ambiguous", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1752, height: 1000 } });
    await openFixture(page);
    await setBoard(page);
    const target = page.locator('[data-task-board-columns] .is-status-testing');
    await dropTask(page, '5', target);
    const dialog = page.locator('[data-task-move-modal]');
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Перенести', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Воркспейс назначения' }).click();
    await page.getByRole('option', { name: 'DevOps', exact: true }).click();
    await dialog.getByRole('button', { name: 'Перенести', exact: true }).click();
    const move = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(move.workspaceId, 'two');
    await page.evaluate(move => window.AgentHubTaskBoard.finishAction({ ...move, succeeded: false }), move);
    await page.locator('[data-board-scope="workspace:one"]').click();
    await dropTask(page, '5', target);
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.evaluate(() => window.__boardActions.at(-1).workspaceId), 'one');
  } finally { await browser.close(); }
});

test("Dashboard keeps view and filters visible and restores Workspace grouping", async () => {
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
    assert.equal(await page.locator('.task-board-toolbar [data-task-board-view]').count(), 3);
    assert.equal(await page.locator('[data-task-board-filter-controls] [data-task-status-language]').count(), 0);
    assert.equal(await page.locator('[data-task-board-completed-toggle]').isVisible(), true);
    await page.locator('[data-task-board-settings-toggle]').click();
    assert.equal(await page.locator('#task-board-settings').isVisible(), true);
    assert.equal(await page.locator('[data-task-status-language="ru"]').isVisible(), true);
    await page.locator('[data-task-board-view="workspaces"]').click();
    assert.equal(await page.locator('.task-board-sidebar').isVisible(), true);
    assert.equal(await page.locator('.task-board-scope-control').isVisible(), false);
    await page.locator('[data-board-scope="all"]').click();
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
    assert.deepEqual(await dropTask(page, '1', page.locator('[data-task-board-columns] [data-board-destination="workspace:two"]'), { confirmMove: true }),
      { type: 'move', id: '1', bucket: 'workspace', workspaceId: 'two', beforeId: null });
    await changeView('statuses');
    assert.equal(await page.locator('.task-board-sidebar').isVisible(), true);
    await page.locator('[data-board-scope="workspace:one"]').click();
    await page.locator('[data-board-scope="folder:Team"]').click();
    await changeView('workspaces');
    assert.equal(await columns.count(), 3, 'visible folder scope restricts Workspaces and keeps Backlog');
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

test("Native Task drag uses one bounded bitmap and delivers one Task in each board view", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    for (const view of ['grouped', 'flat', 'legacy']) {
      const page = await browser.newPage({ viewport: { width: 1752, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openFixture(page, { grouping: view === 'grouped' ? 'on' : 'off' });
      await setBoard(page);
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'pulsar';
        document.documentElement.dataset.surface = 'browser';
        const textByCanvas = new WeakMap();
        const fill = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
          const texts = textByCanvas.get(this.canvas) || [];
          texts.push(text); textByCanvas.set(this.canvas, texts);
          return fill.call(this, text, ...args);
        };
        const set = DataTransfer.prototype.setDragImage;
        DataTransfer.prototype.setDragImage = function(image, ...args) {
          window.__dragImage = { tag: image.tagName, width: image.width, height: image.height,
            texts: textByCanvas.get(image), dataUrl: image.toDataURL(),
            reference: window.AgentHubTaskReferences.fromTransfer(this) };
          return set.call(this, image, ...args);
        };
      });
      if (view === 'legacy') {
        await page.locator('[data-task-board-settings-toggle]').click();
        await page.locator('[data-task-board-view="workspaces"]').click();
      }
      const board = page.locator('[data-task-board-columns]');
      const source = board.locator('[data-board-task-id="1"]');
      const target = view === 'legacy' ? board.locator('[data-board-task-id="3"]')
        : view === 'grouped' ? page.locator('.task-board-matrix-head .is-status-testing')
          : board.locator('.is-status-testing .task-board-column-head');
      await source.dragTo(target);
      if (view === 'legacy') await page.getByRole('button', { name: 'Перенести', exact: true }).click();
      const image = await page.evaluate(() => window.__dragImage);
      assert.equal(image.tag, 'CANVAS', view);
      assert.equal(image.width, 360, view);
      assert.equal(image.height, 110, view);
      assert.equal(image.reference.taskId, '1', view);
      assert.ok(image.texts.includes('Задача 1'), view);
      assert.ok(!image.texts.some(text => /Задача [2-7]/u.test(text)), view);
      const actions = await page.evaluate(() => window.__boardActions);
      assert.equal(actions.length, 1, view);
      assert.equal(actions[0].id, '1', view);
      assert.equal(actions[0].type, view === 'legacy' ? 'move' : 'status', view);
      if (view !== 'legacy') assert.equal(actions[0].status, 'testing', view);
      assert.deepEqual(errors, [], view);
      await page.close();
    }
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
    assert.equal(await board.locator(".task-board-column").count(), 7);
    assert.equal(await board.locator(".is-status-blocked").count(), 1);
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
    assert.deepEqual(await dropTask(page, "1", page.getByRole("button", { name: /^DevOps ·/u }), { confirmMove: true }), { type: "move", id: "1", bucket: "workspace", workspaceId: "two", beforeId: null });
    await page.evaluate(() => window.AgentHubTaskBoard.finishAction({ ...window.__boardActions.at(-1), succeeded: true }));
    await page.getByRole("button", { name: /^Agent HUB ·/u }).click();
    assert.deepEqual(await dropTask(page, "1", page.locator(".is-backlog")), { type: "move", id: "1", bucket: "backlog", beforeId: null });
    await page.getByRole("button", { name: /^Все задачи ·/u }).click();
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
          filter: box("[data-task-board-completed-toggle]"), scopes: box("[data-task-board-scopes]"),
          modal: document.querySelector("[data-task-card-modal]").matches(":modal") };
      });
      assert.equal(boxes.modal, false, theme);
      assert.ok(boxes.board.right <= boxes.detail.x + 1, `${theme}: board does not overlap detail`);
      assert.ok(Math.abs(boxes.board.y - boxes.detail.y) < 1, `${theme}: aligned top boundaries`);
      assert.ok(boxes.toolbar.bottom <= boxes.board.y + 1, `${theme}: controls are above the board`);
      assert.ok(boxes.toolbar.x >= boxes.board.x - 1, `${theme}: controls align with board`);
      assert.ok(boxes.filter.right <= boxes.toolbar.right, `${theme}: filters stay inside toolbar with many Workspaces`);
      assert.ok(boxes.scopes.right <= boxes.board.x + 1, `${theme}: Workspace catalog stays beside board`);
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
    assert.deepEqual(await dropTask(page, '1', sidebar.locator('[data-board-scope="workspace:two"]'), { confirmMove: true }),
      { type: 'move', id: '1', bucket: 'workspace', workspaceId: 'two', beforeId: null });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await sidebar.isVisible(), false);
    const mobileScope = page.locator('[data-task-board-scope-select]');
    const mobileControl = await mobileScope.locator('..').boundingBox();
    assert.ok(mobileControl.x >= 0 && mobileControl.x + mobileControl.width <= 390);
    await mobileScope.selectOption('workspace:two', { force: true });
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



test("Status matrix groups by Workspace, preserves navigation and supports the optional flat view", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1752, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openFixture(page, { grouping: null });
    await setBoard(page);
    const board = page.locator('[data-task-board-columns]');
    const matrix = page.locator('[data-task-board-matrix]');
    const one = page.locator('[data-task-board-group="workspace:one"]');
    const two = page.locator('[data-task-board-group="workspace:two"]');
    const settings = page.locator('[data-task-board-settings-toggle]');
    const switchGrouping = async () => {
      await settings.click();
      await page.getByLabel('Группировать по воркспейсам', { exact: true }).click();
    };
    assert.equal(await matrix.isVisible(), true, 'grouped by default');
    assert.deepEqual(await page.locator('.task-board-lane-heading > span:first-child').allTextContents(), ['DevOps', 'Agent HUB', 'Заметки']);
    assert.equal(await board.locator('[data-board-task-id]').count(), 6);
    assert.equal(await one.locator('[data-board-task-id]').count(), 3);
    assert.equal(await two.locator('[data-board-task-id]').count(), 1);
    assert.equal(await board.locator('.is-backlog [data-board-task-id="5"]').count(), 1);
    assert.equal(await matrix.locator('[data-board-task-id="5"]').count(), 0);
    assert.equal(await page.locator('.task-board-matrix-head .is-status-new .task-board-count').textContent(), '2');
    const first = one.locator('[data-board-task-id="1"]');
    for (const theme of THEMES) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const cells = await one.locator('.task-board-lane-cell').evaluateAll((els) => els.map(el => el.getBoundingClientRect().toJSON()));
      const heads = await page.locator('.task-board-status-heading').evaluateAll((els) => els.map(el => el.getBoundingClientRect().toJSON()));
      assert.ok(cells.every((cell, i) => Math.abs(cell.x - heads[i].x) < 1 && Math.abs(cell.width - heads[i].width) < 8), theme);
      assert.ok(cells.every((cell) => Math.abs(cell.y - cells[0].y) < 1 && Math.abs(cell.bottom - cells[0].bottom) < 1), theme);
      const meta = await first.evaluate(el => ['.board-task-number', '.board-task-workspace', '.board-task-executor'].map(s => el.querySelector(s).getBoundingClientRect().toJSON()));
      assert.ok(meta[0].right <= meta[1].x && meta[1].right <= meta[2].x, theme);
      assert.notEqual(await first.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', theme);
    }
    await first.dblclick();
    const dialog = page.locator('[data-task-card-modal]');
    assert.equal(await dialog.evaluate(el => el.matches(':modal')), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true);
    await page.keyboard.press('Escape');
    await one.locator('summary').click();
    assert.equal(await first.isVisible(), false);
    await setBoard(page);
    assert.equal(await first.isVisible(), false, 'collapse survives snapshot');
    await one.locator('summary').click();
    assert.equal(await first.isVisible(), true);
    assert.deepEqual(await dropTask(page, '1', one.locator('.is-status-testing')),
      { type: 'status', id: '1', status: 'testing' });
    await page.evaluate(() => window.AgentHubTaskBoard.finishAction({ type: 'status', id: '1', succeeded: true }));
    const actionCount = await page.evaluate(() => window.__boardActions.length);
    await dropTask(page, '1', two.locator('.is-status-testing'));
    assert.equal(await page.locator('[data-task-move-modal]').isVisible(), true);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__boardActions.length), actionCount, 'cancelling a cross-Workspace drop sends no command');
    await dropTask(page, '5', one.locator('.is-status-testing'));
    assert.equal(await page.evaluate(() => window.__boardActions.at(-1).type), 'move', 'backlog first moves into the target Workspace');
    await page.getByRole('button', { name: 'Создать задачу в Agent HUB', exact: true }).click();
    assert.equal(await one.locator('textarea').isVisible(), true);
    await page.locator('[data-board-scope="workspace:one"]').click();
    assert.equal(await page.locator('.task-board-lane').count(), 1);
    assert.equal(await first.locator('.board-task-workspace').textContent(), '');
    await switchGrouping();
    assert.equal(await matrix.count(), 0);
    assert.equal(await board.locator('.is-status-testing').count(), 1);
    await page.reload();
    await setBoard(page);
    assert.equal(await matrix.count(), 0, 'grouping preference survives reload');
    await switchGrouping();
    assert.equal(await matrix.isVisible(), true);
    await settings.click();
    await page.locator('[data-task-board-view="workspaces"]').click();
    await settings.click();
    assert.equal(await page.locator('[data-task-board-grouping-setting]').isVisible(), false);
    await page.locator('[data-task-board-view="statuses"]').click();
    assert.equal(await matrix.isVisible(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok((await board.boundingBox()).x + (await board.boundingBox()).width <= 391);
    await matrix.evaluate(el => { el.scrollLeft = 300; el.scrollTop = 80; });
    const scroll = await matrix.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
    assert.ok(scroll.x > 0, 'optional mobile Kanban remains horizontally scrollable');
    await setBoard(page);
    assert.deepEqual(await matrix.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop })), scroll);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});


test("Status card surfaces survive theme overrides for open, started and completed Tasks", async () => {
  const { chromium } = await import('playwright');
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1752, height: 1000 } });
    await openFixture(page);
    await page.evaluate(({ tasks, workspaces }) => {
      document.documentElement.dataset.view = 'dashboard';
      document.documentElement.dataset.surface = 'browser';
      window.AgentHubTaskBoard.setSnapshot({ tasks, workspaces });
    }, { tasks: [task('open'), task('started', { status: 'started' }), task('closed', { status: 'done', workflowStatus: 'done' })], workspaces });
    const board = page.locator('[data-task-board-columns]');
    const surfaces = async () => board.locator('.board-task-card').evaluateAll(els => els.map(el => {
      const style = getComputedStyle(el);
      const context = document.createElement('canvas').getContext('2d');
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return { background: style.backgroundColor, alpha: context.getImageData(0, 0, 1, 1).data[3],
        border: parseFloat(style.borderTopWidth), radius: parseFloat(style.borderTopLeftRadius) };
    }));
    for (const grouped of [false, true]) {
      if (grouped) {
        await page.locator('[data-task-board-settings-toggle]').click();
        await page.getByLabel('Группировать по воркспейсам', { exact: true }).click();
      }
      for (const theme of THEMES) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const cards = await surfaces();
        assert.equal(cards.length, 2);
        assert.equal(cards[0].background, cards[1].background, `${theme}: started and open share a surface`);
        for (const card of cards) {
          assert.ok(card.alpha >= 240, `${theme}: solid background`);
          assert.ok(card.border >= 1 && card.radius >= 5, `${theme}: card outline and rounding`);
        }
      }
      await page.locator('[data-task-board-completed-toggle]').click();
      for (const theme of THEMES) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const cards = await surfaces();
        assert.equal(cards.length, 1);
        assert.ok(cards[0].alpha >= 240 && cards[0].border >= 1 && cards[0].radius >= 5, `${theme}: closed surface`);
      }
      await page.locator('[data-task-board-completed-toggle]').click();
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'pulsar'; });
    await board.locator('[data-board-task-id="started"]').dblclick();
    assert.equal(await page.locator('[data-task-card-modal]').evaluate(el => el.matches(':modal')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-task-card-modal]').isVisible(), true);
  } finally { await browser.close(); }
});


test("activity rail keeps running effects and drags compact Tasks into the composer", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 2048, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page);
    await page.evaluate(({ tasks, workspaces }) => {
      document.documentElement.dataset.view = "chat";
      document.documentElement.dataset.streamStatusEffect = "energy";
      window.AgentHub.setTasks([{
        id: "conversation", workspaceId: "one", workspaceName: "Hub",
        streamId: "stream", streamName: "Sirius", title: "Hub", provider: "codex",
        running: true, selected: true, startedAt: new Date().toISOString(),
        run: { turnId: "turn1", operationKind: "user-turn",
          providerStart: { turnId: "turn1", state: "observed" } },
      }]);
      window.AgentHubTaskBoard.setSnapshot({ tasks: [tasks[0]], workspaces });
      window.AgentHubTaskBoard.setSelectedWorkspace("one");
    }, { tasks, workspaces });
    const effect = await page.locator(".activity-stream-item[data-running]")
      .evaluate((element) => {
        const layer = element.querySelector(".stream-tab-status-layer");
        return layer && getComputedStyle(layer, "::before").animationName;
      });
    assert.equal(effect, "stream-energy-charge");
    const source = await page.locator(".board-task-card.is-compact").first().boundingBox();
    const target = await page.locator(".chat-pane").boundingBox();
    await page.mouse.move(source.x + 30, source.y + 25);
    await page.mouse.down();
    await page.mouse.move(source.x + 33, source.y + 25);
    await page.mouse.move(source.x + 38, source.y + 25);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
    await page.mouse.up();
    const reference = page.locator(".attachment-task-reference");
    await reference.waitFor({ state: "visible" });
    assert.equal(await reference.count(), 1);
    assert.match(await reference.innerText(), /HUB-1/u);
    assert.deepEqual(await page.evaluate(() => window.__boardActions), []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});


test("activity rail clips running effects to each card without horizontal overflow", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 2048, height: 1100 } });
    await openFixture(page);
    await page.evaluate(() => {
      document.documentElement.dataset.view = "chat";
      document.documentElement.dataset.streamStatusStyle = "fill";
      window.AgentHub.setTasks(["Sirius", "S3"].map((name, index) => ({
        id: `conversation-${index}`, workspaceId: "one", workspaceName: "Agent HUB",
        streamId: `stream-${index}`, streamName: name, title: "Agent HUB", provider: "codex",
        running: true, selected: !index, startedAt: new Date().toISOString(),
        run: { turnId: `turn-${index}`, operationKind: "user-turn",
          providerStart: { turnId: `turn-${index}`, state: "observed" } },
      })));
    });
    const checks = await page.evaluate(() => ["scanner", "energy", "impulse", "breath"].flatMap((effect) => {
      document.documentElement.dataset.streamStatusEffect = effect;
      return [0, 500, 1200].map((time) => {
        for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = time; }
        return {
          effect, time,
          cards: [...document.querySelectorAll(".activity-stream-item[data-running]")].map((card) => {
            const outer = card.getBoundingClientRect();
            const layer = card.querySelector(".stream-tab-status-layer").getBoundingClientRect();
            return { clipped: getComputedStyle(card).overflow === "hidden",
              inside: layer.left >= outer.left && layer.top >= outer.top
                && layer.right <= outer.right && layer.bottom <= outer.bottom };
          }),
          overflow: [...document.querySelectorAll(".activity-rail, .activity-stream-list")]
            .some((element) => element.scrollWidth > element.clientWidth + 1),
        };
      });
    }));
    for (const check of checks) {
      assert.equal(check.cards.length, 2);
      assert.ok(check.cards.every((card) => card.clipped && card.inside), `${check.effect}/${check.time}: animation escapes its card`);
      assert.equal(check.overflow, false, `${check.effect}/${check.time}: horizontal scrollbar`);
    }
  } finally {
    await browser.close();
  }
});
