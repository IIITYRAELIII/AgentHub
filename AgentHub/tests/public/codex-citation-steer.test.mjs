import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCodexRolloutActivity } from "../../src/providers/codex/codex-rollout-activity.mjs";
import { readCodexTracePageInWorker } from "../../src/providers/codex/codex-rollout-activity-worker-client.mjs";
import { startCodexAgentMessage, completeCodexAgentMessage, codexAgentMessageSourceText } from "../../src/providers/codex/codex-agent-message-reducer.mjs";
import { upsertRunReasoningBlock } from "../../src/domain/run-activity.mjs";
import { createObservedTaskRun } from "../../src/domain/task-runs.mjs";
import { createDesktopSnapshotFactory } from "../../src/interfaces/desktop/desktop-snapshot.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { createDesktopTaskHistoryFactory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { mergeActiveTaskHistory, mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";
import { codexRolloutHistory, TaskViewController } from "../../src/interfaces/telegram/task-view-controller.mjs";
import { row, message, start, turnId, observer } from "../providers/codex/codex-rollout-answer.fixture.mjs";
import { applyFixtureSnapshot, launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

const user = (id, comment) => row("response_item", { type: "message", role: "user", id,
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
  content: [{ type: "input_text", text: `<response-annotations>${JSON.stringify([
    { text: `Exact source ${id}`, annotation: comment },
  ])}</response-annotations>\n<user-request>Check ${id}</user-request>` }],
});
const marked = text => `${text} :agent-annotation{index="1"}`;
const binding = { provider: "codex", threadId: "thread-a", turnId, streamId: "stream-a",
  observer: true, exactTurnObserver: true, status: "running", operationKind: "user-turn" };
const { desktopRunSnapshot } = createDesktopSnapshotFactory({
  runs: { titleFor: () => "Steered answer" }, context: { latestUsage: () => null, compactionFor: () => null },
});
function liveSnapshot(run, version) {
  const value = snapshot(); value.version = version; value.tasks[0].running = true;
  value.tasks[0].run = { ...desktopRunSnapshot(run, { operationKind: "user-turn" }), projectionState: "active" };
  return value;
}
const historyFor = activity => ({ provider: "codex", threadId: "thread-a", streamId: "stream-a",
  start: 0, end: 1, total: 1, messageTotal: 1, version: "citation-context",
  items: codexRolloutHistory(activity) });

test("real quote clicks acknowledge immediately and paint the exact card after live completion", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-live-quote-"));
  const file = path.join(directory, "rollout.jsonl");
  const browser = await launchBrowser();
  try {
    const quote = "A native 🦊 fragment.";
    const native = message("quote-item", "commentary", quote);
    const activity = parseCodexRolloutActivity(start() + native);
    const service = observer(async () => activity);
    const observed = await service.read(binding);
    const run = createObservedTaskRun({ ...binding, userMessages: observed.userMessages }, observed);
    service.applyObserved(run, observed);
    const group = activity.activityGroups[turnId][0];
    const full = quote + " More reasoning.";
    await writeFile(file, row("session_meta", { id: "01a0ea85-db2c-7bd3-bfad-2634824c6069" })
      + start() + message("quote-item", "commentary", full));

    const owner = new TaskViewController({
      findCodexRolloutPath: async () => file,
      readCodexTracePage: readCodexTracePageInWorker,
    });
    const serverEvents = [];
    const requests = [];
    const gate = Promise.withResolvers();
    const api = createDesktopTaskHistoryFactory({
      selection: { activeProvider: () => binding.provider, threadId: () => binding.threadId, chatId: () => 42 },
      catalog: { entries: () => [{ ...binding, title: "Quote source" }] },
      historyReader: { refresh: (source, options) => owner.readHistory(source, options) },
      commandTrace: { recordBestEffort: event => serverEvents.push(event) },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 880 } });
    page.setDefaultTimeout(5_000);
    const errors = await openFixture(page, {
      fixtureSnapshot: liveSnapshot(run, "quote-live"), fixtureHistory: historyFor(activity), localWeb: true,
      tracePageReader: async params => {
        requests.push(params);
        if (requests.length === 1) await gate.promise;
        return api(params, { source: "test-fixture" });
      },
    });
    await page.evaluate(() => {
      window.AgentHub.showSelectedTask();
      window.__quoteTraceEvents = [];
      window.AgentHubCommandTrace.bindReporter(async ({ events }) => window.__quoteTraceEvents.push(...events));
    });
    const live = page.locator("[data-chat-live] .turn-trace-reasoning").first();
    const menu = page.locator('[data-action="annotate-selection"]');
    const pending = page.getByText("Проверяем источник цитаты…", { exact: true });
    const card = page.locator("[data-annotations] .annotation-quote");
    const input = page.locator("[data-composer-input]");
    async function openMenu(surface, length) {
      await surface.waitFor({ state: "visible" });
      await surface.evaluate((node, end) => {
        const range = window.AgentHubMessageDisclosure.domRangeFromOffsets(node, 0, end ?? node.textContent.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }, length);
      await surface.click({ button: "right", position: { x: 10, y: 8 } });
      await menu.waitFor({ state: "visible" });
    }

    await input.fill("Draft before quote");
    await openMenu(live, quote.length);
    await menu.click();
    await pending.waitFor();
    assert.equal(await card.count(), 0);
    await openMenu(live, quote.length);
    await menu.click();
    assert.equal(requests.length, 1, "a repeated click while pending must share the current UI action");

    const completed = { id: "final-source", role: "agent", provider: "codex", threadId: binding.threadId,
      turnId, itemId: "native-final", text: "Final response.", activityGroups: [{ ...group, reasoning: full }] };
    await page.evaluate(({ completed, group }) => {
      window.AgentHub.setLive("stream-a", { ...completed, activityGroups: [{ ...group, reasoning: group.reasoning + " More reasoning." }] });
    }, { completed, group });
    await input.fill("Draft edited while waiting");
    await input.press("Home");
    const beforeCursor = await input.evaluate(node => node.selectionStart);
    await page.evaluate(completed => {
      window.AgentHub.setMessages("stream-a", [completed]);
      window.AgentHub.setLive("stream-a", null);
    }, completed);
    gate.resolve();
    await card.waitFor();
    await pending.waitFor({ state: "hidden" });
    assert.equal(await card.textContent(), quote);
    assert.equal(await input.inputValue(), "Draft edited while waiting");
    assert.deepEqual(await input.evaluate(node => [document.activeElement === node, node.selectionStart]), [true, beforeCursor]);
    const saved = await page.evaluate(() => composerDraftState("stream-a").annotations[0].source);
    assert.deepEqual([saved.provider, saved.threadId, saved.turnId, saved.itemId, saved.traceGroupId, saved.start, saved.end],
      ["codex", binding.threadId, turnId, group.sourceItemId, group.id, 0, quote.length]);
    for (const hash of [saved.contentHash, saved.surfaceHash, saved.selectionHash]) assert.match(hash, /^sha256:[a-f0-9]{64}$/u);

    const commandId = requests[0].clientTraceId;
    assert.match(commandId, /^[a-f0-9-]{36}$/u);
    assert.deepEqual(serverEvents.map(event => event.stage), ["trace-history-binding", "trace-source-locate",
      "trace-worker-wait", "trace-source-read", "trace-history-presentation"]);
    assert.ok(serverEvents.every(event => event.commandId === commandId && event.outcome === "succeeded"
      && Number.isFinite(event.monotonicDurationMs)));
    const clientEvents = await page.evaluate(async id => {
      for (let i = 0; i < 30; i += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        await window.AgentHubCommandTrace.flush();
        if (window.__quoteTraceEvents.some(event => event.commandId === id && event.metadata?.action === "annotation-card"
          && event.outcome === "succeeded")) break;
      }
      return window.__quoteTraceEvents.filter(event => event.commandId === id);
    }, commandId);
    for (const action of ["annotation-pending", "annotation-source", "annotation-draft", "annotation-card"]) {
      assert.ok(clientEvents.some(event => event.metadata?.action === action && event.outcome === "succeeded"), action);
    }
    assert.ok(clientEvents.some(event => event.stage === "client-ack"));
    assert.doesNotMatch(JSON.stringify({ clientEvents, serverEvents }), /native 🦊 fragment|rollout\.jsonl/u);

    await page.evaluate(({ completed, group }) => window.AgentHub.setLive("stream-a", {
      ...completed, id: undefined, turnId: "missing-turn", itemId: null, text: "", activityGroups: [group],
    }), { completed, group });
    await openMenu(live, quote.length);
    await menu.click();
    await page.getByText("Не удалось подтвердить источник выделенного фрагмента.", { exact: true }).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(await card.count(), 1);

    await page.evaluate(() => window.AgentHub.setLive("stream-a", null));
    await openMenu(page.locator('[data-message-id="final-source"] .msg-body'));
    await menu.click();
    await card.nth(1).waitFor();
    assert.equal(await card.nth(1).textContent(), completed.text);
    assert.equal(requests.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-turn steer B cannot replace commentary A before or after SQLite reload", { timeout: 35_000 }, async (t) => {
  const first = start() + user("user-A", "Comment A") + message("answer-A", "commentary", `${marked("Answer A.")}\n\nUntruncated native tail.`);
  let activity = parseCodexRolloutActivity(first);
  const service = observer(async () => activity);
  const initial = await service.read(binding);
  const run = createObservedTaskRun({ ...binding, userMessages: initial.userMessages }, initial); service.applyObserved(run, initial);
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub469-steer-"));
  const filePath = path.join(directory, "tasks.json");
  const nativePath = path.join(directory, "rollout.jsonl");
  const traceApi = createDesktopTaskHistoryFactory({
    selection: { activeProvider: () => "codex", threadId: () => "thread-a", chatId: () => 42 },
    catalog: { entries: () => [{ ...binding, title: "Steer source" }] },
    historyReader: { refresh: async (_binding, { tracePage }) => readCodexTracePageInWorker(nativePath, tracePage) },
  });
  let store = new LocalTaskSyncStore({ filePath });
  const browser = await launchBrowser();
  try {
    for (const width of [1280, 390]) {
      activity = parseCodexRolloutActivity(first);
      const opened = await service.read(binding);
      Object.assign(run, createObservedTaskRun({ ...binding, userMessages: opened.userMessages }, opened)); service.applyObserved(run, opened);
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
      page.setDefaultTimeout(3_000);
      try {
        const errors = await openFixture(page, { fixtureSnapshot: liveSnapshot(run, `A-${width}`), fixtureHistory: historyFor(activity),
          localWeb: true, tracePageReader: params => traceApi(params) });
        await page.evaluate(() => window.AgentHub.showSelectedTask());
        const a = page.locator('[data-chat-live] [data-trace-group-id="commentary:answer-A"] [data-response-citation-index="1"]');
        await a.waitFor(); assert.match(await a.innerText(), /Comment A/u);
        activity = parseCodexRolloutActivity(first + user("user-B", "Comment B")
          + message("answer-B", "commentary", marked("Answer B.")));
        const steered = await service.read(run);
        Object.assign(run, createObservedTaskRun({ ...binding, userMessages: steered.userMessages }, steered)); service.applyObserved(run, steered);
        await applyFixtureSnapshot(page, liveSnapshot(run, `B-${width}`));
        const b = page.locator('[data-chat-live] [data-trace-group-id="commentary:answer-B"] [data-response-citation-index="1"]');
        await b.waitFor();
        assert.match(await a.innerText(), /Comment A/u, "an earlier native item retains its original user entity");
        assert.doesNotMatch(await a.innerText(), /Comment B/u);
        assert.match(await b.innerText(), /Comment B/u);
        await writeFile(nativePath, row("session_meta", { id: "01a0ea85-db2c-7bd3-bfad-2634824c6069" }) + first + row("response_item", { type: "custom_tool_call_output", call_id: "old-call",
          output: "large output ".repeat(350_000) }) + user("user-B", "Comment B")
          + message("answer-B", "commentary", marked("Answer B.")));
        const quoted = await page.evaluate(async () => {
          const events = [];
          window.AgentHubCommandTrace.bindReporter(async batch => { events.push(...batch.events); });
          const surface = document.querySelector('[data-chat-live] [data-trace-group-id="commentary:answer-A"]');
          const range = window.AgentHubMessageDisclosure.domRangeFromOffsets(surface, 0, "Answer A.".length);
          getSelection().removeAllRanges(); getSelection().addRange(range);
          const accepted = await addAnnotation(selectedQuotableSelection());
          for (let i = 0; i < 4 && window.AgentHubCommandTrace.diagnostics().pending; i += 1) await window.AgentHubCommandTrace.flush();
          return { accepted, draft: composerDraftState("stream-a"), events: events.filter(e => e.metadata?.action === "annotation-source"),
            secure: isSecureContext && Boolean(crypto.subtle) };
        });
        assert.equal(quoted.secure, true, "the source/range hashes use native browser SHA-256");
        assert.equal(quoted.accepted, true, `a current-turn exact item can be quoted after steer and large tool output: ${JSON.stringify(quoted.events)}`);
        assert.equal(quoted.draft.annotations[0].source.itemId, "answer-A");
        const validation = quoted.events.find(event => event.outcome === "succeeded");
        assert.ok(validation && Number.isFinite(validation.monotonicDurationMs));
        assert.doesNotMatch(JSON.stringify(quoted.events), /Answer A|Comment A|Comment B/u);
        t.diagnostic(JSON.stringify({ width, commandId: validation.commandId, quoteValidationMs: validation.monotonicDurationMs }));
        const rawGroups = structuredClone(run.activityGroups);
        activity = parseCodexRolloutActivity(first + user("user-B", "Comment B")
          + message("answer-B", "commentary", marked("Answer B."))
          + message("answer-final", "final_answer", marked("Final answer."))
          + row("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: marked("Final answer.") }));
        await store.load();
        const saved = codexRolloutHistory(activity);
        saved[0].activityGroups = saved[0].activityGroups.map(group => group.sourceItemId === "answer-A"
          ? { ...group, reasoning: group.reasoning.split("\n\n")[0] } : group);
        await store.recordHistory({ ...binding, projectRoot: directory }, [...saved, {
          id: "followup-turn", completed: true, status: "completed", prompt: "Recheck A", messages: [{
            role: "user", itemId: "followup-user", text: "Recheck A", responseAnnotations: [{
              text: quoted.draft.annotations[0].quote, annotation: "Quoted live A", source: quoted.draft.annotations[0].source,
            }],
          }],
        }]);
        store.close(); store = new LocalTaskSyncStore({ filePath }); await store.load();
        const before = structuredClone(store.history(binding));
        const api = createDesktopTaskHistoryFactory({
          selection: { activeProvider: () => "codex", threadId: () => "thread-a", chatId: () => 42 },
          catalog: { entries: () => [{ ...binding, title: "Steer history" }] },
          historyReader: { read: async () => ({ history: store.history(binding) }), refresh: async () => ({ groups: rawGroups }) },
          runs: { forTask: () => null }, receipts: { forMessage: () => null, forTurn: () => null },
          historyMerger: { mergeActive: mergeActiveTaskHistory, mergeCompleted: mergeCompletedTaskHistory },
          responseBudget: { fit: value => value },
        });
        const history = await api({ provider: "codex", threadId: "thread-a", includeActive: false });
        const idle = snapshot(); idle.version = `saved-${width}`;
        const cold = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
        cold.setDefaultTimeout(3_000);
        try {
          const coldErrors = await openFixture(cold, { fixtureHistory: history, fixtureSnapshot: idle,
            localWeb: true, tracePageReader: params => traceApi(params) });
          for (const reload of [false, true]) {
            if (reload) await cold.reload({ waitUntil: "load" });
            await cold.evaluate(() => window.AgentHub.showSelectedTask());
            const details = cold.locator("details.turn-trace"); await details.locator("summary").click();
            const savedA = details.locator('[data-trace-group-id="commentary:answer-A"] [data-response-citation-index="1"]');
            await savedA.waitFor(); assert.match(await savedA.innerText(), /Comment A/u);
            assert.doesNotMatch(await savedA.innerText(), /Comment B/u);
            await savedA.focus(); await cold.keyboard.press("Enter");
            await cold.locator(".msg-annotation-content.is-citation-target").waitFor();
            const sourceLink = cold.locator(".msg-annotation-content[data-response-annotation-source]");
            await sourceLink.click();
            const recovered = cold.locator("[data-citation-trace]");
            await recovered.locator(".msg-source-citation-highlight").waitFor();
            assert.equal((await recovered.locator(".msg-source-citation-highlight").allTextContents()).join(""), "Answer A.");
            assert.match(await recovered.innerText(), /Comment A/u);
            assert.doesNotMatch(await recovered.innerText(), /Comment B|Quoted live A/u);
          }
          assert.deepEqual(coldErrors, []);
          if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await cold.screenshot({ path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, `steer-source-${width}.png`) });
        } finally { await cold.close(); }
        assert.deepEqual(store.history(binding), before);
        assert.equal(await page.title(), "Agent Hub"); assert.deepEqual(errors, []);
        if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, `steer-citation-${width}.png`) });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("commentary references do not create a detached empty answer citation", { timeout: 20_000 }, async () => {
  const activity = parseCodexRolloutActivity(start() + user("user-A", "One exact comment")
    + message("first-item", "commentary", marked("First item."))
    + message("second-item", "commentary", marked("Second item.")));
  const service = observer(async () => activity); const initial = await service.read(binding);
  const run = createObservedTaskRun(binding, initial); service.applyObserved(run, initial);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = await openFixture(page, { fixtureSnapshot: liveSnapshot(run, "repeated-links"), fixtureHistory: historyFor(activity) });
    await page.evaluate(() => window.AgentHub.showSelectedTask());
    const card = page.locator("[data-chat-live]");
    await card.locator('[data-trace-group-id="commentary:second-item"]').waitFor();
    assert.equal(await card.locator('[data-response-citation-index="1"]').count(), 2, "distinct native references remain navigable");
    assert.equal((await card.innerText()).split("One exact comment").length - 1, 2, "two genuine native references survive; the empty answer owns none");
    for (const link of await card.locator('[data-response-citation-index="1"]').all()) {
      await link.focus(); await page.keyboard.press("Enter"); await page.locator(".msg-annotation-content.is-citation-target").waitFor();
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("native A survives late completion observation and SQLite history while a new final targets B", { timeout: 30_000 }, async () => {
  const a = { role: "user", itemId: "user-A", clientUserMessageId: "client-A", text: "Check A", responseAnnotations: [{ text: "same", annotation: "Comment A" }] };
  const b = { ...a, itemId: "user-B", clientUserMessageId: "client-B", text: "Check B", responseAnnotations: [{ text: "same", annotation: "Comment B" }] };
  const run = { ...binding, id: "native-run", userMessages: [a], responseItems: [] };
  const rawA = marked("Native answer A.");
  startCodexAgentMessage(run, { turnId, item: { id: "native-A", type: "agentMessage", phase: "commentary" } });
  run.userMessages.push(b);
  const item = completeCodexAgentMessage(run, { turnId, item: { id: "native-A", type: "agentMessage", phase: "commentary", text: rawA } });
  upsertRunReasoningBlock(run, { id: item.id, sourceItemId: item.id, kind: "commentary", text: codexAgentMessageSourceText(item), responseAnnotationTarget: item.responseAnnotationTarget });
  const records = start() + user("user-A", "Comment A") + user("user-B", "Comment B")
    + message("native-A", "commentary", rawA);
  const activity = parseCodexRolloutActivity(records);
  const service = observer(async () => activity);
  const initialHistory = historyFor(activity); initialHistory.items[0].messages = [a, b];
  const browser = await launchBrowser();
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub469-native-observer-"));
  const filePath = path.join(directory, "tasks.json"); let store;
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(3_000);
    const errors = await openFixture(page, { fixtureSnapshot: liveSnapshot(run, "native-before-observation"), fixtureHistory: initialHistory });
    await page.evaluate(() => window.AgentHub.showSelectedTask());
    const aLink = page.locator('[data-chat-live] [data-trace-group-id="commentary:native-A"] [data-response-citation-index="1"]');
    await aLink.waitFor(); assert.match(await aLink.innerText(), /Comment A/u);
    assert.equal(await page.locator('[data-live-body] [data-response-citation-index="1"]').count(), 0,
      "native commentary never creates a second answer citation");
    service.applyObserved(run, await service.read(run));
    await applyFixtureSnapshot(page, liveSnapshot(run, "native-after-observation"));
    assert.match(await aLink.innerText(), /Comment A/u);
    assert.doesNotMatch(await aLink.innerText(), /Comment B/u);
    const finalText = marked("New final B.");
    startCodexAgentMessage(run, { turnId, item: { id: "native-B", type: "agentMessage", phase: "final_answer" } });
    completeCodexAgentMessage(run, { turnId, item: { id: "native-B", type: "agentMessage", phase: "final_answer", text: finalText } });
    await applyFixtureSnapshot(page, liveSnapshot(run, "native-final-B"));
    const bLink = page.locator('[data-live-body] [data-response-citation-index="1"]');
    await bLink.waitFor(); assert.match(await bLink.innerText(), /Comment B/u);
    assert.match(await aLink.innerText(), /Comment A/u);
    store = new LocalTaskSyncStore({ filePath }); await store.load();
    await store.recordHistory({ ...binding, projectRoot: directory }, [{ id: turnId, completed: true, status: "completed", answer: "New final B.",
      activityGroups: run.activityGroups, messages: [a, b, { role: "agent", itemId: "native-B", phase: "final_answer", text: run.responseText,
        responseAnnotationReferences: run.responseAnnotationReferences }] }]);
    store.close(); store = new LocalTaskSyncStore({ filePath }); await store.load();
    const api = createDesktopTaskHistoryFactory({
      selection: { activeProvider: () => "codex", threadId: () => "thread-a", chatId: () => 42 },
      catalog: { entries: () => [{ ...binding, title: "Native history" }] },
      historyReader: { read: async () => ({ history: store.history(binding) }) },
      runs: { forTask: () => null }, receipts: { forMessage: () => null, forTurn: () => null },
      historyMerger: { mergeActive: mergeActiveTaskHistory, mergeCompleted: mergeCompletedTaskHistory }, responseBudget: { fit: value => value },
    });
    const history = await api({ provider: "codex", threadId: "thread-a", includeActive: false });
    const cold = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); cold.setDefaultTimeout(3_000);
    try {
      const coldErrors = await openFixture(cold, { fixtureHistory: history });
      for (const reload of [false, true]) {
        if (reload) await cold.reload({ waitUntil: "load" });
        await cold.evaluate(() => window.AgentHub.showSelectedTask());
        const trace = cold.locator("details.turn-trace"); await trace.locator("summary").click();
        assert.match(await trace.locator('[data-trace-group-id="commentary:native-A"] [data-response-citation-index="1"]').innerText(), /Comment A/u);
        assert.match(await cold.locator('.msg-agent > .msg-body [data-response-citation-index="1"]').last().innerText(), /Comment B/u);
      }
      assert.deepEqual(coldErrors, []);
      if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await cold.screenshot({ path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, "late-native-source-390.png") });
    } finally { await cold.close(); }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});
