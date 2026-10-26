import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

const workspace = {
  id: "workspace-1",
  name: "Agent HUB",
  streams: [{ id: "stream-1", name: "Dashboard", displayName: "Dashboard", ordinal: 1 }],
};

const task = (values = {}) => ({
  id: "parent",
  taskNumber: "HUB-164",
  title: "Parent Task",
  text: "Parent Task",
  rawText: "Parent Task",
  description: "",
  bucket: "workspace",
  status: "started",
  workflowStatus: "in_progress",
  workspaceId: workspace.id,
  streamId: "stream-1",
  revision: 5,
  checklist: [],
  attachments: [],
  ...values,
});

async function setBoard(page, tasks, openTaskId = "parent", workspaceValue = workspace) {
  await page.evaluate(({ tasks: values, workspace: value, openTaskId: id }) => {
    window.AgentHubTaskBoard.setSnapshot({
      tasks: values,
      workspaces: [value],
      columnOrder: [`workspace:${value.id}`],
    });
    document.dispatchEvent(new CustomEvent("agenthub:task-reference-open", { detail: { taskId: id } }));
  }, { tasks, workspace: workspaceValue, openTaskId });
}

async function resetAction(page) {
  await page.evaluate(() => {
    const action = window.__boardActions.at(-1);
    window.AgentHubTaskBoard.finishAction({ ...action, succeeded: false });
  });
}

test("Task card loads history only when open and rejects late detail revisions and openings", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const parent = task({ detailsDeferred: true, detailsRevision: "r1" });
    const other = task({ id: "other", title: "Other Task", detailsDeferred: true, detailsRevision: "other-r1" });
    await page.evaluate(values => {
      window.AgentHubTaskBoard.setSnapshot({ tasks: values, workspaces: [],
        columnOrder: [] });
    }, [parent, other]);
    assert.deepEqual(await page.evaluate(() => window.__boardActions), []);
    await setBoard(page, [parent, other]);
    const first = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(first.type, "read");
    assert.equal(first.id, parent.id);
    const full = { ...parent, detailsDeferred: undefined, workLog: [{
      provider: "codex", threadId: "thread", turnId: "turn", status: "completed",
      summary: "First history", createdAt: "2026-01-01T00:00:00.000Z", changedFiles: [],
    }] };
    await page.evaluate(({ request, value }) => window.AgentHubTaskBoard.showDetails({
      ...request, result: { task: value },
    }), { request: first, value: full });
    assert.match(await page.locator("[data-task-card-work-log-entries]").innerText(), /First history/u);
    const next = { ...parent, detailsRevision: "r2" };
    await page.evaluate(value => window.AgentHubTaskBoard.setSnapshot({ tasks: value }), [next, other]);
    const second = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(second.revision, "r2");
    await page.evaluate(({ request, value }) => window.AgentHubTaskBoard.showDetails({
      ...request, result: { task: value },
    }), { request: first, value: full });
    assert.doesNotMatch(await page.locator("[data-task-card-work-log-entries]").innerText(), /First history/u);
    const updated = { ...full, detailsRevision: "r2", workLog: [{ ...full.workLog[0], summary: "Updated history" }] };
    await page.evaluate(({ request, value }) => window.AgentHubTaskBoard.showDetails({
      ...request, result: { task: value },
    }), { request: second, value: updated });
    assert.match(await page.locator("[data-task-card-work-log-entries]").innerText(), /Updated history/u);
    await setBoard(page, [next, other], "other");
    await page.evaluate(({ request, value }) => window.AgentHubTaskBoard.showDetails({
      ...request, result: { task: value },
    }), { request: second, value: updated });
    assert.doesNotMatch(await page.locator("[data-task-card-work-log-entries]").innerText(), /Updated history/u);
    await setBoard(page, [next, other]);
    const reopened = await page.evaluate(() => window.__boardActions.at(-1));
    assert.notEqual(reopened.opening, second.opening);
    await page.evaluate(({ request, value }) => window.AgentHubTaskBoard.showDetails({
      ...request, result: { task: value },
    }), { request: second, value: updated });
    assert.doesNotMatch(await page.locator("[data-task-card-work-log-entries]").innerText(), /Updated history/u);
    await page.evaluate(({ request, value }) => window.AgentHubTaskBoard.showDetails({
      ...request, result: { task: value },
    }), { request: reopened, value: updated });
    assert.match(await page.locator("[data-task-card-work-log-entries]").innerText(), /Updated history/u);
  } finally {
    await browser.close();
  }
});

