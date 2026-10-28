import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { DesktopTaskBoardController } from "../../src/interfaces/desktop/desktop-task-board-controller.mjs";

for (const width of [1366, 390]) test(`Task card interrupts a held Test through the real user owner at ${width}px`, { timeout: 30_000 }, async t => {
  const f = await claimCustodyFixture(t);
  const workspace = f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id, { ...workspace.settings, releaseWorkflowEnabled: true });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  f.workspaces.snapshotAndMergeOwned = async ({ lease }) => {
    started();
    await new Promise((_, reject) => lease.signal.addEventListener("abort", () => reject(lease.signal.reason), { once: true }));
  };
  const lifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    taskGitWorkspaces: f.workspaces,
    releasePreflight: { withAwaitTransition: async (_id, operation) => operation() } });
  const controller = new DesktopTaskBoardController({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    taskGitWorkspaces: f.workspaces, taskLifecycle: lifecycle, hubMcpService: f.hub,
    taskLauncher: {}, snapshot: async () => ({}) });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(7000);
    const data = snapshot();
    data.workspaces.push({ id: workspace.id, name: "Cancellation fixture", streams: [] });
    data.boardTasks = f.tasks.snapshot();
    const diagnostics = await openFixture(page, { fixtureSnapshot: data });
    const commands = [];
    await page.exposeFunction("__ownTaskOperation", async message => {
      commands.push(message.action);
      try {
        const result = message.action === "board-task-read" ? controller.read(message.params)
          : message.action === "board-task-operation-cancel" ? await controller.cancelOperation(message.params)
            : await controller.status(message.params, { commandId: "desktop-held-test" });
        return { id: message.id, ok: true, result };
      } catch (error) { return { id: message.id, ok: false, error: error.message }; }
    });
    await page.evaluate(() => {
      const previous = window.__fixtureBridge.postMessage;
      window.__fixtureBridge.postMessage = message => {
        if (!["board-task-read", "board-task-status", "board-task-operation-cancel"].includes(message.action)) return previous(message);
        void window.__ownTaskOperation(message).then(outcome => window.dispatchEvent(new MessageEvent("message", {
          data: { type: "agenthub:control-result", ...outcome },
        })));
      };
    });
    await page.locator(width < 960 ? '[data-mobile-button="dashboard"]' : '[data-view-button="dashboard"]').click();
    await page.locator(`[data-board-task-id="${f.prior.id}"]`).first().click();
    const panel = page.locator('[data-task-card-modal]');
    const status = panel.locator('[data-task-card-status]').locator('..').getByRole('button');
    await status.click();
    const menuId = await status.getAttribute('aria-controls');
    await page.locator(`#${menuId} [data-value="testing"]`).click();
    await entered;
    await panel.getByRole('button', { name: "Операции задачи", exact: true }).click();
    await panel.getByRole('button', { name: "Прервать операцию", exact: true }).click();
    await panel.getByText("Операция прервана. Уже выполненные действия сохранены.", { exact: true }).waitFor();
    assert.equal(f.catalog.mcpOperation("desktop-held-test").taskExecution.cancellation.phase, "stopped");
    assert.equal(f.tasks.task(f.prior.id).workflowStatus, f.prior.workflowStatus);
    assert.equal(commands.filter(action => action === "board-task-operation-cancel").length, 1);
    assert.deepEqual(diagnostics, []);
    const dir = new URL("../../WIP/hub368/", import.meta.url); await mkdir(dir, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`cancellation-${width}.png`, dir)), fullPage: true });
  } finally { await browser.close(); }
});
