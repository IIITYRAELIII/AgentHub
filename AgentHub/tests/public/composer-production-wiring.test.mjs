import assert from "node:assert/strict";
import test from "node:test";
import { DeferredInputController } from "../../src/application/deferred-input-controller.mjs";
import { deferredPendingInputSnapshot } from "../../src/interfaces/desktop/desktop-snapshot.mjs";
import {
  task,
  snapshot,
  persistedRecovery,
  launchBrowser,
  openFixture,
  bridgeCalls,
  applyFixtureSnapshot,
  submit,
  setSelectedTask,
  lateAcceptedReceipt,
  refreshWithReceipt,
  selectMessageText,
  attachTaskReference
} from "./composer-production.fixture.mjs";

test("production Stream header follows saved model while idle and keeps active turn model", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const current = snapshot();
    current.tasks[0].model = "gpt-5.6-sol";
    current.workspaces[0].streams[0].settings = { provider: "codex", model: "gpt-6-sol" };
    current.settings.modelOptionsByProvider.codex = [
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { value: "gpt-6-sol", label: "GPT-6 Sol" },
      { value: "gpt-6-luna", label: "GPT-6 Luna" },
    ];
    await openFixture(page, { fixtureSnapshot: current });
    const header = page.locator("[data-stream-header-model]");
    assert.equal(await header.textContent(), "6 Sol");
    assert.equal(await header.getAttribute("title"), "GPT-6 Sol");
    current.version = "active-model";
    current.tasks[0].running = true;
    current.tasks[0].run = {
      turnId: "active-turn", operationKind: "user-turn", projectionState: "active",
      model: "gpt-5.6-sol",
    };
    current.workspaces[0].streams[0].settings.model = "gpt-6-luna";
    await applyFixtureSnapshot(page, current);
    assert.equal(await header.textContent(), "5.6 Sol");
    current.version = "idle-new-model";
    current.tasks[0].running = false;
    current.tasks[0].run = null;
    await applyFixtureSnapshot(page, current);
    assert.equal(await header.textContent(), "6 Luna");
  } finally { await browser.close(); }
});

test("successful message admission renders the receipt without an acceptance toast", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await openFixture(page);
    await page.evaluate(() => {
      localStorage.setItem("fixture:send-mode", "accept");
      window.__toastHistory.length = 0;
      const run = window.AgentHubMessageSendTransaction.run;
      window.AgentHubMessageSendTransaction.run = async (options) => {
        const result = await run(options);
        window.__finishedSendReceipt = result;
        return result;
      };
    });
    await submit(page, { text: "quiet acceptance" });
    await page.waitForFunction(() => window.__finishedSendReceipt?.accepted === true);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await bridgeCalls(page, "send-message")).length, 1);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
    assert.match(await page.locator("[data-chat-pane]").textContent(), /quiet acceptance/u);
    assert.deepEqual(await page.evaluate(() => window.__toastHistory), []);
  } finally { await browser.close(); }
});

test("cold unbound snapshot cancels before transport and restores the exact submitted draft", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const cold = snapshot();
    cold.tasks = [{ ...cold.tasks[0], streamId: null, workspaceId: null }];
    cold.workspaces = [];
    cold.selected = { ...cold.selected, streamId: null };
    await openFixture(page, { fixtureSnapshot: cold, expectedTaskId: null });
    await page.waitForFunction(() => window.AgentHub?.composerRecoveryDiagnostics?.().restored === true);
    await setSelectedTask(page, "codex:thread-a");
    await submit(page, { text: "123" });
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]").value === "123"
    ), null, { timeout: 5_000 });
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(await page.locator("[data-message-retry-unconfirmed]").count(), 0);
    assert.doesNotMatch(await page.locator("[data-chat-pane]").textContent(), /Статус приёма уточняется|Приём не подтверждён/u);
  } finally {
    await browser.close();
  }
});

test("unconfirmed admission offers explicit same-ID retry without claiming a server queue", {
  timeout: 60_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "disconnect"));
    await submit(page, { text: "123" });
    const retry = page.locator("[data-message-retry-unconfirmed]");
    await retry.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await page.locator(".chat-log [data-message-retry-unconfirmed]").count(), 0);
    assert.match(await retry.locator("..").textContent(), /Приём не подтверждён/u);
    const attempts = await bridgeCalls(page, "send-message");
    assert.equal(attempts.length, 3);
    assert.equal(typeof attempts[0].params.clientUserMessageId, "string");
    assert.ok(attempts[0].params.clientUserMessageId.length > 0);
    assert.equal(attempts[0].params.text, "123");
    assert.equal(new Set(attempts.map((entry) => entry.params.clientUserMessageId)).size, 1);
    const busy = snapshot();
    busy.version = "still-no-receipt-busy";
    busy.tasks[0].running = true;
    busy.tasks[0].model = "different-model";
    busy.selected.model = "different-model";
    busy.tasks[0].run = { operationKind: "user-turn", turnId: "other-turn", status: "running" };
    await applyFixtureSnapshot(page, busy);
    assert.equal((await bridgeCalls(page, "send-message")).length, attempts.length);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await retry.click();
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 4;
    });
    const retried = await bridgeCalls(page, "send-message");
    assert.equal(retried.at(-1).params.clientUserMessageId, attempts[0].params.clientUserMessageId);
    assert.equal(retried.at(-1).params.text, attempts[0].params.text);
    const wire = (entry) => {
      const { clientTiming, ...params } = entry.params;
      return params;
    };
    assert.deepEqual(wire(retried.at(-1)), wire(attempts[0]));
    await retry.waitFor({ state: "detached", timeout: 5_000 });
  } finally {
    await browser.close();
  }
});

test("late exact admission receipt removes the explicit retry without another send", {
  timeout: 60_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "disconnect"));
    await submit(page, { text: "late acknowledgement" });
    const retry = page.locator("[data-message-retry-unconfirmed]");
    await retry.waitFor({ state: "visible", timeout: 5_000 });
    const attempts = await bridgeCalls(page, "send-message");
    assert.ok(attempts[0].params.clientUserMessageId);
    await page.evaluate(() => { window.__staleRetryButton = document.querySelector("[data-message-retry-unconfirmed]"); });
    const receipt = {
      provider: "codex", threadId: "thread-a",
      clientUserMessageId: attempts[0].params.clientUserMessageId,
      accepted: true, conflictKind: "message-intake", clientProjectionIntent: "conversation",
    };
    const ambiguous = snapshot([receipt]);
    ambiguous.version = "ambiguous-unknown-send-receipt";
    ambiguous.tasks[1] = { ...ambiguous.tasks[1], threadId: "thread-a" };
    await applyFixtureSnapshot(page, ambiguous);
    assert.equal(await retry.count(), 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, attempts.length);
    await refreshWithReceipt(page, receipt);
    await retry.waitFor({ state: "detached", timeout: 5_000 }).catch(async (error) => {
      throw new Error(`${error.message} | state=${JSON.stringify(await page.evaluate(() => ({
        log: window.__agentHubFixture.log.map((entry) => entry.action),
        receipts: window.__agentHubFixture.snapshot.messageReceipts,
        queue: document.querySelector("[data-message-retry-unconfirmed]")?.parentElement?.textContent,
      })))}`);
    });
    await page.evaluate(() => window.__staleRetryButton.click());
    assert.equal((await bridgeCalls(page, "send-message")).length, attempts.length);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
  } finally {
    await browser.close();
  }
});

test("late rejection cannot downgrade an exact canonical admission", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "hold-reject"));
    await submit(page, { text: "accepted before transport failure" });
    await page.waitForFunction(() => Boolean(window.__agentHubFixture.heldSend));
    const attempts = await bridgeCalls(page, "send-message");
    const requestId = attempts[0].params.clientUserMessageId;
    await refreshWithReceipt(page, {
      provider: "codex", threadId: "thread-a", clientUserMessageId: requestId,
      accepted: true, conflictKind: "message-intake", clientProjectionIntent: "conversation",
      displayText: "accepted before transport failure",
    });
    await page.waitForFunction(() => document.querySelector(".chat-log")?.textContent.includes("Принято"));
    await page.evaluate(() => window.__rejectHeldSend());
    await page.waitForFunction(() => window.__toastHistory.includes("Введите сообщение"));
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await page.locator("[data-message-retry-unconfirmed]").count(), 0);
    assert.equal((await bridgeCalls(page, "send-message")).length, attempts.length);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await submit(page, { text: "next submission after late rejection" });
    await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => (
      entry.action === "send-message" && entry.params.text === "next submission after late rejection"
    )));
    assert.notEqual((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, requestId);
  } finally {
    await browser.close();
  }
});