test("Task checklist performs text mutations and ordering through DOM controls", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    await setBoard(page, [task({ checklist: [
      { id: "first", text: "First", completed: false, manualCompleted: false, position: 0 },
      { id: "second", text: "Second", completed: true, manualCompleted: true, position: 1 },
    ] })]);

    assert.equal(await page.locator("[data-task-checklist-progress]").textContent(), "1 из 2");
    assert.equal(await page.locator('[data-checklist-item-id="first"] .task-checklist-text').textContent(), "First");
    assert.equal(await page.locator('[data-checklist-item-id="first"] .board-task-card').count(), 0);

    await page.locator('[data-checklist-item-id="first"] input[type="checkbox"]').click();
    assert.deepEqual((await page.evaluate(() => window.__boardActions.at(-1))).completed, true);
    await resetAction(page);

    await page.locator('button[title="Редактировать текст пункта"]').first().click();
    await page.getByRole("textbox", { name: "Текст пункта чек-листа" }).fill("First edited");
    await page.locator('button[title="Сохранить пункт"]').click();
    assert.equal((await page.evaluate(() => window.__boardActions.at(-1))).text, "First edited");
    await resetAction(page);

    await page.locator('button[title="Переместить ниже"]').click();
    assert.equal((await page.evaluate(() => window.__boardActions.at(-1))).operation, "move");
    await resetAction(page);

    await page.locator('button[title="Удалить пункт"]').first().click();
    assert.equal((await page.evaluate(() => window.__boardActions.at(-1))).operation, "remove");
    await resetAction(page);

    await page.getByRole("textbox", { name: "Новый пункт чек-листа" }).fill("Third");
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    const action = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(action.operation, "add");
    assert.equal(action.text, "Third");
    assert.equal(action.expectedRevision, 5);
    assert.match(action.requestId, /^task-checklist:parent:/u);
    assert.equal(await page.getByRole("textbox", { name: "Новый пункт чек-листа" }).inputValue(), "Third");
    assert.equal(await page.getByRole("button", { name: "Добавить", exact: true }).isDisabled(), true);
    await resetAction(page);
    assert.equal(await page.getByRole("textbox", { name: "Новый пункт чек-листа" }).inputValue(), "Third");
    assert.equal(await page.getByRole("button", { name: "Добавить", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    await page.evaluate(() => {
      const action = window.__boardActions.at(-1);
      window.AgentHubTaskBoard.finishAction({ ...action, succeeded: true });
    });
    assert.equal(await page.getByRole("textbox", { name: "Новый пункт чек-листа" }).inputValue(), "");
  } finally {
    await browser.close();
  }
});

test("linked checklist items use Task cards and support open, replace, unlink and extract", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const child = task({
      id: "child",
      taskNumber: "HUB-165",
      title: "Child Task",
      text: "Child Task",
      streamId: null,
      status: "open",
      workflowStatus: "new",
      checklistParent: {
        itemId: "linked",
        text: "Original item text",
        task: task({ checklist: [] }),
      },
    });
    await setBoard(page, [task({ checklist: [{
      id: "linked",
      text: "Original item text",
      completed: false,
      position: 0,
      linkedTaskId: child.id,
      linkedTask: child,
    }] }), child]);

    const linkedCard = page.locator('[data-checklist-item-id="linked"] .board-task-card');
    await assert.doesNotReject(() => linkedCard.waitFor({ state: "visible" }));
    assert.equal(await linkedCard.locator(".board-task-title").textContent(), "Child Task");
    assert.equal(await page.locator('[data-checklist-item-id="linked"] .task-checklist-text').count(), 0);
    await linkedCard.click();
    assert.equal(await page.locator("[data-task-card-title]").inputValue(), "Child Task");
    assert.equal(await page.locator("[data-task-checklist-parent]").isVisible(), true);
    assert.equal(await page.locator("[data-task-checklist-parent-item]").textContent(), "Пункт: Original item text");
    await page.locator("[data-task-checklist-parent-card] .board-task-card").click();
    assert.equal(await page.locator("[data-task-card-title]").inputValue(), "Parent Task");

    await setBoard(page, [task({ checklist: [{
      id: "linked", text: "Original item text", completed: false, position: 0,
      linkedTaskId: child.id, linkedTask: child,
    }] }), child]);
    assert.equal(await page.locator("[data-task-card-title]").inputValue(), "Parent Task");
    await page.locator('button[title="Оставить Task без удаления"]').click();
    assert.equal((await page.evaluate(() => window.__boardActions.at(-1))).operation, "unlink");
    await resetAction(page);

    await setBoard(page, [task({ checklist: [{
      id: "linked", text: "Original item text", completed: false, position: 0,
    }] }), child]);
    await page.locator('[data-checklist-item-id="linked"] .themed-select-button').click();
    assert.equal(await page.locator('.themed-select-menu:not([hidden]) .themed-select-option[data-value="child"]').count(), 1);
    await page.locator('.themed-select-menu:not([hidden]) .themed-select-option[data-value="child"]').click();
    assert.equal((await page.evaluate(() => window.__boardActions.at(-1))).linkedTaskId, "child");
    await resetAction(page);

    await setBoard(page, [task({ checklist: [{
      id: "plain", text: "Extract me", completed: false, position: 0,
    }] }), child]);
    await page.locator('button[title="Создать отдельную Task"]').click();
    assert.equal((await page.evaluate(() => window.__boardActions.at(-1))).operation, "extract");
  } finally {
    await browser.close();
  }
});

