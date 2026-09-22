import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  exactTestContourResponsePattern,
  isTestContourModelSettingResponse,
  locateTestContourResponse,
  observeTestContourSend,
  planTestContourSmokeConversation,
  prepareTestContourSmokeConversation,
  requestTestContourControl,
  runTestContourUiSmoke,
  selectTestContourConversation,
  selectTestContourModel,
} from "../../../src/infrastructure/browser/test-contour-ui-smoke.mjs";

function smokePage({ availableModels = ["gpt-5.3-codex-spark"], selectedModel = "" } = {}) {
  const events = [];
  let currentModel = selectedModel;
  const locators = {
    "[data-dialog-settings-toggle]": {
      async waitFor(options) { events.push(["toggle.waitFor", options]); },
      async click() { events.push(["toggle.click"]); },
    },
    'select[data-dialog-options="model"]': {
      async waitFor(options) { events.push(["model.waitFor", options]); },
      locator(selector) {
        if (selector.startsWith('option[value="')) {
          const value = selector.match(/^option\[value="(.+)"\]$/u)?.[1] ?? "";
          return {
            async waitFor(options) {
              events.push(["model.option.waitFor", value, options]);
              if (!availableModels.includes(value)) throw new Error("option unavailable");
            },
          };
        }
        assert.equal(selector, "option");
        return {
          async evaluateAll(callback) {
            return callback(availableModels.map((value) => ({ value })));
          },
        };
      },
      async selectOption(value, options) {
        events.push(["model.selectOption", value, options]);
        currentModel = value;
      },
      async inputValue() { return currentModel; },
    },
    "[data-dialog-settings-close]": {
      async click() { events.push(["close.click"]); },
    },
  };
  return {
    events,
    page: {
      locator(selector) {
        assert.ok(locators[selector], `Unexpected selector: ${selector}`);
        return locators[selector];
      },
      async waitForResponse(predicate, options) {
        const response = {
          ok: () => true,
          status: () => 200,
          url: () => "http://localhost:8877/api/control",
          request: () => ({
            method: () => "POST",
            postData: () => JSON.stringify({
              action: "update-setting",
              params: { name: "model", value: currentModel },
            }),
          }),
        };
        events.push(["page.waitForResponse", options]);
        return new Promise((resolve) => {
          queueMicrotask(() => {
            assert.equal(predicate(response), true);
            resolve(response);
          });
        });
      },
    },
  };
}

function thread(threadId, { position = 1, detachedAtMs = null, provider = "codex" } = {}) {
  return { provider, threadId, position, detachedAtMs };
}

function snapshot({ workspaceId = "workspace-1", streams = [] } = {}) {
  return { workspaces: workspaceId ? [{ id: workspaceId, streams }] : [] };
}

function stream(id, threads, { name = null } = {}) {
  return { id, name, threads };
}

function saved(overrides = {}) {
  return {
    version: 1,
    workspaceId: "workspace-1",
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    ...overrides,
  };
}

function browserControlResult(result, { receiptId = null, acknowledged = null } = {}) {
  return {
    kind: "response",
    ok: true,
    status: 200,
    text: JSON.stringify({ ok: true, result, ...(receiptId ? { receiptId } : {}) }),
    payload: { ok: true, result, ...(receiptId ? { receiptId } : {}) },
    acknowledged,
  };
}

function controlRequest({ action = "send-message", params, commandId = "command-1" } = {}) {
  return {
    url: () => "http://127.0.0.1:8877/api/control",
    method: () => "POST",
    postData: () => JSON.stringify({ action, params, commandId }),
  };
}

function controlResponse(request, { status = 200, payload = {} } = {}) {
  return {
    request: () => request,
    ok: () => status >= 200 && status < 300,
    status: () => status,
    async json() { return payload; },
  };
}