for (const { now, expectedTime } of [
  { now: "2026-09-09T16:06:00.000Z", expectedTime: "16:05" },
  { now: "2026-09-10T16:06:00.000Z", expectedTime: "09.09.2026 16:05" },
]) {
  test(`production live clarification keeps its own time and chronological position (${expectedTime})`, {
    timeout: 90_000,
  }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage({ timezoneId: "UTC" });
    // The rendered label includes the date for earlier days. Keep both calendar
    // cases deterministic without pausing the fixture's transport timers.
    await page.clock.setFixedTime(now);
    const initial = snapshot();
    initial.tasks[0] = { ...initial.tasks[0], running: true, run: {
      id: "run-live", turnId: "turn-live", operationKind: "user-turn",
      providerStart: { state: "observed", turnId: "turn-live" },
      clientUserMessageId: "root", prompt: "Root question",
      startedAt: "2026-09-09T15:51:11.165Z", submittedAt: "2026-09-09T15:51:10.190Z",
      userMessages: [
        { role: "user", clientUserMessageId: "root", text: "Root question",
          submittedAt: "2026-09-09T15:51:10.190Z" },
        { role: "user", clientUserMessageId: "middle", text: "Earlier clarification",
          time: "2026-09-09T15:56:59.262Z" },
        { role: "user", clientUserMessageId: "later", text: "Latest clarification" },
      ],
    } };
    try {
      const diagnostics = await openFixture(page, { fixtureSnapshot: initial });
      const next = structuredClone(initial);
      next.version = "clarification-intake-enriched";
      next.tasks[0].run.userMessages[2].submittedAt = "2026-09-09T16:05:45.479Z";
      await applyFixtureSnapshot(page, next);
      const latest = page.locator(".msg").filter({ has: page.locator(".msg-body", { hasText: "Latest clarification" }) });
      await page.waitForFunction((label) => [...document.querySelectorAll(".msg")]
        .some((node) => node.querySelector(".msg-body")?.textContent.includes("Latest clarification")
          && node.querySelector(".msg-time")?.textContent === label), expectedTime);
      assert.equal(await latest.count(), 1);
      const order = await page.locator(".msg-body").allTextContents();
      assert.ok(order.indexOf("Earlier clarification") < order.indexOf("Latest clarification"));
      assert.deepEqual(diagnostics, []);
    } finally {
      await browser.close();
    }
  });
}

test("production queue corrects stale idle placement and survives receipt eviction", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const requestId = "stale-idle-queue";
  const text = "Сообщение ждёт текущий ход";
  const receipt = {
    provider: "codex", threadId: "thread-a", streamId: "stream-a",
    clientUserMessageId: requestId, accepted: false, deferred: true, queued: true,
    clientProjectionIntent: "conversation", displayText: text,
  };
  const queued = snapshot([receipt]);
  queued.version = "stale-idle-queued";
  queued.deferredInputs = [{
    id: "server-queue-entry", ...receipt, text, state: "queued",
    conflictKind: "task-running", createdAt: "2026-09-09T15:51:41.497Z",
  }];
  try {
    const diagnostics = await openFixture(page, { fixtureSnapshot: queued });
    const row = page.locator(".queue-item[data-queue-id='server-queue-entry']");
    await row.waitFor({ state: "visible" });
    assert.match(await row.innerText(), /Сообщение ждёт текущий ход/u);
    assert.equal(await row.locator("[data-action='queue-remove']").count(), 1);
    assert.equal(await page.locator(".msg-body").filter({ hasText: text }).count(), 0);
    const evicted = { ...queued, version: "stale-idle-evicted", messageReceipts: [] };
    await applyFixtureSnapshot(page, evicted);
    await page.reload();
    await row.waitFor({ state: "visible" });
    assert.equal(await page.locator(".msg-body").filter({ hasText: text }).count(), 0);
    if (process.env.AGENT_HUB_QUEUE_SCREENSHOT) {
      await page.screenshot({ path: process.env.AGENT_HUB_QUEUE_SCREENSHOT });
    }
    const accepted = snapshot([{
      ...receipt, accepted: true, deferred: false, queued: false,
      runId: "accepted-run", turnId: "accepted-turn",
    }]);
    accepted.version = "stale-idle-provider-accepted";
    await applyFixtureSnapshot(page, accepted);
    await row.waitFor({ state: "hidden" });
    await page.evaluate(({ requestId, text }) => window.AgentHub.setMessages("stream-a", [{
      id: "provider-item", itemId: "provider-item", clientUserMessageId: requestId,
      provider: "codex", threadId: "thread-a", turnId: "accepted-turn",
      role: "user", text, providerAccepted: true, projectionState: "history",
      time: "2026-09-09T15:55:00.000Z",
    }]), { requestId, text });
    await page.locator(".msg-body").filter({ hasText: text }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".msg-body").filter({ hasText: text }).count(), 1);
    assert.deepEqual(diagnostics, []);
  } finally {
    await browser.close();
  }
});

test("attention-required exact steer exposes explicit retry and queue decisions", {
  timeout: 90_000,
}, async () => {
  const pendingInputs = new Map();
  const queuedInputs = new Map();
  const item = {
    id: "exact-steer-decision",
    provider: "codex",
    threadId: "thread-a",
    streamId: "stream-a",
    taskTitle: "Agent HUB - Sirius",
    clientUserMessageId: "exact-steer-client",
    clientProjectionIntent: "conversation",
    input: "Exact steer retained",
    conflictKind: "message-steer",
    steerTargetRunId: "run-a",
    steerTargetTurnId: "turn-a",
    createdAt: "2026-09-13T22:00:00.000Z",
  };
  queuedInputs.set(item.id, item);
  let providerCalls = 0;
  const controller = new DeferredInputController({
    pendingInputs,
    queuedInputs,
    isBlocked: async () => false,
    occupancy: async () => ({ occupied: false, run: null }),
    steer: async () => { providerCalls += 1; return null; },
    start: async () => {},
    persist: async () => {},
    updateMessage: async () => {},
    pendingKeyboard: () => ({ inline_keyboard: [] }),
    notifyReturned: async () => {},
    now: () => Date.parse("2026-09-13T22:00:01.000Z"),
  });
  await controller.process(item.id);
  assert.equal(providerCalls, 0);
  const deferred = deferredPendingInputSnapshot(pendingInputs.get(item.id), {
    editableText: (input) => input,
    inputPreview: (input) => input,
    responseAnnotations: () => [],
    describeAttachments: () => [],
  }, { forMessage: () => null });
  assert.equal(deferred.queueAfterTurnAvailable, true);
  assert.equal(deferred.attentionRequired, true);

  for (const [selector, expectedAction] of [
    ["queue-retry", "retry"],
    ["queue-accept", "queue"],
  ]) {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    try {
      const fixtureSnapshot = snapshot();
      fixtureSnapshot.version = `exact-steer-${expectedAction}`;
      fixtureSnapshot.deferredInputs = [deferred];
      await openFixture(page, { fixtureSnapshot });
      await page.reload();
      const row = page.locator(".queue-item[data-queue-id='exact-steer-decision']");
      await row.waitFor({ state: "visible" });
      assert.equal(await row.locator("[data-action='queue-retry']").count(), 1);
      assert.equal(await row.locator("[data-action='queue-accept']").count(), 1);
      assert.equal(await row.locator("[data-action='queue-steer']").count(), 0);
      assert.equal((await bridgeCalls(page, "deferred-input")).length, 0);
      await row.locator(`[data-action='${selector}']`).click();
      await page.waitForFunction((action) => {
        const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
        return log.some((entry) => entry.action === "deferred-input"
          && entry.params.id === "exact-steer-decision"
          && entry.params.action === action);
      }, expectedAction);
      const calls = await bridgeCalls(page, "deferred-input");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].params.id, "exact-steer-decision");
      assert.equal(calls[0].params.action, expectedAction);
    } finally {
      await browser.close();
    }
  }

  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const fixtureSnapshot = snapshot();
    fixtureSnapshot.version = "exact-steer-unknown";
    fixtureSnapshot.deferredInputs = [{
      ...deferred,
      queueAfterTurnAvailable: false,
      lastError: "Провайдер не подтвердил уточнение; автоматический повтор не выполнялся.",
    }];
    await openFixture(page, { fixtureSnapshot });
    const row = page.locator(".queue-item[data-queue-id='exact-steer-decision']");
    await row.waitFor({ state: "visible" });
    assert.equal(await row.locator("[data-action='queue-retry']").count(), 1);
    assert.equal(await row.locator("[data-action='queue-accept']").count(), 0);
    assert.equal(await row.locator("[data-action='queue-steer']").count(), 0);
    assert.equal((await bridgeCalls(page, "deferred-input")).length, 0);
  } finally {
    await browser.close();
  }
});

test("production startup restores recovery before applying accepted snapshot evidence", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const requestId = "startup-accepted-recovery";
  const acceptedSnapshot = snapshot([{
    provider: "codex",
    threadId: "thread-a",
    clientUserMessageId: requestId,
    accepted: true,
    deferred: true,
    conflictKind: "message-intake",
    clientProjectionIntent: "queue",
  }]);
  try {
    const diagnostics = await openFixture(page, {
      persistedDrafts: [persistedRecovery({
        requestId,
        text: "stale accepted payload",
      })],
      fixtureSnapshot: acceptedSnapshot,
      expectedTaskId: "",
      holdRecoveryAuthority: true,
    });
    await page.waitForFunction(() => typeof window.__releaseComposerRecoveryAuthority === "function");
    assert.equal((await bridgeCalls(page, "snapshot")).length, 0);

    await page.evaluate(() => window.__releaseComposerRecoveryAuthority());
    await page.waitForFunction(() => (
      window.AgentHub?.composerRecoveryDiagnostics?.().restored === true
      && document.querySelector("[data-stream-task-id='stream-a']")
    ));
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "");
    const persistedAfterAcceptance = await page.evaluate(() => (
      localStorage.getItem("agent-hub:composer-drafts:v1:vscode")
    ));
    assert.equal(persistedAfterAcceptance, null);

    await page.locator("[data-composer-input]").fill("new input after startup reconciliation");
    await refreshWithReceipt(page, acceptedSnapshot.messageReceipts[0]);
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value
        === "new input after startup reconciliation"
    ));
    assert.deepEqual(diagnostics, []);
  } finally {
    await browser.close();
  }
});

