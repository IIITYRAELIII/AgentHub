import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { createDesktopTaskHistoryFactory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { mergeActiveTaskHistory, mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";
import { createObservedTaskRun } from "../../src/domain/task-runs.mjs";
import { createDesktopSnapshotFactory } from "../../src/interfaces/desktop/desktop-snapshot.mjs";
import { codexRolloutHistory } from "../../src/interfaces/telegram/task-view-controller.mjs";
import { parseCodexRolloutActivity } from "../../src/providers/codex/codex-rollout-activity.mjs";
import { message, observer, start, turnId } from "../providers/codex/codex-rollout-answer.fixture.mjs";
import { applyFixtureSnapshot, launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

test("rollout observer through desktop and shipped client renders exact commentary and final owners", async () => {
  const text = "Equal text belongs to distinct provider items.";
  const source = start() + message("comment-one", "commentary", text);
  let activity = parseCodexRolloutActivity(source);
  const service = observer(async () => activity);
  const binding = { provider: "codex", threadId: "thread-a", turnId,
    observer: true, exactTurnObserver: true, status: "running", operationKind: "user-turn" };
  const initial = await service.read(binding);
  const run = createObservedTaskRun(binding, initial);
  service.applyObserved(run, initial);
  const { desktopRunSnapshot } = createDesktopSnapshotFactory({
    runs: { titleFor: () => "Synthetic turn" },
    context: { latestUsage: () => null, compactionFor: () => null },
  });
  const value = snapshot();
  value.tasks[0].running = true;
  value.tasks[0].run = { ...desktopRunSnapshot(run, { operationKind: "user-turn" }), projectionState: "active" };
  assert.equal(value.tasks[0].run.response, "");
  assert.equal(value.tasks[0].run.responseItemId, "comment-one");
  assert.equal(value.tasks[0].run.responsePhase, "commentary");
  const history = { provider: "codex", threadId: "thread-a", streamId: "stream-a",
    start: 0, end: 1, total: 1, messageTotal: 1, version: "rollout-first",
    items: codexRolloutHistory(activity) };
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = await openFixture(page, { fixtureSnapshot: value, fixtureHistory: history });
    await page.locator("[data-stream-task-id='stream-a']").first().click();
    const card = page.locator("[data-chat-live]");
    await page.waitForFunction(() => document.querySelector("[data-chat-live]")?.innerText
      .includes("Equal text belongs to distinct provider items."));
    assert.equal((await card.innerText()).split(text).length - 1, 1);
    assert.equal(await card.locator("[data-live-body]").isVisible(), false);
    if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await page.screenshot({
      path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, "rollout-commentary.png"),
    });

    activity = parseCodexRolloutActivity(source + message("comment-two", "commentary", text));
    service.applyObserved(run, await service.read(run));
    const next = structuredClone(value);
    next.version = "rollout-second";
    next.tasks[0].run = { ...desktopRunSnapshot(run, { operationKind: "user-turn" }), projectionState: "active" };
    await applyFixtureSnapshot(page, next);
    await page.waitForFunction(() => document.querySelectorAll("[data-chat-live] .turn-trace-reasoning").length === 2);
    assert.equal((await card.innerText()).split(text).length - 1, 2,
      "two equal commentary items remain distinct");

    activity = parseCodexRolloutActivity(source + message("comment-two", "commentary", text)
      + message("final-one", "final_answer", text));
    service.applyObserved(run, await service.read(run));
    const final = structuredClone(next);
    final.version = "rollout-final-item";
    final.tasks[0].run = { ...desktopRunSnapshot(run, { operationKind: "user-turn" }), projectionState: "active" };
    await applyFixtureSnapshot(page, final);
    await page.waitForFunction(() => !document.querySelector("[data-chat-live] [data-live-body]").hidden);
    assert.equal(await card.locator("[data-live-body]").innerText(), text);
    assert.equal((await card.innerText()).split(text).length - 1, 3,
      "the distinct streaming final remains visible beside both commentary items");
    assert.deepEqual(errors, []);
    if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await page.screenshot({
      path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, "rollout-streaming-final.png"),
    });
  } finally {
    await browser.close();
  }
});

