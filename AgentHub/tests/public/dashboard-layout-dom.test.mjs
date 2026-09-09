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

test("Dashboard preserves scope, create, filter and native drop commands", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1487, height: 1058 } });
    await openFixture(page);
    await setBoard(page);
    const board = page.locator("[data-task-board-columns]");
    assert.equal(await board.locator(".task-board-column").count(), 6);
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
    assert.deepEqual(await dropTask(page, "1", page.locator(".is-backlog")), { type: "move", id: "1", bucket: "backlog", beforeId: null });
    assert.equal(await page.locator("[data-task-board-filter-controls]").isVisible(), false);
    await page.locator("[data-task-board-filter-toggle]").click();
    assert.equal(await page.locator("[data-task-board-filter-controls]").isVisible(), true);
    await page.locator('[data-task-status-language="ru"]').click();
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