test("production index/app/hub-client preserves exact mixed-attachment retry across reload", { timeout: 15000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openFixture(page);
    await submit(page, {
      text: "Сохрани exact retry",
      attachment: { name: "screen.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) },
    });
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "Сохрани exact retry"
      && document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1
    ), null, { timeout: 5000 });
    const firstSend = (await bridgeCalls(page, "send-message")).at(-1);
    const firstUpload = (await bridgeCalls(page, "upload-attachment")).at(-1);
    assert.ok(firstSend?.params?.clientUserMessageId);
    assert.equal(firstUpload.params.size, 3);
    const persisted = await page.evaluate(() => JSON.parse(
      localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]",
    ));
    assert.equal(persisted[0].recoveryRequestId, firstSend.params.clientUserMessageId);
    assert.equal(persisted[0].attachments[0].dataUrl, undefined);
    assert.equal(persisted[0].attachments[0].blobId, persisted[0].attachments[0].uploadId);
    assert.equal(persisted[0].attachments[0].chunkHashes.length, 1);
    assert.equal(JSON.stringify(persisted).includes("fixture-upload"), false);

    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "Сохрани exact retry"
      && document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1
    ), null, { timeout: 5000 });
    assert.equal((await bridgeCalls(page, "send-message")).length, 1);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    const sends = await bridgeCalls(page, "send-message");
    const uploads = await bridgeCalls(page, "upload-attachment");
    assert.equal(sends[1].params.clientUserMessageId, sends[0].params.clientUserMessageId);
    assert.equal(uploads.length, 2);
    assert.notEqual(sends[1].params.attachments[0], sends[0].params.attachments[0]);
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally {
    await browser.close();
  }
});

test("production reload invalidates retry identity after a real user edit", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, { text: "Сохрани ID до edit" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Сохрани ID до edit");
    const firstRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Сохрани ID до edit");
    await page.locator("[data-composer-input]").fill("временная правка");
    await page.locator("[data-composer-input]").fill("Сохрани ID до edit");
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    const secondRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    assert.notEqual(secondRequestId, firstRequestId);
  } finally {
    await browser.close();
  }
});

test("production wiring keeps attachment-only recovery and Task-scoped late evidence", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, {
      attachment: { name: "only.png", mimeType: "image/png", buffer: Buffer.from([4, 5, 6]) },
    });
    await page.waitForFunction(() => document.querySelectorAll(
      "[data-attachments] [data-attachment-index]",
    ).length === 1);
    const attachmentRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelectorAll(
      "[data-attachments] [data-attachment-index]",
    ).length === 1);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");

    await page.evaluate(() => {
      localStorage.removeItem("agent-hub:composer-drafts:v1:vscode");
      localStorage.setItem("fixture:bridge-log", "[]");
    });
    await page.reload({ waitUntil: "load" });
    await submit(page, { text: "одинаково" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "одинаково");
    const firstRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await setSelectedTask(page, "stream-b");
    await submit(page, { text: "одинаково" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "одинаково");
    const secondRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    assert.notEqual(firstRequestId, secondRequestId);

    await page.evaluate(({ receipt, nextSnapshot }) => {
      const fixture = window.__agentHubFixture;
      fixture.snapshot = { ...nextSnapshot, messageReceipts: [receipt], version: "fixture-late" };
      localStorage.setItem("fixture:snapshot", JSON.stringify(fixture.snapshot));
      document.querySelector("[data-provider-connection-retry]")?.click();
    }, {
      receipt: {
        provider: "codex", threadId: "thread-a", streamId: "stream-a",
        clientUserMessageId: firstRequestId, accepted: true,
        conflictKind: "message-intake", clientProjectionIntent: "conversation",
      },
      nextSnapshot: snapshot(),
    });
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "snapshot").length >= 2;
    });
    await setSelectedTask(page, "stream-b");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "одинаково");
    await setSelectedTask(page, "stream-a");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
    assert.ok(attachmentRequestId);
  } finally {
    await browser.close();
  }
});

test("production Task-reference add and remove invalidate old recovery before late acceptance", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const addPage = await browser.newPage();
    await openFixture(addPage);
    await submit(addPage, { text: "reference add survives" });
    await addPage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "reference add survives");
    const addRequestId = (await bridgeCalls(addPage, "send-message")).at(-1).params.clientUserMessageId;
    await attachTaskReference(addPage);
    await lateAcceptedReceipt(addPage, addRequestId);
    assert.equal(await addPage.locator("[data-composer-input]").inputValue(), "reference add survives");
    assert.equal(await addPage.locator("[data-attachments] .attachment-task-reference").count(), 1);
    await addPage.close();

    const removePage = await browser.newPage();
    await openFixture(removePage);
    await removePage.locator("[data-composer-input]").fill("reference remove survives");
    await attachTaskReference(removePage, { taskId: "board-task-2", taskNumber: "HUB-REMOVE" });
    await removePage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await removePage.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "reference remove survives"
      && document.querySelectorAll("[data-task-reference-index]").length === 1
    ));
    const removeRequestId = (await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId;
    await removePage.locator("[data-task-reference-index]").click();
    await lateAcceptedReceipt(removePage, removeRequestId);
    assert.equal(await removePage.locator("[data-composer-input]").inputValue(), "reference remove survives");
    assert.equal(await removePage.locator("[data-attachments] .attachment-task-reference").count(), 0);
    await removePage.close();
  } finally {
    await browser.close();
  }
});

test("production attachment add and remove invalidate old recovery before late acceptance", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const addPage = await browser.newPage();
    await openFixture(addPage);
    await submit(addPage, { text: "attachment add survives" });
    await addPage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "attachment add survives");
    const addRequestId = (await bridgeCalls(addPage, "send-message")).at(-1).params.clientUserMessageId;
    await addPage.evaluate(() => {
      const original = window.AgentHubComposerFiles;
      window.AgentHubComposerFiles = { ...original, prepare: (file, metadata) => new Promise((resolve, reject) => {
        window.__heldFileRead = { file, metadata, resolve, reject };
      }) };
      window.__releaseFileRead = () => {
        const held = window.__heldFileRead;
        window.AgentHubComposerFiles = original;
        original.prepare(held.file, held.metadata).then(held.resolve, held.reject);
      };
    });
    await addPage.locator("[data-file-input]").setInputFiles({
      name: "new.png", mimeType: "image/png", buffer: Buffer.from([11, 12, 13]),
    });
    await addPage.waitForFunction(() => Boolean(window.__heldFileRead));
    await setSelectedTask(addPage, "stream-b");
    await lateAcceptedReceipt(addPage, addRequestId);
    await setSelectedTask(addPage, "stream-b");
    await addPage.evaluate(() => window.__releaseFileRead());
    await addPage.waitForTimeout(50);
    assert.equal(await addPage.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await addPage.locator("[data-attachment-index]").count(), 0);
    await setSelectedTask(addPage, "stream-a");
    await addPage.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    // The receipt cleared the accepted text while the new file was preparing.
    // Appending the new file must not resurrect the old submitted draft.
    assert.equal(await addPage.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await addPage.locator("[data-attachment-index]").count(), 1);
    await addPage.close();

    const removePage = await browser.newPage();
    await openFixture(removePage);
    await submit(removePage, {
      text: "attachment remove survives",
      attachment: { name: "old.png", mimeType: "image/png", buffer: Buffer.from([21, 22, 23]) },
    });
    await removePage.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "attachment remove survives"
      && document.querySelectorAll("[data-attachment-index]").length === 1
    ));
    const removeRequestId = (await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId;
    await removePage.locator("[data-attachment-index]").click();
    await lateAcceptedReceipt(removePage, removeRequestId);
    assert.equal(await removePage.locator("[data-composer-input]").inputValue(), "attachment remove survives");
    assert.equal(await removePage.locator("[data-attachment-index]").count(), 0);
    await removePage.close();
  } finally {
    await browser.close();
  }
});