test("Backlog and Notes checklist items do not offer extract", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    for (const bucket of ["backlog", "notes"]) {
      await setBoard(page, [task({
        bucket,
        workspaceId: null,
        streamId: null,
        checklist: [{
          id: `${bucket}-plain`, text: "Keep in place", completed: false, position: 0,
        }],
      })]);
      assert.equal(await page.locator('button[title="Создать отдельную Task"]').count(), 0);
    }
    assert.deepEqual(await page.evaluate(() => window.__boardActions), []);
  } finally {
    await browser.close();
  }
});

test("manual linked check offers exactly four non-release actions and retries one exact choice", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const child = task({
      id: "child", taskNumber: "HUB-165", title: "Child", status: "open",
      workflowStatus: "new", streamId: null, revision: 3,
    });
    const pendingParent = task({ checklist: [{
      id: "linked", text: "Linked", completed: false, manualCompleted: false, position: 0,
      linkedTaskId: child.id, linkedTask: child,
    }] });
    await setBoard(page, [pendingParent, child]);
    await page.locator('[data-checklist-item-id="linked"] input[type="checkbox"]').click();
    const toggle = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(toggle.type, "checklist");
    assert.equal(toggle.completed, true);
    assert.equal(Object.hasOwn(toggle, "promptLinkedTaskId"), false);

    const checkedParent = task({ revision: 6, checklist: [{
      id: "linked", text: "Linked", completed: true, manualCompleted: true, position: 0,
      linkedTaskId: child.id, linkedTask: child,
    }] });
    await setBoard(page, [checkedParent, child]);
    await page.evaluate((action) => window.AgentHubTaskBoard.finishAction({ ...action, succeeded: true }), toggle);
    const prompt = page.getByRole("region", { name: "Действие со связанной Task" });
    await assert.doesNotReject(() => prompt.waitFor({ state: "visible" }));
    assert.deepEqual(await prompt.getByRole("button").allTextContents(), [
      "Ничего не делать",
      "Отметить Awaiting implementation",
      "Отметить Done",
      "Отметить Done и закрыть",
    ]);
    await prompt.getByRole("button", { name: "Отметить Done", exact: true }).click();
    const first = await page.evaluate(() => window.__boardActions.at(-1));
    assert.deepEqual({
      type: first.type,
      id: first.id,
      itemId: first.itemId,
      linkedTaskId: first.linkedTaskId,
      action: first.action,
      expectedTaskRevision: first.expectedTaskRevision,
      expectedLinkedTaskRevision: first.expectedLinkedTaskRevision,
    }, {
      type: "checklist-linked-task-action",
      id: "parent",
      itemId: "linked",
      linkedTaskId: "child",
      action: "done",
      expectedTaskRevision: 6,
      expectedLinkedTaskRevision: 3,
    });
    await page.evaluate((action) => window.AgentHubTaskBoard.finishAction({ ...action, succeeded: false }), first);
    assert.equal(await prompt.getByRole("button", { name: "Отметить Awaiting implementation" }).isDisabled(), true);
    await prompt.getByRole("button", { name: "Отметить Done", exact: true }).click();
    const retry = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(retry.requestId, first.requestId);
    assert.equal(retry.action, first.action);
    await page.evaluate((action) => window.AgentHubTaskBoard.finishAction({ ...action, succeeded: true }), retry);
    assert.equal(await prompt.count(), 0);
    assert.equal(await page.locator('[data-checklist-item-id="linked"] input[type="checkbox"]').isChecked(), true);
  } finally {
    await browser.close();
  }
});

