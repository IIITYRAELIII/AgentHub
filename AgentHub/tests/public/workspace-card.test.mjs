import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture, snapshot, bridgeCalls, applyFixtureSnapshot } from "./composer-production.fixture.mjs";

async function withWorkspace(action) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.setDefaultTimeout(8_000);
    const data = snapshot();
    data.workspaces[0].comment = "Existing comment";
    data.workspaces[0].settings = { workingDirectory: "D:\\team\\project" };
    data.boardLayout.columnOrder = ["workspace:workspace-1", "notes"];
    data.boardTasks = [{ id: "card-1", taskNumber: "HUB-TEST", title: "Attachment task",
      description: "Description", status: "open", workflowStatus: "new", revision: 1,
      bucket: "workspace", workspaceId: "workspace-1", checklist: [],
      attachments: [{ id: "attachment-1", name: "Evidence.txt", type: "text/plain", size: 7 }] }];
    const diagnostics = await openFixture(page, { fixtureSnapshot: data });
    await page.evaluate(() => {
      const original = window.__fixtureBridge.postMessage.bind(window.__fixtureBridge);
      window.__fixtureBridge.postMessage = (message) => {
        if (!["update-workspace-settings", "rename-workspace", "board-column-comment", "board-column-move"].includes(message.action)) {
          return original(message);
        }
        window.__agentHubFixture.log.push(structuredClone(message));
        localStorage.setItem("fixture:bridge-log", JSON.stringify(window.__agentHubFixture.log));
        setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: message.id, ok: true, result: window.__agentHubFixture.snapshot,
        } })), 0);
      };
    });
    await action(page, data);
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
}

async function openWorkspace(page, dashboard = false) {
  if (dashboard) {
    await page.locator('[data-view-button="dashboard"]').click();
    await page.locator('[data-task-board-view="workspaces"]').click();
    await page.locator('[data-board-workspace-id="workspace-1"]').first().click({ button: "right" });
  } else await page.locator('[data-workspace-heading="workspace-1"]').first().click({ button: "right" });
  await page.locator('[data-workspace-menu-action="edit"]').click();
  await page.locator('[data-workspace-card-modal]').waitFor({ state: "visible" });
}

async function directoryEdit(page, selector, value, key = "Enter") {
  const field = page.locator('.directory-field').filter({ has: page.locator(selector) });
  await field.locator('[data-directory-action="edit"]:visible').first().click();
  await page.locator(selector).fill(value);
  await page.locator(selector).press(key);
}

test("workspace card is available from Dialogs and Dashboard context menus", async () => withWorkspace(async (page) => {
  for (const dashboard of [false, true]) {
    await openWorkspace(page, dashboard);
    assert.equal(await page.locator('[data-workspace-card-name]').inputValue(), "Workspace");
    assert.equal(await page.locator('[data-workspace-card-comment]').inputValue(), "Existing comment");
    assert.equal(await page.locator('[data-workspace-card-working-directory]').inputValue(), "D:\\team\\project");
    await page.locator('[data-workspace-card-cancel]').click();
  }
  assert.deepEqual(await bridgeCalls(page, "rename-workspace"), []);
}));

test("Dialog settings replace the legacy Project picker with a Stream working directory", async () => withWorkspace(async (page) => {
  await page.locator('[data-dialog-settings-toggle]').click();
  assert.equal(await page.locator('[data-dialog-options="project"]').count(), 0);
  await directoryEdit(page, '[data-dialog-working-directory]', "D:\\streams\\current");
  await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => entry.action === "update-stream-settings"));
  const [call] = await bridgeCalls(page, "update-stream-settings");
  assert.equal(call.params.streamId, "stream-a");
  assert.equal(call.params.settings.workingDirectory, "D:\\streams\\current");
  assert.deepEqual(await bridgeCalls(page, "set-project"), []);
}));