test("production annotation edit and remove invalidate old recovery before late acceptance", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const editPage = await browser.newPage();
    await openFixture(editPage, {
      persistedDrafts: [{
        taskId: "stream-a",
        text: "annotation edit survives",
        taskReferences: [],
        annotations: [{ quote: "Alpha", annotation: "old comment" }],
      }],
    });
    await editPage.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    await editPage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await editPage.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    const editRequestId = (await bridgeCalls(editPage, "send-message")).at(-1).params.clientUserMessageId;
    await editPage.locator("[data-annotation-comment-index='0']").fill("new comment");
    await lateAcceptedReceipt(editPage, editRequestId);
    assert.equal(await editPage.locator("[data-composer-input]").inputValue(), "annotation edit survives");
    assert.equal(await editPage.locator("[data-annotation-comment-index='0']").inputValue(), "new comment");
    await editPage.close();

    const removePage = await browser.newPage();
    await openFixture(removePage, {
      persistedDrafts: [{
        taskId: "stream-a",
        text: "annotation remove survives",
        taskReferences: [],
        annotations: [{ quote: "Bravo", annotation: "remove me" }],
      }],
    });
    await removePage.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    await removePage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await removePage.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    const removeRequestId = (await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId;
    await removePage.locator("[data-annotation-index='0']").click();
    await lateAcceptedReceipt(removePage, removeRequestId);
    assert.equal(await removePage.locator("[data-composer-input]").inputValue(), "annotation remove survives");
    assert.equal(await removePage.locator("[data-annotations] .annotation").count(), 0);
    await removePage.close();
  } finally {
    await browser.close();
  }
});

test("production edit revisions fence a late rejected send and programmatic composer edits", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const rejectPage = await browser.newPage();
    await openFixture(rejectPage);
    await rejectPage.evaluate(() => localStorage.setItem("fixture:send-mode", "hold-reject"));
    await submit(rejectPage, { text: "old held payload" });
    await rejectPage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.some((entry) => entry.action === "send-message");
    });
    const oldRequestId = (await bridgeCalls(rejectPage, "send-message")).at(-1).params.clientUserMessageId;
    await rejectPage.locator("[data-composer-input]").fill("new user composition");
    await rejectPage.evaluate(() => window.__rejectHeldSend());
    await rejectPage.waitForFunction(() => !document.querySelector("[data-composer-send]")?.disabled);
    assert.equal(await rejectPage.locator("[data-composer-input]").inputValue(), "new user composition");
    await rejectPage.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await rejectPage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await rejectPage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    const newRequestId = (await bridgeCalls(rejectPage, "send-message")).at(-1).params.clientUserMessageId;
    assert.notEqual(newRequestId, oldRequestId);
    await rejectPage.close();

    const editPage = await browser.newPage();
    await openFixture(editPage);
    await submit(editPage, { text: "recovered before edit button" });
    await editPage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "recovered before edit button");
    const acceptedRequestId = (await bridgeCalls(editPage, "send-message")).at(-1).params.clientUserMessageId;
    await editPage.evaluate(() => window.AgentHub.setMessages("stream-a", [{
      id: "user-edit-source", itemId: "user-edit-source", role: "user",
      text: "programmatic replacement", time: "2026-09-04T08:00:02.000Z",
    }]));
    await editPage.locator("[data-message-edit]").evaluate((button) => button.click());
    await lateAcceptedReceipt(editPage, acceptedRequestId);
    assert.equal(await editPage.locator("[data-composer-input]").inputValue(), "programmatic replacement");
    await editPage.close();

    const slashPage = await browser.newPage();
    await openFixture(slashPage);
    await submit(slashPage, {
      attachment: { name: "slash.png", mimeType: "image/png", buffer: Buffer.from([31, 32, 33]) },
    });
    await slashPage.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    const slashRequestId = (await bridgeCalls(slashPage, "send-message")).at(-1).params.clientUserMessageId;
    await slashPage.locator("[data-action='slash-menu']").click();
    await lateAcceptedReceipt(slashPage, slashRequestId);
    assert.equal(await slashPage.locator("[data-composer-input]").inputValue(), "/");
    assert.equal(await slashPage.locator("[data-attachment-index]").count(), 1);
    await slashPage.close();
  } finally {
    await browser.close();
  }
});

test("production over-limit recovery stays exact in memory and blocks managed reload", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    const text = "x".repeat(100_001);
    await submit(page, { text });
    await page.waitForFunction((length) => (
      document.querySelector("[data-composer-input]")?.value.length === length
    ), text.length);
    assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
      message.includes("не может точно сохранить")
    ))), true);
    const firstRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    const persisted = await page.evaluate(() => JSON.parse(
      localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]",
    ));
    assert.equal(persisted[0].text.length, 100_000);
    assert.equal("recoveryRequestId" in persisted[0], false);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    assert.equal((await page.locator("[data-composer-input]").inputValue()).length, 100_001);

    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    const secondRequestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    assert.equal(secondRequestId, firstRequestId);
  } finally {
    await browser.close();
  }
});

test("production attachment recovery blocks managed reload when the attachment store cannot open", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    // Size alone no longer decides durability: ordinary files are kept as Blobs
    // since the chunked upload change. Here the attachment database fails to
    // open, and the product treats that as a non-durable attachment.
    await openFixture(page, { attachmentStorageOpenFailure: true });
    await page.locator("[data-file-input]").setInputFiles({
      name: "screenshot.png", mimeType: "image/png", buffer: Buffer.from("screenshot-bytes"),
    });
    await page.locator("[data-attachment-index]").waitFor();
    assert.equal(await page.locator("[data-attachment-storage-warning]").count(), 0);
    assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
      /Вложение добавлено|Копия черновика не сохранена|локальное хранилище/iu.test(message)
    ))), false);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    // Remove this draft before exercising the existing rejected-send recovery.
    await page.locator("[data-attachments] .attachment-remove").click();
    await submit(page, {
      text: "large attachment",
      attachment: {
        name: "large.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(3_000_100, 65),
      },
    });
    await page.waitForFunction(() => (
      document.querySelector("[data-composer-input]")?.value === "large attachment"
      && document.querySelectorAll("[data-attachment-index]").length === 1
    ));
    assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
      message.includes("не может точно сохранить")
    ))), true);
    const persisted = await page.evaluate(() => JSON.parse(
      localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]",
    ));
    assert.equal("recoveryRequestId" in persisted[0], false);
    assert.equal(persisted[0].text, "large attachment");
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    assert.equal(await page.locator("[data-attachment-index]").count(), 1);
  } finally {
    await browser.close();
  }
});

test("production quota failure is explicit and leaves no partial reload identity", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      const originalRemove = Storage.prototype.removeItem;
      window.__restoreDraftStorage = () => {
        Storage.prototype.setItem = original;
        Storage.prototype.removeItem = originalRemove;
      };
      Storage.prototype.setItem = function setItem(key, value) {
        if (String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
      Storage.prototype.removeItem = function removeItem(key) {
        if (String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("privacy", "SecurityError");
        }
        return originalRemove.call(this, key);
      };
    });
    await submit(page, {
      attachment: { name: "quota.png", mimeType: "image/png", buffer: Buffer.from([7, 8, 9]) },
    });
    await page.waitForFunction(() => window.__toastHistory.some((message) => (
      message.includes("не может точно сохранить")
    )));
    const persisted = await page.evaluate(() => {
      window.__restoreDraftStorage();
      return localStorage.getItem("agent-hub:composer-drafts:v1:vscode");
    });
    assert.equal(persisted, null);
    assert.equal(await page.locator("[data-attachments] [data-attachment-index]").count(), 1);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
  } finally {
    await browser.close();
  }
});

test("production receipt without streamId completes only one exact provider Thread Task", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, { text: "receipt-owned-by-a" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "receipt-owned-by-a");
    const requestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    const base = {
      clientUserMessageId: requestId,
      accepted: true,
      conflictKind: "message-intake",
      clientProjectionIntent: "conversation",
    };
    for (const identity of [
      { provider: "codex", threadId: "thread-b" },
      { provider: "claude", threadId: "thread-a" },
    ]) {
      await refreshWithReceipt(page, { ...base, ...identity });
      await setSelectedTask(page, "stream-a");
      assert.equal(await page.locator("[data-composer-input]").inputValue(), "receipt-owned-by-a");
    }

    const ambiguous = snapshot();
    ambiguous.version = "fixture-receipt-ambiguous-provider-thread";
    ambiguous.tasks[1] = { ...ambiguous.tasks[1], provider: "codex", threadId: "thread-a" };
    ambiguous.messageReceipts = [{ ...base, provider: "codex", threadId: "thread-a" }];
    await applyFixtureSnapshot(page, ambiguous);
    await setSelectedTask(page, "stream-a");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "receipt-owned-by-a");

    await refreshWithReceipt(page, {
      ...base,
      provider: "codex",
      threadId: "thread-a",
    });
    await setSelectedTask(page, "stream-a");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
  } finally {
    await browser.close();
  }
});

test("production send waits for a held Blob preparation without losing the selected file", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      const original = window.AgentHubComposerFiles;
      window.AgentHubComposerFiles = { ...original, prepare: (file, metadata) => new Promise((resolve, reject) => {
        window.__heldSendRead = { file, metadata, resolve, reject };
      }) };
      window.__releaseSendRead = () => {
        const held = window.__heldSendRead;
        window.AgentHubComposerFiles = original;
        original.prepare(held.file, held.metadata).then(held.resolve, held.reject);
      };
      localStorage.setItem("fixture:send-mode", "accept");
    });
    await page.locator("[data-composer-input]").fill("accepted while file read is pending");
    await page.locator("[data-file-input]").setInputFiles({
      name: "late.png", mimeType: "image/png", buffer: Buffer.from([31, 32, 33]),
    });
    await page.waitForFunction(() => Boolean(window.__heldSendRead));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "accepted while file read is pending");
    await page.evaluate(() => window.__releaseSendRead());
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
      .some((entry) => entry.action === "send-message"));
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await page.locator("[data-attachment-index]").count(), 0);
    assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.text, "accepted while file read is pending");
    assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.attachments.length, 1);
  } finally {
    await browser.close();
  }
});

