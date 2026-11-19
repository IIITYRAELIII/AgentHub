import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { currentLiveProgress } from "../fixtures/current-live-progress.mjs";
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot, bridgeCalls } from "./composer-production.fixture.mjs";

const history = { provider: "codex", streamId: "stream-a", threadId: "thread-a",
  start: 0, end: 1, total: 1, messageTotal: 2, nextBefore: null, version: "retained-history",
  items: [{ id: "previous-turn", completed: true, terminalRevision: 1,
    startedAt: "2026-11-19T23:59:00.000Z", messages: [
      { role: "user", itemId: "previous-user", text: "Previous request" },
      { role: "agent", itemId: "previous-final", phase: "final", text: "Previous final" },
    ] }] };

for (const width of [1280, 390]) test(`same live progress returns after uncertainty without reload at ${width}px`, { timeout: 40000 }, async t => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390 });
  try {
    const trace = [];
    page.on("request", request => {
      if (request.url().endsWith("/api/command-trace/client-events")) {
        trace.push(...(request.postDataJSON()?.events ?? []).filter(event => event.commandId === "client-live"
          && ["selected-gate", "snapshot-live-dom"].includes(event.metadata?.action)));
      }
    });
    const f = currentLiveProgress();
    let version = 0;
    const project = () => {
      const value = snapshot();
      Object.assign(value.tasks[0], f.project());
      value.version = `live-progress-${++version}`;
      return value;
    };
    await f.poll();
    const errors = await openFixture(page, { fixtureSnapshot: project(), fixtureHistory: history });
    if (width === 390) await page.locator("[data-mobile-button='chat']").click();
    const live = page.locator("[data-chat-live]");
    await live.waitFor({ state: "visible" });
    await page.getByText("Previous final", { exact: true }).waitFor();
    const documentId = await page.evaluate(() => window.__progressDocument = crypto.randomUUID());
    f.fail(); await f.poll();
    await applyFixtureSnapshot(page, project());
    await live.waitFor({ state: "hidden" });
    assert.equal(f.project().activityUnknown, true);
    assert.equal(await page.getByText("Previous final", { exact: true }).count(), 1);

    const readAt = performance.now();
    f.resume(); await f.poll();
    const publicationMs = performance.now() - readAt;
    assert.equal(f.project().running, true);
    const applyAt = performance.now();
    await applyFixtureSnapshot(page, project());
    await live.waitFor({ state: "visible" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visibleMs = performance.now() - applyAt;
    assert.match(await live.innerText(), /Current progress continues/u);
    const command = live.getByText("shell_command", { exact: true });
    // Activity bodies are lazy until their real disclosure opens.
    await live.locator(".turn-trace-activities > summary").click();
    await command.waitFor({ state: "visible" });
    assert.equal(await command.isVisible(), true);
    assert.equal(await live.count(), 1);
    assert.equal(await page.evaluate(() => window.__progressDocument), documentId);
    assert.equal(await page.getByText("Current request", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Previous final", { exact: true }).count(), 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    await applyFixtureSnapshot(page, project());
    assert.equal(await live.count(), 1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (let batch = 0; batch < 8 && !trace.some(event => event.metadata.action === "snapshot-live-dom"
      && event.metadata.afterRun === "active"); batch += 1) {
      await page.waitForFunction(() => !window.AgentHubCommandTrace.diagnostics().flushing);
      await page.evaluate(() => window.AgentHubCommandTrace.flush());
    }
    assert.ok(trace.some(event => event.metadata.action === "snapshot-live-dom"
      && event.metadata.turnId === "turn-live" && event.metadata.afterRun === "active"));
    if (process.env.AGENT_HUB_PROGRESS_SCREENSHOTS) {
      await mkdir(process.env.AGENT_HUB_PROGRESS_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_PROGRESS_SCREENSHOTS, `live-progress-${width}.png`) });
    }
    await page.reload();
    if (width === 390) await page.locator("[data-mobile-button='chat']").click();
    await live.waitFor({ state: "visible" });
    assert.equal(await live.count(), 1);
    assert.equal(await page.getByText("Previous final", { exact: true }).count(), 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(new URL(page.url()).hostname, "agent-hub.test");
    assert.match(await page.title(), /Agent Hub/u);
    assert.deepEqual(errors, []);
    t.diagnostic(JSON.stringify({ clientUserMessageId: f.run.clientUserMessageId, turnId: f.run.turnId,
      width, controlledReadToPublicationMs: publicationMs, driverApplyToPaintMs: visibleMs,
      existingTrace: trace.map(event => ({ stage: event.stage, observedAtMs: event.observedAtMs,
        action: event.metadata.action, beforeRun: event.metadata.beforeRun, afterRun: event.metadata.afterRun,
        render: event.metadata.render, snapshotVersion: event.metadata.snapshotVersion })) }));
  } finally { await browser.close(); }
});