test("Workspace and Stream use the shared breadcrumb directory field", async () => withWorkspace(async (page) => {
  await openWorkspace(page);
  await directoryEdit(page, '[data-workspace-card-working-directory]', "D:\\discard", "Escape");
  assert.equal(await page.locator('[data-workspace-card-working-directory]').inputValue(), "D:\\team\\project");
  await directoryEdit(page, '[data-workspace-card-working-directory]', "D:\\kept\\workspace");
  assert.deepEqual(await page.locator('[data-workspace-card-form] .directory-field-segment').allTextContents(), ["D:", "kept", "workspace"]);
  await page.locator('[data-workspace-card-cancel]').click();
  await page.locator('[data-dialog-settings-toggle]').click();
  await directoryEdit(page, '[data-dialog-working-directory]', "D:\\discard", "Escape");
  assert.deepEqual(await bridgeCalls(page, "update-stream-settings"), []);
  await page.locator('[data-dialog-settings] [data-directory-action="browse"]:visible').first().click();
  await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => entry.action === "browse-directory"));
  assert.equal((await bridgeCalls(page, "browse-directory")).length, 1);
}));

test("Dashboard renders only non-empty comments without inline editing", async () => withWorkspace(async (page, data) => {
  await page.locator('[data-view-button="dashboard"]').click();
  await page.locator('[data-task-board-view="workspaces"]').click();
  const heading = page.locator('[data-board-workspace-id="workspace-1"] .task-board-column-head').first();
  assert.ok((await heading.innerText()).includes("Existing comment"));
  assert.equal(await heading.locator('input,textarea,[contenteditable="true"]').count(), 0);
  assert.equal(await page.getByText("Без комментария", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Нет комментария", { exact: true }).count(), 0);
  data.version = "empty-workspace-comment";
  data.workspaces[0].comment = "   ";
  await applyFixtureSnapshot(page, data);
  await page.waitForFunction(() => !document.querySelector('[data-board-workspace-id="workspace-1"] .task-board-column-head')?.textContent.includes("Existing comment"));
  assert.equal(await heading.locator("p").count(), 0, "whitespace-only comment must not leave an empty editor or placeholder");
}));

test("Dashboard renders and opens Task attachments", async () => withWorkspace(async (page) => {
  await page.locator('[data-view-button="dashboard"]').click();
  await page.locator('[data-task-board-view="workspaces"]').click();
  await page.locator('[data-board-task-id="card-1"]:visible').first().click();
  await page.locator('[data-task-card-attachments] .board-task-attachment').click();
  await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => entry.action === "open-attachment"));
  assert.equal((await bridgeCalls(page, "open-attachment"))[0].params.id, "attachment-1");
  assert.deepEqual(await bridgeCalls(page, "board-task-remove"), []);
}));

test("workspace card saves through existing workspace and board commands", async () => withWorkspace(async (page) => {
  await openWorkspace(page);
  await page.locator('[data-workspace-card-name]').fill("Renamed workspace");
  await page.locator('[data-workspace-card-comment]').fill("Updated comment");
  await directoryEdit(page, '[data-workspace-card-working-directory]', "D:\\new");
  await page.locator('[data-workspace-card-order]').fill("2");
  await page.locator('[data-workspace-card-submit]').click();
  await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => entry.action === "board-column-move"));
  assert.equal((await bridgeCalls(page, "rename-workspace"))[0].params.name, "Renamed workspace");
  assert.equal((await bridgeCalls(page, "board-column-comment"))[0].params.comment, "Updated comment");
  assert.equal((await bridgeCalls(page, "update-workspace-settings"))[0].params.settings.workingDirectory, "D:\\new");
  const move = (await bridgeCalls(page, "board-column-move"))[0].params;
  assert.equal(move.columnId, "workspace:workspace-1");
  assert.equal(move.beforeColumnId, null);
}));

test("workspace card no longer exposes the legacy release registry", async () => withWorkspace(async (page) => {
  await openWorkspace(page);
  assert.equal(await page.locator('[data-workspace-card-name]').isVisible(), true);
  assert.equal(await page.locator('[data-workspace-card-submit]').isEnabled(), true);
  assert.equal(await page.locator('[data-workspace-release-registry]').count(), 0);
  assert.equal(await page.getByText("Изменения к релизу", { exact: true }).count(), 0);
  await page.locator('[data-workspace-card-cancel]').click();
  assert.equal(await page.locator('[data-workspace-card-modal]').isVisible(), false);
}));