test("production attachment reads append independently and remain Task generation-fenced", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const overlap = await browser.newPage();
    await openFixture(overlap);
    await overlap.evaluate(() => {
      const original = window.AgentHubComposerFiles;
      window.__heldReads = [];
      window.AgentHubComposerFiles = { ...original, prepare: (file, metadata) => new Promise((resolve, reject) => {
        window.__heldReads.push({ file, metadata, resolve, reject });
      }) };
      window.__releaseRead = (index) => {
        const held = window.__heldReads[index];
        original.prepare(held.file, held.metadata).then(held.resolve, held.reject);
      };
    });
    await overlap.locator("[data-file-input]").setInputFiles({
      name: "first.png", mimeType: "image/png", buffer: Buffer.from([1]),
    });
    await overlap.locator("[data-file-input]").setInputFiles({
      name: "second.png", mimeType: "image/png", buffer: Buffer.from([2]),
    });
    await overlap.waitForFunction(() => window.__heldReads?.length === 2);
    await overlap.locator("[data-composer-input]").fill("Text typed while both screenshots are being prepared");
    await overlap.evaluate(() => window.__releaseRead(1));
    await overlap.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    await overlap.evaluate(() => window.__releaseRead(0));
    await overlap.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 2, null, { timeout: 3000 });
    assert.equal(await overlap.locator("[data-composer-input]").inputValue(), "Text typed while both screenshots are being prepared");
    assert.equal(await overlap.locator("[data-attachment-index]").count(), 2);
    assert.equal(await overlap.locator("[data-attachments] img[alt='first.png']").count(), 1);
    assert.equal(await overlap.locator("[data-attachments] img[alt='second.png']").count(), 1);
    await overlap.close();

    const removed = await browser.newPage();
    await openFixture(removed);
    await removed.evaluate(() => {
      const original = window.AgentHubComposerFiles;
      window.AgentHubComposerFiles = { ...original, prepare: (file, metadata) => new Promise((resolve, reject) => {
        window.__removedTaskRead = { file, metadata, resolve, reject };
      }) };
      window.__releaseRemovedTaskRead = () => {
        const held = window.__removedTaskRead;
        original.prepare(held.file, held.metadata).then(held.resolve, held.reject);
      };
    });
    await removed.locator("[data-file-input]").setInputFiles({
      name: "stale.png", mimeType: "image/png", buffer: Buffer.from([3]),
    });
    await removed.waitForFunction(() => Boolean(window.__removedTaskRead));
    const beforeRemoval = (await bridgeCalls(removed, "snapshot")).length;
    await removed.evaluate(() => {
      const fixture = window.__agentHubFixture;
      fixture.snapshot = {
        ...fixture.snapshot,
        tasks: fixture.snapshot.tasks
          .filter((candidate) => candidate.streamId !== "stream-a")
          .map((candidate) => ({ ...candidate, selected: true })),
        version: "fixture-a-removed",
      };
      localStorage.setItem("fixture:snapshot", JSON.stringify(fixture.snapshot));
      document.querySelector("[data-provider-connection-retry]")?.click();
    });
    await removed.waitForFunction((minimum) => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "snapshot").length > minimum;
    }, beforeRemoval);
    await removed.evaluate(() => window.__releaseRemovedTaskRead());
    await removed.waitForTimeout(50);
    const beforeRestore = (await bridgeCalls(removed, "snapshot")).length;
    await removed.evaluate((nextSnapshot) => {
      window.__agentHubFixture.snapshot = nextSnapshot;
      localStorage.setItem("fixture:snapshot", JSON.stringify(nextSnapshot));
      document.querySelector("[data-provider-connection-retry]")?.click();
    }, snapshot());
    await removed.waitForFunction((minimum) => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "snapshot").length > minimum;
    }, beforeRestore);
    await setSelectedTask(removed, "stream-a");
    assert.equal(await removed.locator("[data-attachment-index]").count(), 0);
    await removed.close();
  } finally {
    await browser.close();
  }
});

test("production screenshot paste stays local while network capability negotiation is unavailable", {
  timeout: 30_000,
}, async (context) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      window.__capabilityCalls = 0;
      window.AgentHubAttachmentCapabilities = () => {
        window.__capabilityCalls += 1;
        return new Promise(() => {});
      };
      const input = document.querySelector("[data-composer-input]");
      window.__pasteStartedAt = performance.now();
      const observer = new MutationObserver(() => {
        if (document.querySelectorAll("[data-attachment-index]").length !== 5) return;
        window.__pasteElapsedMs = performance.now() - window.__pasteStartedAt;
        observer.disconnect();
      });
      observer.observe(document.querySelector("[data-attachments]"), { childList: true, subtree: true });
      for (let index = 0; index < 5; index += 1) {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(256 * 1024).fill(index + 1)], `screen-${index}.png`, { type: "image/png" }));
        input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      }
      input.value = "Keep this newly typed text";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 5, null, { timeout: 3000 });
    context.diagnostic(`Five 256 KiB clipboard files visible in ${Math.round(await page.evaluate(() => window.__pasteElapsedMs))} ms; no network capability request`);
    assert.equal(await page.evaluate(() => window.__capabilityCalls), 0);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "Keep this newly typed text");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 5);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "Keep this newly typed text");
  } finally {
    await browser.close();
  }
});

test("production negotiated batch refusal restores the exact draft before any upload or message", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page, { chunkedUpload: true });
    const requests = [];
    await page.route("**/api/attachment-upload**", async (route) => {
      requests.push(route.request().method());
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        protocol: "agent-hub-attachment-upload-v1", chunkBytes: 1024 * 1024, maxBytes: 3, maxTotalBytes: 3,
      }) });
    });
    await page.locator("[data-composer-input]").fill("Keep text and both screenshots");
    await page.locator("[data-file-input]").setInputFiles([
      { name: "quota-a.png", mimeType: "image/png", buffer: Buffer.from([1, 2]) },
      { name: "quota-b.png", mimeType: "image/png", buffer: Buffer.from([3, 4]) },
    ]);
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 2);
    const readDraft = () => page.evaluate(() => JSON.parse(localStorage.getItem("agent-hub:composer-drafts:v1:vscode"))[0]);
    const before = await readDraft();
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Keep text and both screenshots"
      && JSON.parse(localStorage.getItem("agent-hub:composer-drafts:v1:vscode"))[0]?.recoveryRequestId);
    const rejected = await readDraft();
    assert.ok(rejected.recoveryRequestId);
    assert.deepEqual(rejected.attachments.map((file) => file.uploadId), before.attachments.map((file) => file.uploadId));
    assert.deepEqual(requests, ["GET"]);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Keep text and both screenshots");
    assert.equal((await readDraft()).recoveryRequestId, rejected.recoveryRequestId);
    assert.deepEqual(requests, ["GET"]);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
  } finally {
    await browser.close();
  }
});

test("production cancelling held capability negotiation restores the unsent attachment draft", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  let heldRoute;
  try {
    await openFixture(page, { chunkedUpload: true });
    const requests = [];
    await page.route("**/api/attachment-upload**", (route) => {
      requests.push(route.request().method());
      heldRoute = route;
    });
    await page.locator("[data-composer-input]").fill("Cancel this preparation");
    await page.locator("[data-file-input]").setInputFiles({ name: "cancel.png", mimeType: "image/png", buffer: Buffer.from([1]) });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    const capabilityStarted = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/attachment-upload");
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await capabilityStarted;
    await page.locator("[data-upload-cancel]").click({ timeout: 3000 });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Cancel this preparation"
      && document.querySelectorAll("[data-attachment-index]").length === 1, null, { timeout: 3000 });
    assert.deepEqual(requests, ["GET"]);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(await page.locator("[data-upload-cancel]").count(), 0);
  } finally {
    await heldRoute?.abort().catch(() => {});
    await browser.close();
  }
});

test("production concurrent pastes enforce the final count and preserve explicit removal", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      const original = window.AgentHubComposerFiles;
      window.__pasteReads = [];
      window.AgentHubComposerFiles = { ...original, prepare: (file, metadata) => new Promise((resolve, reject) => {
        window.__pasteReads.push(() => original.prepare(file, metadata).then(resolve, reject));
      }) };
      window.__releasePastes = () => Promise.all(window.__pasteReads.splice(0).map((release) => release()));
      window.__pasteScreenshots = (count) => {
        const input = document.querySelector("[data-composer-input]");
        for (let index = 0; index < count; index += 1) {
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array([index + 1])], `screen-${index}.png`, { type: "image/png" }));
          input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
        }
      };
      window.__pasteScreenshots(9);
    });
    await page.waitForFunction(() => window.__pasteReads.length === 8);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    await page.evaluate(() => window.__releasePastes());
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 8);
    await page.locator("[data-attachment-index]").first().click();
    await page.evaluate(() => window.__pasteScreenshots(1));
    await page.waitForFunction(() => window.__pasteReads.length === 1);
    await page.locator("[data-attachment-index]").first().click();
    await page.evaluate(() => window.__releasePastes());
    assert.equal(await page.locator("[data-attachment-index]").count(), 6);
  } finally {
    await browser.close();
  }
});