test("commentary citation reaches the quoted user through live and streaming final", { timeout: 30_000 }, async () => {
  const raw = 'The correction is ready. :agent-annotation{index="1"}';
  const literal = 'Example `:agent-annotation{index="2"}`\n\n```text\n:agent-annotation{index="3"}\n```';
  const source = start() + message("quoted-comment", "commentary", raw + '\n\n' + literal);
  let activity = parseCodexRolloutActivity(source);
  const service = observer(async () => activity);
  const binding = { provider: "codex", threadId: "thread-a", turnId,
    observer: true, exactTurnObserver: true, status: "running", operationKind: "user-turn" };
  const initial = await service.read(binding);
  const run = createObservedTaskRun(binding, initial);
  service.applyObserved(run, initial);
  const { desktopRunSnapshot } = createDesktopSnapshotFactory({
    runs: { titleFor: () => "Quoted reply" },
    context: { latestUsage: () => null, compactionFor: () => null },
  });
  const user = { id: 'quoted-user', role: 'user', itemId: 'quoted-user', provider: 'codex',
    threadId: 'thread-a', turnId, text: 'Check this change',
    responseAnnotations: [{ text: 'Apply the correction', annotation: 'Is this ready?' }] };
  const live = desktopRunSnapshot(run, { operationKind: 'user-turn' });
  const partial = desktopRunSnapshot({ ...run, activityGroups: parseCodexRolloutActivity(
    start() + message('quoted-comment', 'commentary', raw.slice(0, -2)),
  ).activityGroups[turnId] }, { operationKind: 'user-turn' });
  const rawGroups = structuredClone(run.activityGroups);
  const history = { provider: 'codex', threadId: 'thread-a', streamId: 'stream-a',
    start: 0, end: 1, total: 1, messageTotal: 1, version: 'quoted-live',
    items: [{ id: turnId, active: true, completed: false, messages: [user] }] };
  const browser = await launchBrowser();
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 },
        isMobile: width === 390, hasTouch: width === 390 });
      page.setDefaultTimeout(3_000);
      try {
        const value = snapshot();
        value.tasks[0].running = true;
        value.tasks[0].run = { ...partial, projectionState: 'active' };
        const errors = await openFixture(page, { fixtureSnapshot: value, fixtureHistory: history });
        if (width === 390) await page.evaluate(() => window.AgentHub.showSelectedTask());
        else await page.locator("[data-stream-task-id='stream-a']").first().click();
        const trace = page.locator('[data-chat-live] .turn-trace-reasoning');
        await trace.waitFor({ state: 'visible' });
        assert.equal((await trace.innerText()).includes(':agent-annotation'), false);
        assert.equal(await trace.locator('[data-response-citation-index="1"]').count(), 0);
        value.version = 'quoted-full-commentary';
        value.tasks[0].run = { ...live, projectionState: 'active' };
        await applyFixtureSnapshot(page, value);
        await trace.locator('[data-response-citation-index="1"]').waitFor({ state: 'visible' });
        assert.equal(await trace.locator('[data-response-citation-index="1"]').count(), 1);
        assert.ok(!(await trace.innerText()).includes(raw));
        assert.ok((await trace.locator('code').allTextContents()).includes(':agent-annotation{index="2"}'));
        assert.ok((await trace.locator('code').allTextContents()).some(text => text.includes(':agent-annotation{index="3"}')));
        const link = trace.locator('[data-response-citation-index="1"]');
        await link.focus(); await page.keyboard.press('Enter');
        await page.locator('.msg-annotation-content.is-citation-target').waitFor();
        const next = structuredClone(value);
        next.version = 'quoted-final';
        activity = parseCodexRolloutActivity(source + message('quoted-final', 'final_answer', raw));
        service.applyObserved(run, await service.read(run));
        next.tasks[0].run = { ...desktopRunSnapshot(run, { operationKind: 'user-turn' }), projectionState: 'active' };
        await applyFixtureSnapshot(page, next);
        await page.locator('[data-live-body] [data-response-citation-index="1"]').waitFor({ state: 'visible' });
        assert.equal(await trace.locator('[data-response-citation-index="1"]').count(), 1);
        if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await page.screenshot({
          path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, `commentary-citation-${width}.png`),
        });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  assert.deepEqual(run.activityGroups, rawGroups, 'presentation never rewrites canonical trace groups');
});

