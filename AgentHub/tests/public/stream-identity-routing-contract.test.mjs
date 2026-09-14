import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFixtureSnapshot, launchBrowser, openFixture, persistedRecovery,
  refreshWithReceipt, setSelectedTask, snapshot,
} from "./composer-production.fixture.mjs";

test("production receipts route by explicit Stream or exact provider Thread, never equal message text", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    for (const explicitStream of [true, false]) {
      const page = await browser.newPage();
      try {
        const text = "Same message in two Streams";
        await openFixture(page, { persistedDrafts: [
          persistedRecovery({ taskId: "stream-a", requestId: "request-a", text }),
          persistedRecovery({ taskId: "stream-b", requestId: "request-b", text }),
        ] });
        assert.equal(await page.locator("[data-composer-input]").inputValue(), text);
        const base = {
          clientUserMessageId: "request-a",
          accepted: true,
          conflictKind: "message-intake",
          clientProjectionIntent: "conversation",
          displayText: text,
        };
        for (const identity of [
          { provider: "codex", threadId: "thread-b", ...(explicitStream ? { streamId: "stream-b" } : {}) },
          { provider: "claude", threadId: "thread-a", ...(explicitStream ? { streamId: "stream-a" } : {}) },
          { provider: "codex", threadId: "thread-a", streamId: "stream-b" },
        ]) {
          await refreshWithReceipt(page, { ...base, ...identity });
          await setSelectedTask(page, "stream-a");
          assert.equal(await page.locator("[data-composer-input]").inputValue(), text);
          await setSelectedTask(page, "stream-b");
          assert.equal(await page.locator("[data-composer-input]").inputValue(), text);
        }
        await refreshWithReceipt(page, {
          ...base, provider: "codex", threadId: "thread-a",
          ...(explicitStream ? { streamId: "stream-a" } : {}),
        });
        await setSelectedTask(page, "stream-a");
        await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "");
        await setSelectedTask(page, "stream-b");
        assert.equal(await page.locator("[data-composer-input]").inputValue(), text);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

function streamEntry(streamId, ordinal) {
  const suffix = streamId.at(-1).toUpperCase();
  return {
    id: streamId,
    name: `Stream ${suffix}`,
    displayName: `Stream ${suffix}`,
    ordinal,
    threads: [{ id: `thread-${streamId.at(-1)}` }],
  };
}

// Два Workspace: workspace-1 = streams1, workspace-2 = [stream-c].
function twoWorkspaceSnapshot({ version, streams1, selectedStreamId }) {
  const base = snapshot();
  const taskFor = (streamId, workspaceId, ordinal) => ({
    ...base.tasks[0],
    streamId,
    streamName: `Stream ${streamId.at(-1).toUpperCase()}`,
    streamDisplayName: `Stream ${streamId.at(-1).toUpperCase()}`,
    streamOrdinal: ordinal,
    provider: "codex",
    threadId: `thread-${streamId.at(-1)}`,
    workspaceId,
    workspaceName: workspaceId === "workspace-1" ? "Workspace" : "Workspace Two",
    title: `Thread ${streamId.at(-1).toUpperCase()}`,
    displayTitle: `Thread ${streamId.at(-1).toUpperCase()}`,
    selected: streamId === selectedStreamId,
  });
  return {
    ...base,
    version,
    tasks: [
      ...streams1.map((streamId, index) => taskFor(streamId, "workspace-1", index + 1)),
      taskFor("stream-c", "workspace-2", 1),
    ],
    workspaces: [
      {
        id: "workspace-1", name: "Workspace", kind: "project",
        streams: streams1.map((streamId, index) => streamEntry(streamId, index + 1)),
      },
      {
        id: "workspace-2", name: "Workspace Two", kind: "project",
        streams: [streamEntry("stream-c", 1)],
      },
    ],
    selected: {
      streamId: selectedStreamId,
      provider: "codex",
      threadId: `thread-${selectedStreamId.at(-1)}`,
      model: "gpt-test", reasoning: "medium", mode: "default",
    },
  };
}

function liveRunSnapshot() {
  const next = snapshot();
  next.version = "batched-live-run";
  next.tasks[0] = {
    ...next.tasks[0],
    running: true,
    run: {
      id: "run-live",
      turnId: "turn-live",
      operationKind: "user-turn",
      providerStart: { state: "observed", turnId: "turn-live" },
      clientUserMessageId: "live-request",
      prompt: "Live question",
      startedAt: "2026-09-11T00:00:00.000Z",
      submittedAt: "2026-09-11T00:00:00.000Z",
      userMessages: [{
        role: "user",
        clientUserMessageId: "live-request",
        text: "Live question",
        submittedAt: "2026-09-11T00:00:00.000Z",
      }],
    },
  };
  return next;
}

const selectedStreamId = (page) => page.evaluate(() => (
  document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId ?? ""
));

// Раньше это место проверяло текст hub-client.js регулярками по телу функций.
// Наблюдаемый инвариант: применяя снимок, список сообщений не перерисовывают
// раньше, чем применён live run, поэтому промежуточный кадр без живого хода
// пользователю не показывается. Число перерисовок инвариантом не является.
test("applying a snapshot never renders messages before the live run is applied", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await setSelectedTask(page, "stream-a");

    await page.evaluate(() => {
      const calls = [];
      window.__projectionCalls = calls;
      for (const name of ["setMessages", "setMessagesPreservingScroll", "setMessagesForExactNavigation", "setLive"]) {
        const original = window.AgentHub[name];
        if (typeof original !== "function") continue;
        window.AgentHub[name] = function (taskId, ...rest) {
          calls.push({ name, taskId: String(taskId ?? "") });
          return original.call(this, taskId, ...rest);
        };
      }
    });

    await applyFixtureSnapshot(page, liveRunSnapshot());
    await page.waitForFunction(() => (
      (window.__projectionCalls ?? []).some((call) => call.name === "setLive" && call.taskId === "stream-a")
    ), null, { timeout: 10_000 });

    const names = (await page.evaluate(() => window.__projectionCalls.filter((call) => call.taskId === "stream-a")))
      .map((call) => call.name);
    const firstRender = names.findIndex((name) => name.startsWith("setMessages"));
    const firstLive = names.indexOf("setLive");
    assert.ok(firstRender >= 0, `список обязан быть перерисован: ${JSON.stringify(names)}`);
    assert.ok(firstLive >= 0, `live run должен быть применён: ${JSON.stringify(names)}`);
    assert.ok(firstRender > firstLive,
      `список перерисован до применения live run: ${JSON.stringify(names)}`);

    // Итоговое состояние показывает живой ход, а не промежуточный кадр.
    await page.waitForFunction(() => document.querySelectorAll(".msg-live").length > 0, null, { timeout: 10_000 });
  } finally {
    await page.close();
    await browser.close();
  }
});