test("Test Contour smoke selects the requested model before creating a thread", async () => {
  const fixture = smokePage({
    availableModels: ["gpt-5.3-codex-spark", "gpt-5.6-luna", "fake-codex"],
    selectedModel: "fake-codex",
  });

  await selectTestContourModel(fixture.page, "gpt-5.6-luna", 5_000);

  assert.deepEqual(fixture.events, [
    ["toggle.waitFor", { state: "visible", timeout: 5_000 }],
    ["toggle.click"],
    ["model.waitFor", { state: "attached", timeout: 5_000 }],
    ["model.option.waitFor", "gpt-5.6-luna", { state: "attached", timeout: 5_000 }],
    ["page.waitForResponse", { timeout: 5_000 }],
    ["model.selectOption", "gpt-5.6-luna", { force: true }],
    ["close.click"],
  ]);
});

test("Test Contour smoke accepts an already selected model without waiting for a no-op request", async () => {
  const fixture = smokePage({ availableModels: ["fake-codex"], selectedModel: "fake-codex" });

  await selectTestContourModel(fixture.page, "fake-codex", 5_000);

  assert.equal(fixture.events.some(([event]) => event === "page.waitForResponse"), false);
  assert.equal(fixture.events.some(([event]) => event === "model.selectOption"), false);
  assert.deepEqual(fixture.events.at(-1), ["close.click"]);
});

test("Test Contour smoke reuses only its exact live current conversation", () => {
  const current = snapshot({
    streams: [
      stream("stream-first-named", [thread("historical", { detachedAtMs: 123 })], { name: "Named" }),
      stream("stream-live-unnamed", [thread("unrelated-live")]),
      stream("stream-smoke", [thread("thread-smoke")]),
    ],
  });

  assert.deepEqual(planTestContourSmokeConversation(current, saved(), "fake-codex"), {
    kind: "reuse",
    identity: {
      workspaceId: "workspace-1",
      streamId: "stream-smoke",
      provider: "codex",
      threadId: "thread-smoke",
    },
  });
});

test("Test Contour smoke replaces a detached or shadowed saved Thread in the same dedicated Stream", () => {
  for (const threads of [
    [thread("thread-smoke", { detachedAtMs: 123 })],
    [thread("thread-smoke"), thread("newer-historical", { position: 2, detachedAtMs: 123 })],
  ]) {
    assert.deepEqual(
      planTestContourSmokeConversation(snapshot({ streams: [stream("stream-smoke", threads)] }), saved(), "fake-codex"),
      {
        kind: "create-thread",
        params: {
          streamId: "stream-smoke",
          provider: "codex",
          settings: { provider: "codex", model: "fake-codex" },
        },
      },
    );
  }
});

test("Test Contour smoke replaces a saved Stream missing from the local catalog", () => {
  const current = snapshot({
    streams: [
      stream("unrelated-live", [thread("unrelated-thread")]),
      stream("historical", [thread("detached", { detachedAtMs: 123 })], { name: "Historical" }),
    ],
  });

  assert.deepEqual(planTestContourSmokeConversation(current, saved(), "fake-codex"), {
    kind: "create-stream",
    params: {
      workspaceId: "workspace-1",
      streamName: "Smoke",
      provider: "codex",
      settings: { provider: "codex", model: "fake-codex" },
    },
  });
});

test("Test Contour smoke creates a dedicated Stream without depending on names or existing Thread order", () => {
  const current = {
    workspaces: [
      { id: "workspace-z", streams: [stream("named-historical", [thread("old", { detachedAtMs: 1 })], { name: "First" })] },
      { id: "workspace-a", streams: [stream("unnamed-live", [thread("live")])] },
    ],
  };

  const plan = planTestContourSmokeConversation(current, null, "fake-codex");

  assert.equal(plan.kind, "create-stream");
  assert.equal(plan.params.workspaceId, "workspace-a");
  assert.equal(plan.params.streamName, "Smoke");
  assert.deepEqual(plan.params.settings, { provider: "codex", model: "fake-codex" });
});

test("Test Contour smoke creates its isolated Workspace when the cloned catalog is empty", () => {
  assert.deepEqual(planTestContourSmokeConversation({ workspaces: [] }, null, "fake-codex"), {
    kind: "create-workspace",
    params: {
      workspaceName: "Agent Hub Test Contour Smoke",
      streamName: "Smoke",
      provider: "codex",
      settings: { provider: "codex", model: "fake-codex" },
    },
  });
});