test("production pending screenshot cannot survive composer clear or Thread rebinding", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    for (const boundary of ["clear", "rebind"]) {
      const page = await browser.newPage();
      await openFixture(page);
      await page.locator("[data-composer-input]").fill("old draft");
      await page.evaluate(() => {
        const original = window.AgentHubComposerFiles;
        window.AgentHubComposerFiles = { ...original, prepare: (file, metadata) => new Promise((resolve, reject) => {
          window.__releasePendingPaste = () => original.prepare(file, metadata).then(resolve, reject);
        }) };
      });
      await page.locator("[data-file-input]").setInputFiles({ name: "late.png", mimeType: "image/png", buffer: Buffer.from([1]) });
      await page.waitForFunction(() => Boolean(window.__releasePendingPaste));
      if (boundary === "clear") await page.locator("[data-composer-input]").fill("");
      else {
        const next = snapshot();
        next.version = "new-thread-binding";
        next.tasks[0].threadId = "thread-rebound";
        next.workspaces[0].streams[0].threads = [{ id: "thread-rebound" }];
        next.selected.threadId = "thread-rebound";
        await applyFixtureSnapshot(page, next);
      }
      await page.evaluate(() => window.__releasePendingPaste());
      assert.equal(await page.locator("[data-attachment-index]").count(), 0, boundary);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("production refused attachment selections preserve the exact retry identity", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const scenarios = [
      async (page) => page.evaluate(() => {
        const file = new File([new Uint8Array([1])], "too-large.bin", { type: "application/octet-stream" });
        // Local preparation has its own 256 MiB limit; the negotiated upload
        // limit is validated on send, without holding the clipboard event.
        Object.defineProperty(file, "size", { value: 256 * 1024 * 1024 + 1 });
        const input = document.querySelector("[data-file-input]");
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }),
      async (page) => page.locator("[data-file-input]").setInputFiles({
        name: "empty.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(0),
      }),
    ];
    for (const refuse of scenarios) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await openFixture(page);
      await submit(page, { text: "retry-after-refusal" });
      await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "retry-after-refusal");
      const firstId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
      await refuse(page);
      await page.waitForTimeout(50);
      await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
      await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
      await page.waitForFunction(() => {
        const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
        return log.filter((entry) => entry.action === "send-message").length === 2;
      });
      assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, firstId);
      await context.close();
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    await openFixture(page);
    const eight = Array.from({ length: 8 }, (_, index) => ({
      name: `full-${index}.bin`, mimeType: "application/octet-stream", buffer: Buffer.from([index + 1]),
    }));
    await page.locator("[data-file-input]").setInputFiles(eight);
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 8);
    await page.locator("[data-composer-input]").fill("retry-at-zero-room");
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 8);
    const firstId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.locator("[data-file-input]").setInputFiles({
      name: "ninth.bin", mimeType: "application/octet-stream", buffer: Buffer.from([9]),
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, firstId);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("production persisted attachment recovery rejects non-canonical bytes and metadata", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const valid = { name: "safe.png", type: "image/png", size: 3, dataUrl: "data:image/png;base64,AQID" };
  const invalidAttachments = [
    { ...valid, dataUrl: "data:image/png;base64,AQ=I" },
    { ...valid, dataUrl: "data:image/png;base64,AQI" },
    { ...valid, size: 2 },
    { ...valid, type: "text/plain" },
    { ...valid, name: "../safe.png" },
  ];
  try {
    for (const [index, attachment] of invalidAttachments.entries()) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const requestId = `invalid-recovery-${index}`;
      await openFixture(page, {
        persistedDrafts: [persistedRecovery({
          requestId,
          text: `invalid ${index}`,
          attachments: [attachment],
          fingerprint: "legacy-invalid-fingerprint",
        })],
      });
      await page.waitForFunction((text) => document.querySelector("[data-composer-input]")?.value === text, `invalid ${index}`);
      assert.equal(await page.locator("[data-attachment-index]").count(), 0);
      assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
      assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
        message.includes("не может точно сохранить")
      ))), true);
      await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
      await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
      await page.waitForFunction(() => {
        const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
        return log.some((entry) => entry.action === "send-message");
      });
      assert.notEqual((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, requestId);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("production durable epoch rejects stale identity after localStorage set/remove failure", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const setContext = await browser.newContext();
    const setPage = await setContext.newPage();
    await openFixture(setPage);
    await submit(setPage, { text: "old durable text" });
    await setPage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "old durable text");
    const oldSetId = (await bridgeCalls(setPage, "send-message")).at(-1).params.clientUserMessageId;
    await setPage.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function failDraftSet(key, value) {
        if (this === localStorage && String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    await setPage.locator("[data-composer-input]").fill("new unsaved text");
    await setPage.waitForFunction(() => window.__toastHistory.some((message) => message.includes("не может точно сохранить")));
    assert.equal(await setPage.evaluate(() => window.__toastHistory.filter((message) => (
      message.includes("не может точно сохранить")
    )).length), 1);
    assert.equal(await setPage.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    await setPage.waitForFunction(() => {
      const status = window.AgentHub.composerRecoveryDiagnostics();
      return status.pending === 0 && status.epoch > 0;
    });
    await setPage.reload({ waitUntil: "load" });
    await setPage.waitForFunction(() => window.AgentHub?.composerRecoveryDiagnostics?.().ready === true);
    assert.equal(await setPage.locator("[data-composer-input]").inputValue(), "");
    await setPage.locator("[data-composer-input]").fill("fresh after failed set");
    await setPage.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await setPage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await setPage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.notEqual((await bridgeCalls(setPage, "send-message")).at(-1).params.clientUserMessageId, oldSetId);
    await setContext.close();

    const removeContext = await browser.newContext();
    const removePage = await removeContext.newPage();
    await openFixture(removePage);
    await submit(removePage, {
      attachment: { name: "remove.png", mimeType: "image/png", buffer: Buffer.from([7, 8, 9]) },
    });
    await removePage.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    const oldRemoveId = (await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId;
    await removePage.evaluate(() => {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function failDraftRemove(key) {
        if (this === localStorage && String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("privacy", "SecurityError");
        }
        return original.call(this, key);
      };
    });
    await removePage.locator("[data-attachment-index]").click();
    await removePage.waitForFunction(() => window.__toastHistory.some((message) => message.includes("не может точно сохранить")));
    assert.equal(await removePage.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    await removePage.waitForFunction(() => {
      const status = window.AgentHub.composerRecoveryDiagnostics();
      return status.pending === 0 && status.epoch > 0;
    });
    await removePage.reload({ waitUntil: "load" });
    await removePage.waitForFunction(() => document.querySelector("[data-composer-input]"));
    assert.equal(await removePage.locator("[data-attachment-index]").count(), 0);
    assert.equal(await removePage.evaluate(() => window.AgentHub.prepareForRuntimeReload()), true);
    await removePage.locator("[data-composer-input]").fill("fresh after failed remove");
    await removePage.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await removePage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await removePage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.notEqual((await bridgeCalls(removePage, "send-message")).at(-1).params.clientUserMessageId, oldRemoveId);
    await removeContext.close();
  } finally {
    await browser.close();
  }
});

test("production recovery fails closed when its independent durable authority is unavailable", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const staleRequestId = "stale-without-authority";
  try {
    await openFixture(page, {
      persistedDrafts: [persistedRecovery({
        requestId: staleRequestId,
        text: "visible but not trusted",
      })],
      recoveryAuthorityAvailable: false,
    });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "visible but not trusted");
    assert.deepEqual(await page.evaluate(() => window.AgentHub.composerRecoveryDiagnostics()), {
      epoch: 0,
      pending: 0,
      ready: true,
      restored: true,
      trusted: false,
    });
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    assert.equal(await page.evaluate(() => window.__toastHistory.some((message) => (
      message.includes("не может точно сохранить")
    ))), true);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.some((entry) => entry.action === "send-message");
    });
    assert.notEqual((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, staleRequestId);
  } finally {
    await browser.close();
  }
});

