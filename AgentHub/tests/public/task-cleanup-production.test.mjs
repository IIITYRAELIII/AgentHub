import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";

test("Complete and Delete show exact cleanup confirmation inside the VS Code sandbox", {
  timeout: 30_000,
}, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true } : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleErrors.push(message.text()); });
    await page.setContent('<title>Task cleanup fixture</title><iframe style="width:900px;height:700px" sandbox="allow-scripts allow-same-origin" srcdoc="<!doctype html><html><body>Task cleanup fixture</body></html>"></iframe>');
    assert.equal(page.url(), "about:blank");
    assert.equal(await page.title(), "Task cleanup fixture");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    for (const file of ["modal-overlays.js", "task-board.js"]) {
      await frame.addScriptTag({ content: await readFile(new URL(`../../assets/web-app/${file}`, import.meta.url), "utf8") });
    }
    await frame.addStyleTag({ content: await readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8") });
    await frame.evaluate(() => {
      window.__calls = [];
      window.confirm = () => { throw new Error("Native confirmation is unavailable in VS Code"); };
      window.__beginCleanup = (action, id = "fixture-task") => {
        window.__outcome = null;
        window.__error = null;
        window.__pending = window.AgentHubTaskCleanupConfirmation.confirm({
          action, params: { id, operationId: `operation-${id}` },
          confirmation: {
            task: { taskNumber: "FIXTURE-35" }, cleanupToken: `token-${id}`,
            warning: "Exact server cleanup preview <not markup>",
            preview: { dirty: false, workspaces: [{ projectRoot: "fixture/worktree", branch: "FIXTURE-35",
              headCommit: "a".repeat(40), dirty: false, changedPaths: [], untrackedPaths: [], ignoredPaths: ["WIP/evidence.txt"] }],
              deleting: [{ kind: "branch", name: "FIXTURE-35", repositoryRoot: "fixture/repo" }] },
          },
          request: async (requestedAction, params) => {
            window.__calls.push({ action: requestedAction, params });
            if (window.__rejectRequest) throw new Error("Task cleanup confirmation is stale or missing");
            return { completed: requestedAction === "board-task-complete", deleted: requestedAction === "board-task-remove" };
          },
        }).then((value) => { window.__outcome = value; }, (error) => { window.__error = error.message; });
      };
    });
    for (const action of ["board-task-complete", "board-task-remove"]) {
      await frame.evaluate((value) => window.__beginCleanup(value), action);
      const dialog = frame.locator("[data-task-cleanup-modal]");
      await dialog.waitFor({ state: "visible" });
      assert.match(await dialog.textContent(), /FIXTURE-35/u);
      assert.match(await dialog.textContent(), /Exact server cleanup preview <not markup>/u);
      assert.match(await dialog.textContent(), /\[branch\] FIXTURE-35 \(repo: fixture\/repo\)/u);
      assert.match(await dialog.textContent(), /Игнорируемые данные \(сохранить\):\s+- WIP\/evidence\.txt/u);
      assert.match(await dialog.textContent(), /Состояние: clean/u);
      const previewText = frame.locator(".task-cleanup-preview");
      await previewText.hover();
      await page.mouse.wheel(0, 200);
      await frame.waitForFunction(() => document.querySelector(".task-cleanup-preview").scrollTop > 0);
      if (action === "board-task-complete" && process.env.AGENT_HUB_QA_SCREENSHOT_DIR) {
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, "ignored-wip-preview-scrolled.png"), fullPage: false });
      }
      await frame.locator("[data-task-cleanup-cancel]").click();
      assert.equal(await frame.evaluate(() => window.__outcome.confirmed), false);
      await frame.evaluate((value) => window.__beginCleanup(value), action);
      await frame.locator("[data-task-cleanup-confirm]").evaluate((button) => {
        button.click();
        button.click();
      });
      await frame.evaluate(() => window.__pending);
      const call = await frame.evaluate(() => window.__calls.at(-1));
      assert.deepEqual(call, { action, params: {
        id: "fixture-task", operationId: "operation-fixture-task",
        confirmCleanup: true, expectedCleanupToken: "token-fixture-task",
      } });
      assert.equal(await dialog.count(), 0);
    }
    assert.equal(await frame.evaluate(() => window.__calls.length), 2);
    await frame.evaluate(() => window.__beginCleanup("board-task-complete"));
    await frame.locator("[data-task-cleanup-cancel]").press("Escape");
    assert.equal(await frame.evaluate(() => window.__outcome.confirmed), false);
    await frame.evaluate(() => {
      window.__rejectRequest = true;
      window.__beginCleanup("board-task-remove");
    });
    await frame.locator("[data-task-cleanup-confirm]").click();
    await frame.evaluate(() => window.__pending);
    assert.match(await frame.evaluate(() => window.__error), /stale/u);
    assert.deepEqual(errors, []);
    // Existing same-origin VS Code fixture requires both sandbox capabilities;
    // Chromium warns about that combination before any application script runs.
    const sandboxWarning = "An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.";
    assert.deepEqual(consoleErrors.filter(message => message !== sandboxWarning), []);
  } finally {
    await browser.close();
  }
});