test("Test Contour smoke selects the exact prepared Stream and verifies its projected identity", async () => {
  const events = [];
  const page = {
    locator(selector) {
      if (selector.includes("data-workspace-select")) return {
        async waitFor(options) { events.push(["workspace.wait", selector, options]); },
        async click() { events.push(["workspace.click"]); },
      };
      assert.match(selector, /data-stream-tab-id="stream-smoke"/u);
      assert.doesNotMatch(selector, /data-stream-name/u);
      return {
        async waitFor(options) { events.push(["stream.wait", selector, options]); },
        async getAttribute(name) {
          assert.equal(name, "data-stream-task-id");
          return "stream-smoke";
        },
        async click() { events.push(["stream.click"]); },
      };
    },
  };

  await selectTestContourConversation(page, saved(), 5_000);

  assert.deepEqual(events.map(([event]) => event), ["workspace.wait", "workspace.click", "stream.wait", "stream.click"]);
});

test("Test Contour smoke persists a fresh public new-task identity and reuses it after refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-smoke-conversation-"));
  const createdSnapshot = snapshot({ streams: [stream("stream-smoke", [thread("thread-smoke")])] });
  const calls = [];
  const replies = [
    browserControlResult({ workspaces: [] }),
    browserControlResult({
      ...createdSnapshot,
      createdTask: { streamId: "stream-smoke", provider: "codex", threadId: "thread-smoke" },
    }, { receiptId: "setup-command", acknowledged: true }),
    browserControlResult(createdSnapshot),
    browserControlResult(createdSnapshot),
  ];
  const page = {
    async evaluate(_callback, request) {
      calls.push([request.action, request.commandId || null]);
      return replies.shift();
    },
    async reload(options) { calls.push(["reload", options]); },
    locator(selector) {
      if (selector === "[data-workspace]") return { async waitFor() {} };
      if (selector.includes("data-workspace-select")) return { async waitFor() {}, async click() {} };
      return {
        async waitFor() {},
        async getAttribute(name) {
          assert.equal(name, "data-stream-task-id");
          return "stream-smoke";
        },
        async click() {},
      };
    },
  };
  try {
    const first = await prepareTestContourSmokeConversation(page, {
      artifactsDirectory: root,
      model: "fake-codex",
      timeoutMs: 5_000,
      commandIdFactory: () => "setup-command",
    });
    const second = await prepareTestContourSmokeConversation(page, {
      artifactsDirectory: root,
      model: "fake-codex",
      timeoutMs: 5_000,
      commandIdFactory: () => "must-not-run",
    });

    assert.equal(first.setup, "create-workspace");
    assert.equal(first.setupCommandId, "setup-command");
    assert.equal(first.setupAcknowledged, true);
    assert.equal(second.setup, "reuse");
    assert.equal(second.setupCommandId, null);
    assert.equal(calls.filter(([action]) => action === "new-task").length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "ui-smoke-conversation.json"), "utf8")), saved());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Test Contour control reports a rejected mutation immediately with its exact command", async () => {
  let attempts = 0;
  const page = {
    async evaluate() {
      attempts += 1;
      return {
        kind: "response",
        ok: false,
        status: 400,
        text: "historical Thread",
        payload: { ok: false, error: "Это исторический Thread тестового контура" },
      };
    },
  };

  await assert.rejects(
    requestTestContourControl(page, {
      action: "new-task",
      params: { streamId: "stream-1" },
      commandId: "setup-command",
      timeoutMs: 5_000,
    }),
    /new-task failed: HTTP 400; command setup-command; Это исторический Thread/u,
  );
  assert.equal(attempts, 1);
});

