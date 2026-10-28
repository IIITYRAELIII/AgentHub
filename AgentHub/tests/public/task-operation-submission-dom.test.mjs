import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { DesktopTaskBoardController } from "../../src/interfaces/desktop/desktop-task-board-controller.mjs";

for (const [width, lookupRefusal] of [[1366, false], [390, false], [1366, true]]) test(`shipped client waits for original Test result across read reconnect and can cancel at ${width}px${lookupRefusal ? " with authoritative lookup refusal" : ""}`, { timeout: 45000 }, async t => {
  const f = await claimCustodyFixture(t), workspace = f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id, { ...workspace.settings, releaseWorkflowEnabled: true });
  await writeFile(path.join(f.source.projectRoot, "source.txt"), "user result\n");
  let entered, release, count = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const original = f.workspaces.snapshotAndMergeOwned.bind(f.workspaces);
  f.workspaces.snapshotAndMergeOwned = async (...args) => { count++; entered(); await held; return original(...args); };
  const lifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    taskGitWorkspaces: f.workspaces, releasePreflight: { withAwaitTransition: async (_id, work) => work() } });
  const data = snapshot();
  data.workspaces.push({ id: workspace.id, name: "Task result fixture", streams: [] });
  const fresh = () => ({ ...data, boardTasks: f.tasks.snapshot() });
  const controller = new DesktopTaskBoardController({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    taskGitWorkspaces: f.workspaces, taskLifecycle: lifecycle, hubMcpService: f.hub,
    taskLauncher: {}, snapshot: async () => fresh() });
  let id, settled;
  const workerSettled = new Promise(resolve => { settled = resolve; });
  const recordCommandTrace = f.hub.recordCommandTrace;
  f.hub.recordCommandTrace = span => {
    const result = recordCommandTrace(span);
    if (span.commandId === id && span.stage === "task-operation-result") settled();
    return result;
  };
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(9000);
    const diagnostics = await openFixture(page, { fixtureSnapshot: fresh() });
    const calls = []; let failRead = !lookupRefusal, lostAdmission = true;
    await page.exposeFunction("__taskOperationControl", async message => {
      calls.push({ action: message.action, params: message.params });
      if (message.action === "board-task-status") id = message.params.operationId;
      try {
        if (message.action === "board-task-read" && message.params.operationRequestId && failRead) {
          failRead = false; throw new Error("Desktop control connection closed without a response");
        }
        const result = message.action === "board-task-read" ? controller.read(lookupRefusal && message.params.operationRequestId
          ? { ...message.params, id: "foreign-task" } : message.params)
          : message.action === "board-task-operation-cancel" ? await controller.cancelOperation(message.params)
          : message.action === "snapshot" ? fresh()
          : await controller.status(message.params, { commandId: "outer-control-id", taskOperationReceipt: true });
        if (message.action === "board-task-status") {
          id = message.params.operationId;
          assert.equal(result.taskOperation.requestId, id);
          if (lostAdmission) { lostAdmission = false; throw new Error("Desktop control connection closed without a response"); }
        }
        return { id: message.id, ok: true, result };
      } catch (error) { return { id: message.id, ok: false, error: error.message }; }
    });
    await page.evaluate(() => {
      const previous = window.__fixtureBridge.postMessage;
      window.__fixtureBridge.postMessage = message => {
        if (!["snapshot", "board-task-status", "board-task-read", "board-task-operation-cancel"].includes(message.action)) return previous(message);
        void window.__taskOperationControl(message).then(outcome => window.dispatchEvent(new MessageEvent("message", {
          data: { type: "agenthub:control-result", ...outcome },
        })));
      };
    });
    await page.locator(width < 960 ? '[data-mobile-button="dashboard"]' : '[data-view-button="dashboard"]').click();
    await page.locator(`[data-board-task-id="${f.prior.id}"]`).first().click();
    const panel = page.locator('[data-task-card-modal]');
    const status = panel.locator('[data-task-card-status]').locator('..').getByRole('button');
    await status.click(); const menu = await status.getAttribute('aria-controls');
    await page.locator(`#${menu} [data-value="testing"]`).click(); await started;
    await page.waitForFunction(() => window.__fixtureBridge != null);
    assert.equal(f.tasks.task(f.prior.id).workflowStatus, f.prior.workflowStatus);
    assert.equal(f.catalog.mcpOperation(id).status, "pending");
    // The first read loses its transport. The next read must still address the
    // original operation; the mutation is never submitted again.
    if (lookupRefusal) {
      await page.getByText("Task operation Task identity differs", { exact: true }).waitFor();
      assert.equal(calls.filter(c => c.params.operationRequestId === id).length, 1);
      assert.equal(f.catalog.mcpOperation(id).status, "pending");
    } else {
      await assertEventually(() => calls.filter(c => c.params.operationRequestId === id).length >= 2);
      assert.equal(await panel.locator('[data-task-card-status]').isDisabled(), true,
        "lost admission and lookup replies must preserve pending controls while original work is held");
    }
    if (lookupRefusal) {
      assert.equal(await panel.locator('[data-task-card-status]').isDisabled(), false);
    } else if (width === 390) {
      // A pending result does not monopolize the user's cancellation controls.
      await panel.getByRole('button', { name: "Операции задачи", exact: true }).click();
      await panel.getByRole('button', { name: "Прервать операцию", exact: true }).click();
      release();
      await panel.getByText("Операция прервана. Уже выполненные действия сохранены.", { exact: true }).waitFor();
      assert.equal(f.catalog.mcpOperation(id).taskExecution.cancellation.phase, "stopped");
      assert.equal(f.tasks.task(f.prior.id).workflowStatus, f.prior.workflowStatus);
      await page.waitForFunction(expected => document.querySelector('[data-task-card-status]')?.value === expected
        && !document.querySelector('[data-task-card-status]')?.disabled, f.prior.workflowStatus);
    } else {
      release();
      await workerSettled;
      assert.equal(f.catalog.mcpOperation(id).status, "succeeded");
      await page.waitForFunction(() => document.querySelector('[data-task-card-status]')?.value === "testing"
        && !document.querySelector('[data-task-card-status]')?.disabled);
      assert.match(await panel.locator('[data-task-card-status]').locator('..').getByRole('button').textContent(), /Test/);
    }
    assert.equal(count, 1); assert.equal(calls.filter(c => c.action === "board-task-status").length, 1);
    const reads = calls.filter(c => c.params.operationRequestId === id);
    assert.ok(reads.every(c => c.params.argumentsHash == null || c.params.argumentsHash === f.catalog.mcpOperation(id).argumentsHash));
    if (!lookupRefusal) assert.ok(reads.some(c => c.params.argumentsHash === f.catalog.mcpOperation(id).argumentsHash));
    assert.deepEqual(diagnostics, []);
    const dir = new URL("../../WIP/hub368/common-r1/", import.meta.url); await mkdir(dir, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`result-${width}${lookupRefusal ? "-refusal" : ""}.png`, dir)), fullPage: true });
  } finally {
    release();
    try {
      if (id) {
        if (f.hub.readDesktopTaskOperation({}, id).taskOperation.active) await workerSettled;
        assert.equal(f.hub.readDesktopTaskOperation({}, id).taskOperation.active, false);
      }
    }
    finally { await browser.close(); }
  }
});

async function assertEventually(predicate) {
  const limit = Date.now() + 12000;
  while (!predicate()) { assert.ok(Date.now() < limit, "expected observable state did not arrive"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