test("release workflow, no-op, uncheck and automatic sync never mutate implicitly", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const child = task({
      id: "child", taskNumber: "HUB-165", title: "Child", status: "open",
      workflowStatus: "new", streamId: null, revision: 3,
    });
    const linkedItem = (values = {}) => ({
      id: "linked", text: "Linked", completed: false, manualCompleted: false, position: 0,
      linkedTaskId: child.id, linkedTask: child, ...values,
    });
    const releaseWorkspace = { ...workspace, settings: { releaseWorkflowEnabled: true } };
    const releaseParent = task({ checklist: [linkedItem()] });
    await setBoard(page, [releaseParent, child], "parent", releaseWorkspace);
    await page.locator('[data-checklist-item-id="linked"] input[type="checkbox"]').click();
    let action = await page.evaluate(() => window.__boardActions.at(-1));
    await setBoard(page, [task({ revision: 6, checklist: [linkedItem({ completed: true, manualCompleted: true })] }), child], "parent", releaseWorkspace);
    await page.evaluate((value) => window.AgentHubTaskBoard.finishAction({ ...value, succeeded: true }), action);
    assert.equal(await page.getByRole("region", { name: "Действие со связанной Task" }).count(), 0);
    assert.equal((await page.evaluate(() => window.__boardActions)).length, 1);

    const nonRelease = { ...workspace, settings: { releaseWorkflowEnabled: false } };
    await setBoard(page, [task({ revision: 7, checklist: [linkedItem({ completed: true, manualCompleted: true })] }), child], "parent", nonRelease);
    await page.locator('[data-checklist-item-id="linked"] input[type="checkbox"]').click();
    action = await page.evaluate(() => window.__boardActions.at(-1));
    await setBoard(page, [task({ revision: 8, checklist: [linkedItem()] }), child], "parent", nonRelease);
    await page.evaluate((value) => window.AgentHubTaskBoard.finishAction({ ...value, succeeded: true }), action);
    assert.equal(await page.getByRole("region", { name: "Действие со связанной Task" }).count(), 0);

    const automaticChild = { ...child, workflowStatus: "done", revision: 4 };
    await setBoard(page, [task({ revision: 9, checklist: [linkedItem({
      completed: true, manualCompleted: false, linkedTask: automaticChild,
    })] }), automaticChild], "parent", nonRelease);
    assert.equal(await page.getByRole("region", { name: "Действие со связанной Task" }).count(), 0);

    await setBoard(page, [task({ revision: 10, checklist: [linkedItem()] }), child], "parent", nonRelease);
    await page.locator('[data-checklist-item-id="linked"] input[type="checkbox"]').click();
    action = await page.evaluate(() => window.__boardActions.at(-1));
    await setBoard(page, [task({ revision: 11, checklist: [linkedItem({ completed: true, manualCompleted: true })] }), child], "parent", nonRelease);
    await page.evaluate((value) => window.AgentHubTaskBoard.finishAction({ ...value, succeeded: true }), action);
    await page.getByRole("button", { name: "Ничего не делать", exact: true }).click();
    const noOp = await page.evaluate(() => window.__boardActions.at(-1));
    assert.equal(noOp.action, "none");
    assert.equal(noOp.linkedTaskId, "child");
    await page.evaluate((value) => window.AgentHubTaskBoard.finishAction({ ...value, succeeded: true }), noOp);
    assert.equal(await page.getByRole("region", { name: "Действие со связанной Task" }).count(), 0);
    assert.equal(await page.locator('[data-checklist-item-id="linked"] input[type="checkbox"]').isChecked(), true);
  } finally {
    await browser.close();
  }
});

