import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskReadStateStore, taskHasUnreadAnswer } from "../../src/infrastructure/persistence/task-read-state-store.mjs";
import { DesktopReadModelService } from "../../src/interfaces/desktop/desktop-read-model-service.mjs";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

for (const [shape, mobile] of [["ordinary", false], ["heavy", false], ["ordinary", true]]) {
  test(`cold ${shape} ${mobile ? "mobile" : "desktop"} chat displays its full exchange and confirms read before selection reply`,
    { timeout: 30000 }, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "hub-cold-selection-"));
      const readStateStore = new TaskReadStateStore({ dataDir: directory });
      const browser = await launchBrowser();
      let releaseSelection;
      let selectionTimer;
      let stage = "initialize";
      let page;
      const completedAt = "2026-11-09T10:00:00.000Z";
      const sourceSnapshot = snapshot();
      const service = new DesktopReadModelService({
        resolveReadTask: ({ provider, threadId }) => sourceSnapshot.tasks.find(task => (
          task.provider === provider && task.threadId === threadId
        )),
        readStateStore, trustedDeviceUserId: () => "local", hasUnread: taskHasUnreadAnswer,
        lastTaskMessage: task => task.threadId === "thread-b" ? {
          provider: "codex", threadId: "thread-b", turnId: "final-b", terminalRevision: 1,
          updatedAt: completedAt,
        } : null,
        snapshot: ({ projectTask = value => value } = {}) => ({ ...sourceSnapshot,
          tasks: sourceSnapshot.tasks.map(task => projectTask(task.threadId === "thread-b"
            ? { ...task, lastAnswerAt: completedAt, lastAnswerTurnId: "final-b" } : task)),
        }),
      });
      try {
        await readStateStore.initialize();
        const initial = await service.snapshot();
        page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 }
          : { width: 1440, height: 1000 } });
        page.setDefaultTimeout(5000);
        const assetOverrides = process.env.AGENT_HUB_TEST_CLIENT_ASSET
          ? { "hub-client.js": await readFile(process.env.AGENT_HUB_TEST_CLIENT_ASSET, "utf8") } : {};
        const errors = await openFixture(page, { fixtureSnapshot: initial, surface: "web", assetOverrides });
        stage = "open";
        if (mobile) await page.locator('[data-mobile-dialogs-tab="chat"]').click();
        const performanceSession = await page.context().newCDPSession(page);
        await performanceSession.send("Performance.enable");
        const count = shape === "heavy" ? 20 : 2;
        const history = { provider: "codex", threadId: "thread-b", streamId: "stream-b",
          start: 0, end: count, total: count, nextBefore: null, version: `cold-${shape}`,
          items: Array.from({ length: count }, (_, index) => ({
            id: index === count - 1 ? "final-b" : `old-${index}`, completed: true,
            status: "completed", terminalRevision: 1, completedAt,
            prompt: index === count - 1 ? "Latest exact user request" : `Earlier request ${index}\n${"user text ".repeat(shape === "heavy" ? 1000 : 1)}`,
            answer: index === count - 1 ? `Full final beginning\n${"complete final ".repeat(1000)}\nFull final ending`
              : `Earlier answer ${index}\n${"answer text ".repeat(shape === "heavy" ? 3000 : 1)}`,
          })),
        };
        const measurements = { shape, mobile, requests: [], selectionReleased: false, read: null };
        const selection = new Promise(resolve => { releaseSelection = resolve; });
        const reply = (route, result) => route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ ok: true, result }) });
        let historyRequests = 0;
        await page.route("**/api/control", async route => {
          const { action, params } = route.request().postDataJSON();
          if (action === "select-task" && params?.streamId === "stream-a") return reply(route, initial);
          if (params?.streamId !== "stream-b") return route.fallback();
          measurements.requests.push({ action, bytes: route.request().postDataBuffer().length });
          if (action === "select-task" || action === "open-task") {
            await selection;
            measurements.selectionReleased = true;
            return reply(route, action === "open-task" ? { history, snapshot: initial }
              : params.deferSnapshot ? { selectionChanged: true, snapshotDeferred: true } : initial);
          }
          if (action === "task-history") {
            historyRequests += 1;
            // The exact local page is immediately available. Later provider
            // refresh remains held by the harness, independently of selection.
            if (historyRequests > 1) await selection;
            return reply(route, history);
          }
          if (action === "mark-task-read") {
            measurements.read = params.final;
            return reply(route, await service.markTaskRead(params));
          }
          return route.fallback();
        });
        if (mobile) assert.match(await page.locator('[data-mobile-stream-id="stream-b"]:visible').first().getAttribute("aria-label"), /Новое/u);
        else assert.equal(await page.locator('[data-stream-task-id="stream-b"][data-answer-ready]:visible').count(), 1);
        stage = "click";
        const beforeMetrics = await performanceSession.send("Performance.getMetrics");
        const beforeUsage = process.resourceUsage();
        await page.evaluate(() => {
          window.__coldLongTasks = { count: 0, totalMs: 0, maxMs: 0 };
          window.__coldLongTaskObserver = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              const value = window.__coldLongTasks;
              value.count += 1;
              value.totalMs += entry.duration;
              value.maxMs = Math.max(value.maxMs, entry.duration);
            }
          });
          window.__coldLongTaskObserver.observe({ type: "longtask", buffered: false });
        });
        const started = performance.now();
        selectionTimer = setTimeout(releaseSelection, 3500);
        await page.locator(mobile ? '[data-mobile-stream-id="stream-b"]'
          : '[data-stream-task-id="stream-b"]:visible').first().click();
        stage = "exchange";
        const userCard = page.locator('[data-chat-pane] [data-role="user"][data-turn-id="final-b"]').first();
        await userCard.waitFor();
        assert.ok((await userCard.textContent()).includes("Latest exact user request"));
        const finalCard = page.locator('[data-chat-pane] [data-role="agent"][data-turn-id="final-b"]').first();
        await finalCard.waitFor();
        const finalText = await finalCard.textContent();
        assert.ok(finalText.includes("Full final beginning") && finalText.includes("Full final ending"));
        measurements.fullExchangeMs = performance.now() - started;
        stage = "read-clear";
        await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute("data-answer-ready"));
        measurements.clearMs = performance.now() - started;
        measurements.historyResponseBytes = Buffer.byteLength(JSON.stringify(history));
        const afterUsage = process.resourceUsage();
        const afterMetrics = await performanceSession.send("Performance.getMetrics");
        const metric = (value, name) => value.metrics.find(item => item.name === name)?.value ?? null;
        measurements.renderer = {
          taskWorkMs: 1000 * (metric(afterMetrics, "TaskDuration") - metric(beforeMetrics, "TaskDuration")),
          scriptWorkMs: 1000 * (metric(afterMetrics, "ScriptDuration") - metric(beforeMetrics, "ScriptDuration")),
          heapBeforeBytes: metric(beforeMetrics, "JSHeapUsedSize"),
          heapAfterBytes: metric(afterMetrics, "JSHeapUsedSize"),
          nodesAfter: metric(afterMetrics, "Nodes"),
          longTasks: await page.evaluate(() => window.__coldLongTasks),
        };
        measurements.testProcess = {
          cpuUserMs: (afterUsage.userCPUTime - beforeUsage.userCPUTime) / 1000,
          cpuSystemMs: (afterUsage.systemCPUTime - beforeUsage.systemCPUTime) / 1000,
          maxRSSKiB: afterUsage.maxRSS,
          fileReadOperations: afterUsage.fsRead - beforeUsage.fsRead,
          fileWriteOperations: afterUsage.fsWrite - beforeUsage.fsWrite,
          qualification: "Test Node process counters, not Hub process or wire/SQLite byte attribution",
        };
        await page.evaluate(() => window.__coldLongTaskObserver.disconnect());
        if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
          const evidence = process.env.AGENT_HUB_UI_EVIDENCE_DIR;
          await mkdir(evidence, { recursive: true });
          const name = `${shape}-${mobile ? "mobile" : "desktop"}`;
          await page.screenshot({ path: path.join(evidence, `${name}.png`) });
          await writeFile(path.join(evidence, `${name}.json`), JSON.stringify(measurements, null, 2));
        }
        console.log(JSON.stringify(measurements));
        assert.equal(measurements.selectionReleased, false, "ready history and read ACK must not wait for the selection reply");
        assert.deepEqual(measurements.read, initial.tasks[1].latestFinal);
        assert.equal(await page.locator('[data-activity-task-id="stream-b"][data-answer-ready]').count(), 0);
        assert.equal(await page.locator('[data-role="user"]').count(), count);
        assert.equal((await service.snapshot()).tasks[1].unread, false);
        assert.deepEqual(errors, []);
        if (!mobile && shape === "ordinary") {
          // A late successful selection cannot navigate back over a newer
          // user choice, even though its history was already painted early.
          await page.locator('[data-stream-task-id="stream-a"]:visible').first().click();
          await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === "stream-a");
          const replyReceived = page.waitForResponse(response => {
            if (!response.url().endsWith("/api/control")) return false;
            const body = response.request().postDataJSON();
            return body.action === "select-task" && body.params.streamId === "stream-b";
          });
          releaseSelection();
          await (await replyReceived).finished();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(await page.locator('[data-chat-pane]').getAttribute("data-stream-chat-task-id"), "stream-a");
        }
        releaseSelection();
        await page.waitForFunction(() => !document.querySelector('[data-provider-connection-retry]')?.disabled);
      } catch (error) {
        console.error(JSON.stringify({ shape, mobile, stage, state: page && !page.isClosed()
          ? await page.evaluate(() => ({ view: document.documentElement.dataset.view,
            pane: document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId,
            toasts: window.__toastHistory })) : null }));
        throw error;
      } finally {
        clearTimeout(selectionTimer);
        releaseSelection?.();
        await browser.close();
        readStateStore.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
}