test("production quote selection resolves the rendered item despite its durable message key", {
  timeout: 60_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const quote = "Astra получила 62,7% в стандартной среде и 99,9% — при сохранении внутреннего состояния рассуждений между ходами.";
    const messageKey = ["provider", "codex", "previous-thread", "source-turn", "source-item", "agent"].join("\u001f");
    const selectionResult = await page.evaluate(async ({ quote, messageKey }) => {
      const source = {
        id: "source-message",
        messageKey,
        itemId: "source-item",
        turnId: "source-turn",
        role: "assistant",
        provider: "codex",
        threadId: "previous-thread",
        text: `Результат: **${quote}** Что это значит?`,
        time: "2026-09-04T08:00:00.000Z",
      };
      window.AgentHub.setMessages("stream-a", [
        { ...source, id: "other-message", itemId: "other-item", messageKey: messageKey.replace("source-item", "other-item") },
        source,
      ]);
      const article = document.querySelector('[data-message-id="source-message"]');
      const range = document.createRange();
      range.selectNodeContents(article.querySelector(".msg-body strong"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return window.AgentHub.addSelectedAnnotation();
    }, { quote, messageKey });
    assert.equal(selectionResult, true);
    assert.equal(await page.locator("[data-annotations] .annotation").count(), 1);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await submit(page, { text: "Что это значит?" });
    const annotation = (await bridgeCalls(page, "send-message")).at(-1).params.responseAnnotations[0];
    assert.equal(annotation.text, quote);
    assert.equal(annotation.source.messageKey, messageKey);
    assert.equal(annotation.source.threadId, "previous-thread");
    assert.equal(annotation.source.itemId, "source-item");
    assert.equal(annotation.source.start, "Результат: ".length);
    assert.equal(annotation.source.end, "Результат: ".length + quote.length);
    for (const field of ["contentHash", "surfaceHash", "selectionHash"]) {
      assert.match(annotation.source[field], /^sha256:[a-f0-9]{64}$/u);
    }
  } finally {
    await browser.close();
  }
});

test("production user quote uses the exact client identity without a provider item", {
  timeout: 60_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const diagnostics = await openFixture(page);
    const added = await page.evaluate(async () => {
      const source = {
        id: "source-user", messageKey: "user-command\u001fordinary-client",
        provider: "codex", threadId: "thread-a", turnId: "source-turn", itemId: "",
        clientUserMessageId: "ordinary-client", role: "user",
        text: "а что за проценты вообще?\nПроценты чего от чего?",
      };
      window.AgentHub.setMessages("stream-a", [
        { ...source, id: "other-user", clientUserMessageId: "other-client", messageKey: "user-command\u001fother-client" },
        source,
      ]);
      const body = document.querySelector('[data-message-id="source-user"] .msg-body');
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let node;
      while ((node = walker.nextNode())) {
        const start = node.data.indexOf("проценты");
        if (start < 0) continue;
        range.setStart(node, start);
        range.setEnd(node, start + "проценты".length);
        break;
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return window.AgentHub.addSelectedAnnotation();
    });
    assert.equal(added, true);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await submit(page, { text: "Уточнить" });
    const annotation = (await bridgeCalls(page, "send-message")).at(-1).params.responseAnnotations[0];
    assert.equal(annotation.text, "проценты");
    assert.equal(annotation.source.clientUserMessageId, "ordinary-client");
    assert.equal(annotation.source.messageKey, "client\u001fcodex\u001fthread-a\u001fordinary-client\u001fuser");
    assert.equal(annotation.source.role, "user");
    assert.equal(annotation.source.turnId, "");
    assert.equal(annotation.source.itemId, "");
    assert.equal(annotation.source.start, 9);
    assert.equal(annotation.source.end, 17);
    assert.deepEqual(diagnostics, []);
  } finally {
    await browser.close();
  }
});

test("production annotation hashing is Task-scoped and no-op failures preserve recovery", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const navigationContext = await browser.newContext();
    const navigation = await navigationContext.newPage();
    await openFixture(navigation);
    await navigation.locator("[data-composer-input]").fill("annotation belongs to A");
    await selectMessageText(navigation);
    await navigation.evaluate(() => {
      const subtle = crypto.subtle;
      const original = subtle.digest;
      window.__heldAnnotationHashes = [];
      subtle.digest = function hold(...args) {
        return new Promise((resolve, reject) => window.__heldAnnotationHashes.push({ self: this, args, resolve, reject }));
      };
      window.__releaseAnnotationHashes = async () => {
        const held = window.__heldAnnotationHashes.splice(0);
        subtle.digest = original;
        for (const entry of held) original.apply(entry.self, entry.args).then(entry.resolve, entry.reject);
      };
      window.__annotationPromise = window.AgentHub.addSelectedAnnotation();
    });
    await navigation.waitForFunction(() => window.__heldAnnotationHashes?.length === 3);
    await setSelectedTask(navigation, "stream-b");
    await navigation.evaluate(() => window.__releaseAnnotationHashes());
    await navigation.evaluate(() => window.__annotationPromise);
    assert.equal(await navigation.locator("[data-annotations] .annotation").count(), 0);
    await setSelectedTask(navigation, "stream-a");
    assert.equal(await navigation.locator("[data-annotations] .annotation").count(), 1);
    assert.equal(await navigation.locator("[data-composer-input]").inputValue(), "annotation belongs to A");
    await navigationContext.close();

    const failureContext = await browser.newContext();
    const failure = await failureContext.newPage();
    await openFixture(failure);
    await submit(failure, { text: "retry after hash failure" });
    await failure.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "retry after hash failure");
    const firstId = (await bridgeCalls(failure, "send-message")).at(-1).params.clientUserMessageId;
    await selectMessageText(failure);
    const added = await failure.evaluate(async () => {
      const subtle = crypto.subtle;
      const original = subtle.digest;
      subtle.digest = () => Promise.reject(new Error("hash failed"));
      try {
        return await window.AgentHub.addSelectedAnnotation();
      } finally {
        subtle.digest = original;
      }
    });
    assert.equal(added, false);
    await failure.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await failure.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await failure.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.equal((await bridgeCalls(failure, "send-message")).at(-1).params.clientUserMessageId, firstId);
    await failureContext.close();
  } finally {
    await browser.close();
  }
});

test("production overlapping and duplicate annotation operations do not advance stale revisions", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const overlapContext = await browser.newContext();
    const overlap = await overlapContext.newPage();
    await openFixture(overlap);
    await selectMessageText(overlap);
    await overlap.evaluate(() => {
      const subtle = crypto.subtle;
      const original = subtle.digest;
      window.__heldAnnotationHashes = [];
      subtle.digest = function hold(...args) {
        return new Promise((resolve, reject) => window.__heldAnnotationHashes.push({ self: this, args, resolve, reject }));
      };
      window.__releaseAnnotationHashIndexes = (indexes) => {
        for (const index of indexes) {
          const entry = window.__heldAnnotationHashes[index];
          original.apply(entry.self, entry.args).then(entry.resolve, entry.reject);
        }
      };
      window.__restoreAnnotationDigest = () => { subtle.digest = original; };
      window.__annotationFirst = window.AgentHub.addSelectedAnnotation();
    });
    await overlap.waitForFunction(() => window.__heldAnnotationHashes?.length === 3);
    await selectMessageText(overlap);
    await overlap.evaluate(() => { window.__annotationSecond = window.AgentHub.addSelectedAnnotation(); });
    await overlap.waitForFunction(() => window.__heldAnnotationHashes?.length === 6);
    await overlap.evaluate(() => window.__releaseAnnotationHashIndexes([3, 4, 5]));
    assert.equal(await overlap.evaluate(() => window.__annotationSecond), true);
    await overlap.evaluate(() => window.__releaseAnnotationHashIndexes([0, 1, 2]));
    assert.equal(await overlap.evaluate(() => window.__annotationFirst), false);
    await overlap.evaluate(() => window.__restoreAnnotationDigest());
    assert.equal(await overlap.locator("[data-annotations] .annotation").count(), 1);
    await overlapContext.close();

    const duplicateContext = await browser.newContext();
    const duplicate = await duplicateContext.newPage();
    await openFixture(duplicate);
    await selectMessageText(duplicate);
    assert.equal(await duplicate.evaluate(() => window.AgentHub.addSelectedAnnotation()), true);
    await duplicate.locator("[data-composer-input]").fill("duplicate annotation retry");
    await duplicate.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await duplicate.waitForFunction(() => document.querySelectorAll("[data-annotations] .annotation").length === 1);
    const requestId = (await bridgeCalls(duplicate, "send-message")).at(-1).params.clientUserMessageId;
    await selectMessageText(duplicate);
    assert.equal(await duplicate.evaluate(() => window.AgentHub.addSelectedAnnotation()), false);
    await lateAcceptedReceipt(duplicate, requestId);
    assert.equal(await duplicate.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await duplicate.locator("[data-annotations] .annotation").count(), 0);
    await duplicateContext.close();
  } finally {
    await browser.close();
  }
});

test("production failed Blob batch stays visible until explicit removal and preserves unchanged recovery identity", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, { text: "reader failure retry" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "reader failure retry");
    const originalId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.evaluate(() => {
      const original = window.AgentHubComposerFiles;
      window.AgentHubComposerFiles = { ...original, prepare: async (file, metadata, options) => {
        if (file.name === "broken.png") {
          throw new Error("Не удалось прочитать broken.png");
        }
        return original.prepare(file, metadata, options);
      } };
    });
    await page.locator("[data-file-input]").setInputFiles([
      { name: "good.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) },
      { name: "broken.png", mimeType: "image/png", buffer: Buffer.from([4, 5, 6]) },
    ]);
    await page.waitForFunction(() => window.__toastHistory.some((message) => message.includes("broken.png")));
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "reader failure retry");
    assert.equal(await page.locator("[data-attachment-index]").count(), 0);
    assert.equal(await page.locator("[data-attachment-preparing]").count(), 2,
      "failure cannot silently discard the successful file or the unread original");
    assert.equal(await page.locator("[data-composer-send]").isDisabled(), true);
    await page.locator('[data-attachment-preparation-remove][aria-label="Удалить good.png"]').click();
    await page.locator('[data-attachment-preparation-remove][aria-label="Удалить broken.png"]').click();
    assert.equal(await page.locator("[data-attachment-preparing]").count(), 0);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.equal((await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId, originalId);
  } finally {
    await browser.close();
  }
});