test("Test Contour control uses the production HTTP envelope and acknowledges the exact receipt", async () => {
  const calls = [];
  const page = {
    async evaluate(callback, request) {
      const previousWindow = globalThis.window;
      const previousFetch = globalThis.fetch;
      globalThis.window = { setTimeout, clearTimeout };
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === "/api/control/ack") {
          return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ ok: true, receiptId: "setup-command", result: { createdTask: { threadId: "thread-1" } } });
          },
        };
      };
      try {
        return await callback(request);
      } finally {
        globalThis.window = previousWindow;
        globalThis.fetch = previousFetch;
      }
    },
  };

  const accepted = await requestTestContourControl(page, {
    action: "new-task",
    params: { streamId: "stream-1", provider: "codex" },
    commandId: "setup-command",
    timeoutMs: 5_000,
  });

  assert.equal(accepted.receiptId, "setup-command");
  assert.equal(accepted.acknowledged, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    action: "new-task",
    params: { streamId: "stream-1", provider: "codex" },
    commandId: "setup-command",
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), { commandId: "setup-command" });
});

test("Test Contour control never retries an unknown mutation outcome", async () => {
  let attempts = 0;
  const page = {
    async evaluate() {
      attempts += 1;
      return { kind: "unknown", error: "network closed" };
    },
  };

  await assert.rejects(
    requestTestContourControl(page, {
      action: "new-task",
      params: {},
      commandId: "setup-unknown",
      timeoutMs: 5_000,
    }),
    /outcome is unknown; command setup-unknown was not retried/u,
  );
  assert.equal(attempts, 1);
});

test("Test Contour smoke binds a successful send to exact Stream Thread command client message and turn", async () => {
  const params = {
    text: "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1",
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    clientUserMessageId: "client-message-1",
  };
  const request = controlRequest({ params, commandId: "send-command-1" });
  const response = controlResponse(request, {
    payload: {
      ok: true,
      receiptId: "send-command-1",
      result: {
        accepted: true,
        streamId: "stream-smoke",
        provider: "codex",
        threadId: "thread-smoke",
        clientUserMessageId: "client-message-1",
        turnId: "turn-1",
      },
    },
  });
  let clicks = 0;
  const page = {
    async waitForRequest(predicate) {
      assert.equal(predicate(request), true);
      return request;
    },
    async waitForResponse(predicate) {
      assert.equal(predicate(response), true);
      return response;
    },
  };

  assert.deepEqual(await observeTestContourSend(page, {
    identity: saved(),
    timeoutMs: 5_000,
    click: async () => { clicks += 1; },
  }), {
    commandId: "send-command-1",
    clientUserMessageId: "client-message-1",
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    turnId: "turn-1",
  });
  assert.equal(clicks, 1);
});

test("Test Contour smoke rejects a send ACK whose receipt or durable identity differs", async () => {
  const params = {
    text: "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1",
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    clientUserMessageId: "client-message-1",
  };
  for (const resultPatch of [
    { receiptId: "other-command" },
    { clientUserMessageId: "other-client" },
    { threadId: "other-thread" },
  ]) {
    const request = controlRequest({ params, commandId: "send-command-1" });
    const response = controlResponse(request, {
      payload: {
        ok: true,
        receiptId: resultPatch.receiptId ?? "send-command-1",
        result: {
          accepted: true,
          streamId: "stream-smoke",
          provider: "codex",
          threadId: resultPatch.threadId ?? "thread-smoke",
          clientUserMessageId: resultPatch.clientUserMessageId ?? "client-message-1",
          turnId: "turn-1",
        },
      },
    });
    const page = {
      async waitForRequest(predicate) { assert.equal(predicate(request), true); return request; },
      async waitForResponse(predicate) { assert.equal(predicate(response), true); return response; },
    };
    await assert.rejects(observeTestContourSend(page, {
      identity: saved(),
      timeoutMs: 5_000,
      click: async () => {},
    }), /invalid acceptance/u);
  }
});