test("checklist actions keep exact per-Task ownership across card races", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const parent = task({ checklist: [{ id: "a-item", text: "A", completed: false, position: 0 }] });
    const second = task({
      id: "second",
      taskNumber: "HUB-165",
      title: "Second Task",
      text: "Second Task",
      checklist: [{ id: "b-item", text: "B", completed: false, position: 0 }],
    });
    await setBoard(page, [parent, second]);
    await page.locator('[data-checklist-item-id="a-item"] input[type="checkbox"]').click();
    const firstA = await page.evaluate(() => window.__boardActions.at(-1));
    await setBoard(page, [parent, second], "second");
    assert.equal(await page.locator('[data-checklist-item-id="b-item"] input[type="checkbox"]').isEnabled(), true);
    await page.locator('[data-checklist-item-id="b-item"] input[type="checkbox"]').click();
    const firstB = await page.evaluate(() => window.__boardActions.at(-1));
    await page.evaluate((action) => window.AgentHubTaskBoard.finishAction({ ...action, succeeded: true }), firstA);
    assert.equal(await page.locator('[data-checklist-item-id="b-item"] input[type="checkbox"]').isDisabled(), true);
    await setBoard(page, [parent, second], "parent");
    assert.equal(await page.locator('[data-checklist-item-id="a-item"] input[type="checkbox"]').isEnabled(), true);
    await page.locator('[data-checklist-item-id="a-item"] input[type="checkbox"]').click();
    const secondA = await page.evaluate(() => window.__boardActions.at(-1));
    await page.evaluate((action) => window.AgentHubTaskBoard.finishAction({ ...action, succeeded: true }), firstA);
    assert.equal(await page.locator('[data-checklist-item-id="a-item"] input[type="checkbox"]').isDisabled(), true);
    await page.evaluate((action) => window.AgentHubTaskBoard.finishAction({ ...action, succeeded: true }), secondA);
    assert.equal(await page.locator('[data-checklist-item-id="a-item"] input[type="checkbox"]').isEnabled(), true);
    await setBoard(page, [parent, second], "second");
    assert.equal(await page.locator('[data-checklist-item-id="b-item"] input[type="checkbox"]').isDisabled(), true);
    await page.evaluate((action) => window.AgentHubTaskBoard.finishAction({ ...action, succeeded: true }), firstB);
    assert.equal(await page.locator('[data-checklist-item-id="b-item"] input[type="checkbox"]').isEnabled(), true);
  } finally {
    await browser.close();
  }
});

test("checklist link chooser exposes only Tasks from the parent Workspace", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const local = task({ id: "local", taskNumber: "HUB-165", title: "Local", checklist: [] });
    const foreign = task({
      id: "foreign",
      taskNumber: "FOR-1",
      title: "Foreign",
      workspaceId: "workspace-2",
      checklist: [],
    });
    await setBoard(page, [
      task({ checklist: [{ id: "plain", text: "Plain", completed: false, position: 0 }] }),
      local,
      foreign,
    ]);
    const select = page.locator('[data-checklist-item-id="plain"] select');
    assert.equal(await select.locator('option[value="local"]').count(), 1);
    assert.equal(await select.locator('option[value="foreign"]').count(), 0);
  } finally {
    await browser.close();
  }
});

test("executor click closes only the Task card and opens the assigned Stream", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const conversation = {
      id: "conversation-1",
      threadId: "thread-1",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      streamId: "stream-1",
      streamName: "Dashboard",
      streamOrdinal: 1,
      title: "Dashboard",
      provider: "codex",
      status: "ready",
      lastActivity: "2026-09-04T10:00:00.000Z",
      selected: false,
    };
    await page.evaluate(({ workspace: value, conversation: target }) => {
      window.__selectedTasks = [];
      window.AgentHub.on("task:select", ({ id }) => window.__selectedTasks.push(id));
      window.AgentHub.setWorkspaces([{ id: value.id, name: value.name, title: value.name }]);
      window.AgentHub.setTasks([target]);
    }, { workspace, conversation });
    await setBoard(page, [task()]);
    await page.locator("[data-task-card-executor]").click();

    assert.equal(await page.locator("[data-task-card-modal]").getAttribute("open"), null);
    assert.deepEqual(await page.evaluate(() => window.__selectedTasks), ["conversation-1"]);
    assert.equal(await page.locator("html").getAttribute("data-view"), "chat");
    assert.deepEqual(await page.evaluate(() => window.__boardActions), []);
  } finally {
    await browser.close();
  }
});

test("linked Task with a removed Stream keeps its executor disabled", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const unavailable = task({
      id: "unavailable",
      taskNumber: "HUB-166",
      title: "Unavailable executor",
      text: "Unavailable executor",
      streamId: "removed-stream",
    });
    await setBoard(page, [task({ checklist: [{
      id: "unavailable-item",
      text: "Unavailable executor",
      completed: false,
      position: 0,
      linkedTaskId: unavailable.id,
      linkedTask: unavailable,
    }] }), unavailable]);
    await page.evaluate(() => {
      window.__openStreamCalls = [];
      window.AgentHub.openStream = (...args) => window.__openStreamCalls.push(args);
    });

    const executor = page.locator('[data-checklist-item-id="unavailable-item"] .board-task-executor.is-link');
    assert.equal(await executor.isDisabled(), true);
    assert.equal(await executor.textContent(), "Stream недоступен");
    await executor.evaluate((button) => button.click());
    assert.equal(await page.locator("[data-task-card-title]").inputValue(), "Parent Task");
    assert.equal(await page.locator("[data-task-card-modal]").getAttribute("open"), "");
    assert.deepEqual(await page.evaluate(() => window.__openStreamCalls), []);
    assert.deepEqual(await page.evaluate(() => window.__boardActions), []);
  } finally {
    await browser.close();
  }
});