test("production snapshot evidence completes once and fails closed on ambiguity", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await submit(page, { text: "aggregate evidence" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "aggregate evidence");
    const requestId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    const requestOnly = await page.evaluate((id) => window.AgentHub.completeSend(id, { outcome: "accepted" }), requestId);
    assert.equal(requestOnly.cleared, false);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "aggregate evidence");
    await page.evaluate(() => {
      const complete = window.AgentHub.completeSend.bind(window.AgentHub);
      window.__completionCalls = [];
      window.AgentHub.completeSend = (...args) => {
        window.__completionCalls.push(structuredClone(args));
        return complete(...args);
      };
    });
    const accepted = snapshot([{
      provider: "codex", threadId: "thread-a", streamId: "stream-a",
      clientUserMessageId: requestId, accepted: true,
    }]);
    accepted.version = "aggregate-1";
    accepted.deferredInputs = [{
      id: "deferred-1", provider: "codex", threadId: "thread-a", streamId: "stream-a",
      clientUserMessageId: requestId, state: "queued", text: "aggregate evidence",
    }];
    accepted.tasks[0] = {
      ...accepted.tasks[0],
      running: true,
      run: {
        clientUserMessageId: requestId,
        turnId: "turn-aggregate",
        providerStart: { state: "observed", turnId: "turn-aggregate" },
      },
    };
    await applyFixtureSnapshot(page, accepted);
    await page.waitForFunction(() => window.__completionCalls.length === 1);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");

    await applyFixtureSnapshot(page, { ...structuredClone(accepted), version: "aggregate-2" });
    assert.equal(await page.evaluate(() => window.__completionCalls.length), 1);

    const ambiguous = structuredClone(accepted);
    ambiguous.version = "aggregate-ambiguous";
    ambiguous.deferredInputs.push({
      id: "deferred-2", provider: "codex", threadId: "thread-b", streamId: "stream-b",
      clientUserMessageId: requestId, state: "queued", text: "wrong owner",
    });
    await applyFixtureSnapshot(page, ambiguous);
    assert.equal(await page.evaluate(() => window.__completionCalls.length), 1);
  } finally {
    await browser.close();
  }
});

test("production upload completion is fenced by Task generation and exact Thread identity", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      localStorage.setItem("fixture:upload-mode", "hold");
      localStorage.setItem("fixture:send-mode", "accept");
    });
    await page.locator("[data-composer-input]").fill("stale upload must abort");
    await page.locator("[data-file-input]").setInputFiles({
      name: "held.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]),
    });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => Boolean(window.__agentHubFixture.heldUpload));
    const replaced = snapshot();
    replaced.version = "thread-replaced";
    replaced.tasks[0] = {
      ...replaced.tasks[0],
      provider: "claude",
      threadId: "thread-a-replaced",
      title: "Replaced Thread",
      displayTitle: "Replaced Thread",
    };
    replaced.workspaces[0].streams[0].threads = [{ id: "thread-a-replaced" }];
    replaced.selected.threadId = "thread-a-replaced";
    replaced.selected.provider = "claude";
    await applyFixtureSnapshot(page, replaced);
    await page.waitForFunction(() => document.querySelector("[data-stream-header-provider]")?.textContent === "Claude");
    await page.evaluate(() => window.__releaseHeldUpload());
    await page.waitForFunction(() => window.__toastHistory.some((message) => message.includes("Диалог изменился")));
    assert.equal((await bridgeCalls(page, "upload-attachment")).length, 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
  } finally {
    await browser.close();
  }
});

test("production Task deletion durably fences same-identity cold recreation", {
  timeout: 120_000,
}, async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openFixture(page);
    await submit(page, { text: "deleted recovery must stay deleted" });
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "deleted recovery must stay deleted");
    const oldId = (await bridgeCalls(page, "send-message")).at(-1).params.clientUserMessageId;
    await page.evaluate(() => {
      const originalSet = Storage.prototype.setItem;
      const originalRemove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function failDraftSet(key, value) {
        if (this === localStorage && String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return originalSet.call(this, key, value);
      };
      Storage.prototype.removeItem = function failDraftRemove(key) {
        if (this === localStorage && String(key).startsWith("agent-hub:composer-drafts:")) {
          throw new DOMException("privacy", "SecurityError");
        }
        return originalRemove.call(this, key);
      };
    });
    const deleted = snapshot();
    deleted.version = "task-a-deleted";
    deleted.tasks = [{ ...task("stream-b"), selected: true }];
    deleted.workspaces[0].streams = [deleted.workspaces[0].streams[1]];
    deleted.selected = { ...deleted.selected, streamId: "stream-b", threadId: "thread-b" };
    await applyFixtureSnapshot(page, deleted);
    await page.waitForFunction(() => !document.querySelector("[data-stream-task-id='stream-a']"));
    await page.waitForFunction(() => {
      const status = window.AgentHub.composerRecoveryDiagnostics();
      return status.pending === 0 && status.epoch > 0;
    });
    await page.close();

    const cold = await context.newPage();
    await openFixture(cold, { expectedTaskId: "stream-b" });
    const recreated = snapshot();
    recreated.version = "task-a-recreated";
    await applyFixtureSnapshot(cold, recreated);
    await setSelectedTask(cold, "stream-a");
    assert.equal(await cold.locator("[data-composer-input]").inputValue(), "");
    assert.equal(await cold.locator("[data-attachment-index]").count(), 0);
    await cold.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await cold.locator("[data-composer-input]").fill("deleted recovery must stay deleted");
    await cold.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await cold.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.notEqual((await bridgeCalls(cold, "send-message")).at(-1).params.clientUserMessageId, oldId);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("production attachment boundary rejects unsafe names and accepts more than 20 MiB in parts", {
  timeout: 180_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const unsafePage = await browser.newPage();
    await openFixture(unsafePage);
    await submit(unsafePage, { text: "unsafe names preserve retry" });
    await unsafePage.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "unsafe names preserve retry");
    const originalId = (await bridgeCalls(unsafePage, "send-message")).at(-1).params.clientUserMessageId;
    const unsafeResults = await unsafePage.evaluate(async () => {
      const results = [];
      for (const name of [".", "..", "NUL.txt", "control\u0085.png", "trail. "]) {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array([1])], name, { type: "image/png" }));
        const input = document.querySelector("[data-file-input]");
        Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push({ name, count: document.querySelectorAll("[data-attachment-index]").length });
      }
      return {
        results,
        loneSurrogateRejected: window.AgentHubComposerDraftReconciliation.safeAttachmentMetadata({
          name: "lone-\uD800.png", type: "image/png", size: 1,
        }) === null,
      };
    });
    assert.deepEqual(unsafeResults.results.map((entry) => entry.count), [0, 0, 0, 0, 0]);
    assert.equal(unsafeResults.loneSurrogateRejected, true);
    assert.equal(await unsafePage.locator("[data-attachment-index]").count(), 0);
    await unsafePage.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await unsafePage.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await unsafePage.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "send-message").length === 2;
    });
    assert.equal((await bridgeCalls(unsafePage, "send-message")).at(-1).params.clientUserMessageId, originalId);
    await unsafePage.close();

    const maximum = await browser.newPage();
    const diagnostics = await openFixture(maximum, { chunkedUpload: true });
    await maximum.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(
        [new Uint8Array(20 * 1024 * 1024)],
        "maximum.bin",
        { type: "application/octet-stream" },
      ));
      const input = document.querySelector("[data-file-input]");
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await maximum.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1, null, {
      timeout: 60_000,
    });
    await maximum.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([1])], "overflow.bin", { type: "application/octet-stream" }));
      const input = document.querySelector("[data-file-input]");
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      localStorage.setItem("fixture:send-mode", "accept");
    });
    await maximum.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 2);
    assert.equal(await maximum.locator("[data-attachment-index]").count(), 2);
    await maximum.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await maximum.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.some((entry) => entry.action === "send-message");
    }, null, { timeout: 60_000 });
    const uploads = await maximum.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]"));
    assert.equal(uploads.filter(item => item.method === "PUT").length, 21);
    assert.equal(diagnostics.some((message) => /RangeError|Maximum call stack/iu.test(message)), false);
  } finally {
    await browser.close();
  }
});

test("shipped queue explains a real context-maintenance wait without a new toast", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const fixtureSnapshot = snapshot();
    fixtureSnapshot.deferredInputs = [{
      id: "waiting-for-compaction", state: "queued", provider: "codex",
      streamId: "stream-a", threadId: "thread-a",
      clientUserMessageId: "queued-user-1", text: "Продолжай",
      conflictKind: "context-maintenance", waitReason: "context-maintenance",
      createdAt: "2026-09-29T11:51:57.201Z", attachments: [],
    }];
    await openFixture(page, { fixtureSnapshot });
    const row = page.locator(".queue-item[data-queue-id='waiting-for-compaction']");
    await row.waitFor({ state: "visible" });
    assert.match(await row.locator(".queue-status").textContent(), /свёртки или ротации контекста/u);
    assert.equal(await page.locator(".queue-toast").count(), 0);
  } finally {
    await browser.close();
  }
});