test("Test Contour smoke locates only the exact accepted turn in its exact Stream column", () => {
  const calls = [];
  const finalLocator = { marker: "exact-turn" };
  const page = {
    locator(selector) {
      calls.push(["locator", selector]);
      return {
        filter(options) {
          calls.push(["filter", options]);
          return {
            last() {
              calls.push(["last"]);
              return finalLocator;
            },
          };
        },
      };
    },
  };

  assert.equal(locateTestContourResponse(page, {
    streamId: "stream-smoke",
    turnId: "turn-1",
    response: "Принято",
  }), finalLocator);
  assert.equal(calls[0][1], '[data-stream-chat-task-id="stream-smoke"] .msg-agent[data-turn-id="turn-1"] .msg-body');
  assert.equal(calls[1][1].hasText.test("Принято"), true);
  assert.equal(calls[1][1].hasText.test("Старый ответ: Принято"), false);
});

test("Test Contour smoke surfaces the historical-Thread HTTP rejection without waiting for an answer", async () => {
  const params = {
    text: "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1",
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    clientUserMessageId: "client-message-1",
  };
  const request = controlRequest({ params, commandId: "send-rejected" });
  const response = controlResponse(request, {
    status: 400,
    payload: { ok: false, error: "Это исторический Thread тестового контура" },
  });
  const page = {
    async waitForRequest(predicate) { assert.equal(predicate(request), true); return request; },
    async waitForResponse(predicate) { assert.equal(predicate(response), true); return response; },
  };

  await assert.rejects(observeTestContourSend(page, {
    identity: saved(),
    timeoutMs: 180_000,
    click: async () => {},
  }), /send-message failed: HTTP 400; command send-rejected; Это исторический Thread/u);
});

test("Test Contour smoke does not click again after an observed send has an unknown outcome", async () => {
  const request = controlRequest({
    commandId: "send-unknown",
    params: {
      text: "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1",
      streamId: "stream-smoke",
      provider: "codex",
      threadId: "thread-smoke",
      clientUserMessageId: "client-message-1",
    },
  });
  let clicks = 0;
  const page = {
    async waitForRequest(predicate) { assert.equal(predicate(request), true); return request; },
    async waitForResponse() { throw new Error("response timeout"); },
  };

  await assert.rejects(observeTestContourSend(page, {
    identity: saved(),
    timeoutMs: 5_000,
    click: async () => { clicks += 1; },
  }), /outcome is unknown; command send-unknown was not retried/u);
  assert.equal(clicks, 1);
});

test("Test Contour agent smoke refuses any provider path not verified as isolated fake", async () => {
  await assert.rejects(runTestContourUiSmoke({
    url: "http://127.0.0.1:8877/#access=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    automationRoot: "unused",
    artifactsDirectory: "unused",
    withAgent: true,
    model: "fake-codex",
    isolatedFakeProvider: false,
  }), /requires the verified isolated fake provider/u);
});

test("Test Contour smoke recognizes only the exact model-setting ACK", () => {
  const response = (payload) => ({
    url: () => "http://localhost:8877/api/control",
    request: () => ({ method: () => "POST", postData: () => JSON.stringify(payload) }),
  });

  assert.equal(isTestContourModelSettingResponse(response({
    action: "update-setting",
    params: { name: "model", value: "gpt-5.6-luna" },
  }), "gpt-5.6-luna"), true);
  assert.equal(isTestContourModelSettingResponse(response({
    action: "update-setting",
    params: { name: "reasoning", value: "gpt-5.6-luna" },
  }), "gpt-5.6-luna"), false);
});

test("Test Contour smoke ignores old messages containing the expected response", () => {
  const pattern = exactTestContourResponsePattern("Принято");

  assert.equal(pattern.test("Принято"), true);
  assert.equal(pattern.test("  Принято\n"), true);
  assert.equal(pattern.test("Старый ответ: принято и ожидает релиза"), false);
});

test("Test Contour smoke rejects an unavailable requested model", async () => {
  const fixture = smokePage({ availableModels: ["fake-codex"], selectedModel: "fake-codex" });

  await assert.rejects(
    selectTestContourModel(fixture.page, "gpt-5.6-luna", 5_000),
    /model is not selectable: gpt-5\.6-luna/u,
  );
  assert.equal(fixture.events.some(([event]) => event === "model.selectOption"), false);
});
