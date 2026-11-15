import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

for (const lostReply of [false, true]) test(`shipped Task client keeps unadmitted/missing receipt out of success and never resubmits: lostReply=${lostReply}`, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.setDefaultTimeout(9000);
    const data = snapshot();
    data.workspaces.push({ id: "admission-dom-workspace", name: "Admission workspace", streams: [] });
    const task = { id: "admission-dom-task", taskNumber: "QA-1", title: "Unadmitted Task",
      description: "Keep these user bytes", workflowStatus: "in_progress", status: "started",
      bucket: "workspace", workspaceId: "admission-dom-workspace", revision: 1, checklist: [], attachments: [] };
    data.boardTasks = [task];
    const diagnostics = await openFixture(page, { fixtureSnapshot: data });
    const calls = [];
    await page.exposeFunction("__admissionControl", async message => {
      calls.push(message);
      if (message.action === "board-task-status") return lostReply
        ? { id: message.id, ok: false, error: "Desktop control connection closed without a response" }
        : { id: message.id, ok: true, result: { taskOperation: null, result: null,
          admission: { version: 1, status: "not_admitted", scope: "this_invocation", canonicalOutcome: null,
            requestId: message.params.operationId, reason: "sqlite_begin_contention" } } };
      return { id: message.id, ok: true, result: { task, taskOperations: [], operation: { taskOperation: null,
        result: null, lookup: { version: 1, requestId: message.params.operationRequestId, status: "not_found", canonicalOutcome: null } } } };
    });
    await page.evaluate(() => {
      const prior = window.__fixtureBridge.postMessage;
      window.__fixtureBridge.postMessage = message => {
        if (!["board-task-status", "board-task-read"].includes(message.action)) return prior(message);
        void window.__admissionControl(message).then(result => window.dispatchEvent(new MessageEvent("message", {
          data: { type: "agenthub:control-result", ...result },
        })));
      };
    });
    await page.locator('[data-view-button="dashboard"]').click();
    await page.locator('[data-board-task-id="admission-dom-task"]').first().click();
    const panel = page.locator('[data-task-card-modal]');
    const status = panel.locator('[data-task-card-status]').locator('..').getByRole('button');
    await status.click();
    const menu = await status.getAttribute('aria-controls');
    await page.locator(`#${menu} [data-value="testing"]`).click();
    try {
      await page.getByText(lostReply ? /Квитанция операции .* не найдена.*исход не подтверждён/
        : /Не удалось принять запрос: хранилище занято/).waitFor();
    } catch (error) {
      const dir = new URL("../../WIP/hub407/", import.meta.url);
      await mkdir(dir, { recursive: true });
      await writeFile(new URL(`DOM-FAILURE-${lostReply}.json`, dir), JSON.stringify({
        text: await page.locator('body').innerText(), calls,
      }, null, 2));
      throw error;
    }
    assert.equal(calls.filter(c => c.action === "board-task-status").length, 1);
    assert.equal(calls.filter(c => c.action === "board-task-read" && c.params.operationRequestId).length, lostReply ? 1 : 0);
    assert.equal(await panel.locator('[data-task-card-status]').isDisabled(), false);
    assert.equal(await panel.locator('[data-task-card-status]').inputValue(), "in_progress");
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});