// Раньше это место фиксировало регуляркой порядок тернарных веток
// effectiveSelectedId. Наблюдаемый инвариант: когда выбранный Stream исчезает,
// выбор переходит к соседнему Stream того же Workspace, а не к предложенному
// сервером Stream из другого Workspace.
test("archiving the selected Stream falls back inside the same Workspace, not to the server choice", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page, {
      fixtureSnapshot: twoWorkspaceSnapshot({
        version: "fallback-initial",
        streams1: ["stream-a", "stream-b"],
        selectedStreamId: "stream-a",
      }),
    });
    await setSelectedTask(page, "stream-a");
    assert.equal(await selectedStreamId(page), "stream-a");

    // Выбранный Stream исчез, сервер предлагает Stream из другого Workspace.
    await applyFixtureSnapshot(page, twoWorkspaceSnapshot({
      version: "fallback-archived-selected",
      streams1: ["stream-b"],
      selectedStreamId: "stream-c",
    }));
    await page.waitForFunction(() => (
      document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId !== "stream-a"
    ), null, { timeout: 10_000 });

    assert.equal(await selectedStreamId(page), "stream-b",
      "выбор обязан остаться в workspace-1, а не уйти на предложенный сервером stream-c");
  } finally {
    await page.close();
    await browser.close();
  }
});