test("commentary citations survive SQLite history and addressed trace pages without rewriting source", { timeout: 30_000 }, async () => {
  const raw = 'A saved reply. :agent-annotation{index="1"}';
  const activity = parseCodexRolloutActivity(start() + message('saved-comment', 'commentary', raw));
  const groups = activity.activityGroups[turnId];
  const user = { role: 'user', itemId: 'saved-user', text: 'Check the saved reply',
    responseAnnotations: [{ text: 'Exact quoted change', annotation: 'Please check' }] };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-comment-citation-'));
  const binding = { provider: 'codex', threadId: 'thread-a', streamId: 'stream-a', projectRoot: directory };
  const filePath = path.join(directory, 'tasks.json');
  let store = new LocalTaskSyncStore({ filePath });
  let browser;
  try {
    await store.load();
    await store.recordHistory(binding, [{ id: turnId, completed: true, status: 'completed',
      prompt: user.text, answer: 'Final saved answer', activityGroups: groups,
      messages: [user, { role: 'agent', itemId: 'saved-final', text: 'Final saved answer' }] },
    { id: 'later-turn', completed: true, status: 'completed', prompt: 'A later question',
      messages: [{ role: 'user', itemId: 'later-user', text: 'A later question',
        responseAnnotations: [{ text: 'Unrelated later quote', annotation: 'Wrong later target' }] }] }]);
    store.close(); store = new LocalTaskSyncStore({ filePath }); await store.load();
    const before = structuredClone(store.history(binding));
    const page = { groups, generation: 'exact-generation', sourceHash: 'source-hash', sourceSize: 123, nextOffset: null };
    const api = createDesktopTaskHistoryFactory({
      selection: { activeProvider: () => 'codex', threadId: () => binding.threadId, chatId: () => 42 },
      catalog: { entries: () => [{ ...binding, title: 'Saved chat' }] },
      historyReader: { read: async () => ({ history: store.history(binding) }), refresh: async () => page },
      runs: { forTask: () => null }, receipts: { forMessage: () => null, forTurn: () => null },
      historyMerger: { mergeActive: mergeActiveTaskHistory, mergeCompleted: mergeCompletedTaskHistory },
      responseBudget: { fit: value => value },
    });
    const history = await api({ provider: 'codex', threadId: binding.threadId, includeActive: false });
    const detail = await api({ provider: 'codex', threadId: binding.threadId, tracePage: { turnId, offset: 0 } });
    assert.equal(detail.tracePage.generation, page.generation);
    assert.equal(detail.tracePage.sourceHash, page.sourceHash);
    assert.equal(detail.tracePage.groups[0].reasoning, raw);
    assert.equal(detail.tracePage.groups[0].responseAnnotationPresentation.text.includes(':agent-annotation'), false);
    assert.deepEqual(page.groups, groups, 'addressed read never alters its source');
    browser = await launchBrowser();
    for (const width of [1280, 390]) {
      const view = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      view.setDefaultTimeout(3_000);
      try {
        const errors = await openFixture(view, { fixtureHistory: history });
        for (const reload of [false, true]) {
          if (reload) await view.reload({ waitUntil: 'load' });
          if (width === 390) await view.evaluate(() => window.AgentHub.showSelectedTask());
          else await view.locator("[data-stream-task-id='stream-a']").first().click();
          const disclosure = view.locator('details.turn-trace');
          await disclosure.locator('summary').click();
          const trace = disclosure.locator('.turn-trace-reasoning');
          const control = trace.locator('[data-response-citation-index="1"]');
          await control.waitFor({ state: 'visible' });
          assert.ok((await control.innerText()).includes('Please check'));
          assert.equal((await control.innerText()).includes('Wrong later target'), false);
          assert.equal((await trace.innerText()).includes(':agent-annotation'), false);
          await control.focus(); await view.keyboard.press('Enter');
          await view.locator('.msg-annotation-content.is-citation-target').waitFor();
        }
        assert.equal(await view.title(), 'Agent Hub');
        assert.deepEqual(errors, []);
        if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await view.screenshot({
          path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, `commentary-history-${width}.png`),
        });
      } finally { await view.close(); }
    }
    assert.deepEqual(store.history(binding), before, 'read/render/reload retain stored canonical source');
  } finally {
    await browser?.close(); store.close(); await rm(directory, { recursive: true, force: true });
  }
});
