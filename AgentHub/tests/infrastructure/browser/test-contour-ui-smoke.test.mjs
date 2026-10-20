import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertTestContourShellContent,
  exactTestContourResponsePattern,
  isTestContourModelSettingResponse,
  locateTestContourResponse,
  observeTestContourSend,
  planTestContourSmokeConversation,
  prepareTestContourSmokeConversation,
  reconcileTestContourSend,
  requestTestContourControl,
  runTestContourUiSmoke,
  selectTestContourConversation,
  selectTestContourModel,
  TEST_CONTOUR_PROBE,
} from "../../../src/infrastructure/browser/test-contour-ui-smoke.mjs";

test("Test Contour shell requires the desktop Диалоги label and meaningful body content", () => {
  const currentShell = `Agent Hub Workspace Диалоги ${"Содержимое ".repeat(10)}`;
  assert.doesNotThrow(() => assertTestContourShellContent(currentShell));
  assert.throws(
    () => assertTestContourShellContent(currentShell.replace("Диалоги", "Потоки")),
    /Agent Hub shell did not render meaningful content/u,
  );
  assert.throws(
    () => assertTestContourShellContent("Agent Hub Workspace ".repeat(10)),
    /Agent Hub shell did not render meaningful content/u,
  );
  assert.throws(
    () => assertTestContourShellContent("Диалоги"),
    /Agent Hub shell did not render meaningful content/u,
  );
});

test("Test Contour shell retains the trimmed 100-character minimum", () => {
  const minimumShell = "Диалоги".padEnd(100, "x");
  assert.doesNotThrow(() => assertTestContourShellContent(`  ${minimumShell}\n`));
  assert.throws(
    () => assertTestContourShellContent(`  ${minimumShell.slice(0, -1)}\n`),
    /Agent Hub shell did not render meaningful content/u,
  );
});

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
    version: 2,
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
  assert.equal(planTestContourSmokeConversation(current, { ...saved(), version: 1 }, "fake-codex").kind, "reuse");
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
      if (!request.action) {
        const durable = JSON.parse(await readFile(path.join(root, "ui-smoke-conversation.json"), "utf8"));
        assert.equal(durable.operation.phase, "accepted", "local terminal identity precedes receipt retirement");
        calls.push(["ack", request.commandId]);
        return { ok: true, status: 200, payload: { ok: true, retired: true } };
      }
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
    assert.deepEqual(calls.filter(([action]) => action === "ack"), [["ack", "setup-command"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Test Contour smoke keeps setup intent when direct or recovered receipts are not exact", async () => {
  for (const scenario of [
    { name: "direct wrong receipt", persisted: false, receiptId: "wrong-command" },
    { name: "recovered missing receipt", persisted: true, receiptId: null },
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-smoke-setup-receipt-"));
    const stateFile = path.join(root, "ui-smoke-conversation.json");
    const operation = {
      action: "new-task",
      commandId: "setup-original",
      phase: "prepared",
      params: {
        workspaceName: "Agent Hub Test Contour Smoke",
        streamName: "Smoke",
        provider: "codex",
        settings: { provider: "codex", model: "fake-codex" },
      },
    };
    if (scenario.persisted) {
      await writeFile(stateFile, `${JSON.stringify({ version: 2, operation })}\n`, "utf8");
    }
    let acknowledgements = 0;
    const page = {
      async evaluate(_callback, request) {
        if (!request.action) {
          acknowledgements += 1;
          return { ok: true, status: 200, payload: { ok: true, retired: true } };
        }
        if (request.action === "snapshot") return browserControlResult({ workspaces: [] });
        assert.equal(request.commandId, "setup-original", scenario.name);
        return browserControlResult({
          ...snapshot({ streams: [stream("stream-smoke", [thread("thread-smoke")])] }),
          createdTask: {
            workspaceId: "workspace-1",
            streamId: "stream-smoke",
            provider: "codex",
            threadId: "thread-smoke",
          },
        }, { receiptId: scenario.receiptId });
      },
    };
    try {
      await assert.rejects(prepareTestContourSmokeConversation(page, {
        artifactsDirectory: root,
        model: "fake-codex",
        timeoutMs: 5_000,
        commandIdFactory: () => scenario.persisted ? assert.fail("must reuse persisted command") : "setup-original",
      }), /invalid receipt/u, scenario.name);
      assert.equal(acknowledgements, 0, scenario.name);
      const durable = JSON.parse(await readFile(stateFile, "utf8"));
      assert.equal(durable.operation.commandId, "setup-original", scenario.name);
      assert.equal(durable.operation.phase, "prepared", scenario.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Test Contour smoke rejects created targets outside the requested thread or Stream scope", async () => {
  const scenarios = [
    {
      name: "create-thread changed Stream",
      persisted: saved(),
      current: snapshot({ streams: [stream("stream-smoke", [thread("thread-old", { detachedAtMs: 1 })])] }),
      createdTask: {
        workspaceId: "workspace-1", streamId: "stream-other", provider: "codex", threadId: "thread-new",
      },
    },
    {
      name: "create-stream changed Workspace",
      persisted: saved(),
      current: snapshot({ streams: [] }),
      createdTask: {
        workspaceId: "workspace-other", streamId: "stream-new", provider: "codex", threadId: "thread-new",
      },
    },
  ];
  for (const scenario of scenarios) {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-smoke-setup-target-"));
    const stateFile = path.join(root, "ui-smoke-conversation.json");
    await writeFile(stateFile, `${JSON.stringify(scenario.persisted)}\n`, "utf8");
    let acknowledgements = 0;
    const page = {
      async evaluate(_callback, request) {
        if (!request.action) {
          acknowledgements += 1;
          return { ok: true, status: 200, payload: { ok: true, retired: true } };
        }
        if (request.action === "snapshot") return browserControlResult(scenario.current);
        return browserControlResult({
          ...snapshot({
            workspaceId: scenario.createdTask.workspaceId,
            streams: [stream(scenario.createdTask.streamId, [thread(scenario.createdTask.threadId)])],
          }),
          createdTask: scenario.createdTask,
        }, { receiptId: "setup-scope" });
      },
    };
    try {
      await assert.rejects(prepareTestContourSmokeConversation(page, {
        artifactsDirectory: root,
        model: "fake-codex",
        timeoutMs: 5_000,
        commandIdFactory: () => "setup-scope",
      }), /invalid target/u, scenario.name);
      assert.equal(acknowledgements, 0, scenario.name);
      const durable = JSON.parse(await readFile(stateFile, "utf8"));
      assert.equal(durable.operation.phase, "prepared", scenario.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Test Contour smoke reconciles an unknown setup with its original durable command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-smoke-setup-reconcile-"));
  const createdSnapshot = snapshot({ streams: [stream("stream-smoke", [thread("thread-smoke")])] });
  const setupIds = [];
  let current = { workspaces: [] };
  let durableResult = null;
  let effectCount = 0;
  let loseFirstResponse = true;
  const page = {
    async evaluate(_callback, request) {
      if (!request.action) return { ok: true, status: 200, payload: { ok: true, retired: true } };
      if (request.action === "snapshot") return browserControlResult(current);
      assert.equal(request.action, "new-task");
      setupIds.push(request.commandId);
      if (!durableResult) {
        effectCount += 1;
        current = createdSnapshot;
        durableResult = {
          ...createdSnapshot,
          createdTask: {
            workspaceId: "workspace-1",
            streamId: "stream-smoke",
            provider: "codex",
            threadId: "thread-smoke",
          },
        };
      }
      if (loseFirstResponse) {
        loseFirstResponse = false;
        return { kind: "unknown", error: "connection closed after durable effect" };
      }
      return browserControlResult(durableResult, { receiptId: request.commandId });
    },
    async reload() {},
    locator(selector) {
      if (selector === "[data-workspace]") return { async waitFor() {} };
      if (selector.includes("data-workspace-select")) return { async waitFor() {}, async click() {} };
      return {
        async waitFor() {},
        async getAttribute() { return "stream-smoke"; },
        async click() {},
      };
    },
  };
  try {
    await assert.rejects(prepareTestContourSmokeConversation(page, {
      artifactsDirectory: root,
      model: "fake-codex",
      timeoutMs: 5_000,
      commandIdFactory: () => "setup-original",
    }), /outcome is unknown; command setup-original was not retried/u);

    const recovered = await prepareTestContourSmokeConversation(page, {
      artifactsDirectory: root,
      model: "fake-codex",
      timeoutMs: 5_000,
      commandIdFactory: () => "must-not-run",
    });

    assert.equal(recovered.setup, "reconcile-new-task");
    assert.deepEqual(setupIds, ["setup-original", "setup-original"]);
    assert.equal(effectCount, 1, "durable owner returns the original receipt without a second effect");
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "ui-smoke-conversation.json"), "utf8")), saved());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Test Contour smoke reconciles an unknown send without a new click or message identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-smoke-send-reconcile-"));
  const stateFile = path.join(root, "ui-smoke-conversation.json");
  const operation = {
    action: "send-message",
    commandId: "send-original",
    phase: "prepared",
    params: {
      text: "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1",
      streamId: "stream-smoke",
      provider: "codex",
      threadId: "thread-smoke",
      clientUserMessageId: "client-original",
    },
  };
  await writeFile(stateFile, `${JSON.stringify({ ...saved(), operation }, null, 2)}\n`, "utf8");
  let current = snapshot({ streams: [stream("stream-smoke", [thread("thread-smoke")])] });
  const accepted = {
    accepted: true,
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    clientUserMessageId: "client-original",
    turnId: "turn-original",
  };
  let effectCount = 1;
  let sendReadbacks = 0;
  const page = {
    async evaluate(_callback, request) {
      if (!request.action) return { ok: true, status: 200, payload: { ok: true, retired: true } };
      if (request.action === "snapshot") return browserControlResult(current);
      assert.equal(request.action, "send-message");
      assert.equal(request.commandId, "send-original");
      sendReadbacks += 1;
      return browserControlResult(accepted, { receiptId: "send-original" });
    },
    locator(selector) {
      if (selector.includes("data-workspace-select")) return { async waitFor() {}, async click() {} };
      return {
        async waitFor() {},
        async getAttribute() { return "stream-smoke"; },
        async click() {},
      };
    },
  };
  try {
    const conversation = await prepareTestContourSmokeConversation(page, {
      artifactsDirectory: root,
      model: "fake-codex",
      timeoutMs: 5_000,
      commandIdFactory: () => "must-not-run",
    });
    assert.equal(conversation.setup, "reconcile-send");
    const result = await reconcileTestContourSend(page, {
      operation: conversation.pendingSend,
      identity: conversation.identity,
      stateFile,
      timeoutMs: 5_000,
    });

    assert.equal(result.commandId, "send-original");
    assert.equal(result.turnId, "turn-original");
    assert.equal(sendReadbacks, 1);
    assert.equal(effectCount, 1, "durable owner returns the original receipt without a second effect");
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), saved());

    await writeFile(stateFile, `${JSON.stringify({
      ...saved(),
      operation: { ...operation, phase: "accepted", accepted: result },
    }, null, 2)}\n`, "utf8");
    current = snapshot({ streams: [stream("stream-smoke", [thread("thread-smoke", { detachedAtMs: 123 })])] });
    const acceptedConversation = await prepareTestContourSmokeConversation(page, {
      artifactsDirectory: root,
      model: "fake-codex",
      timeoutMs: 5_000,
    });
    sendReadbacks = 0;
    await reconcileTestContourSend(page, {
      operation: acceptedConversation.pendingSend,
      identity: acceptedConversation.identity,
      stateFile,
      timeoutMs: 5_000,
    });
    assert.equal(sendReadbacks, 0, "a locally accepted terminal survives later Thread detachment and only finishes acknowledgement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Test Contour smoke fails closed on a corrupt durable operation before any control request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-smoke-corrupt-operation-"));
  await writeFile(path.join(root, "ui-smoke-conversation.json"), `${JSON.stringify({
    ...saved(),
    operation: {
      action: "send-message",
      commandId: "send-corrupt",
      phase: "prepared",
      params: { text: TEST_CONTOUR_PROBE, provider: "codex" },
    },
  })}\n`, "utf8");
  let requests = 0;
  try {
    await assert.rejects(prepareTestContourSmokeConversation({
      async evaluate() { requests += 1; },
    }, {
      artifactsDirectory: root,
      model: "fake-codex",
      timeoutMs: 5_000,
    }), /invalid durable operation/u);
    assert.equal(requests, 0);
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

test("Test Contour smoke waits for the exact durable turn after a queued admission ACK", async () => {
  const params = {
    text: TEST_CONTOUR_PROBE,
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    clientUserMessageId: "client-message-queued",
  };
  const request = controlRequest({ params, commandId: "send-command-queued" });
  const response = controlResponse(request, {
    payload: {
      ok: true,
      receiptId: "send-command-queued",
      result: {
        accepted: true,
        deferred: true,
        queued: true,
        id: "durable-input-1",
        streamId: "stream-smoke",
        provider: "codex",
        threadId: "thread-smoke",
        clientUserMessageId: "client-message-queued",
        turnId: null,
      },
    },
  });
  const snapshots = [
    {
      messageReceipts: [{
        accepted: true,
        deferred: true,
        queued: true,
        streamId: "stream-smoke",
        provider: "codex",
        threadId: "thread-smoke",
        clientUserMessageId: "client-message-queued",
        turnId: null,
      }],
    },
    {
      messageReceipts: [{
        accepted: true,
        deferred: false,
        queued: false,
        streamId: "stream-smoke",
        provider: "codex",
        threadId: "thread-smoke",
        clientUserMessageId: "client-message-queued",
        turnId: "turn-queued",
      }],
    },
  ];
  let snapshotReads = 0;
  let clicks = 0;
  const page = {
    async waitForRequest(predicate) { assert.equal(predicate(request), true); return request; },
    async waitForResponse(predicate) { assert.equal(predicate(response), true); return response; },
    async evaluate(_callback, control) {
      assert.equal(control.action, "snapshot");
      const result = snapshots[Math.min(snapshotReads, snapshots.length - 1)];
      snapshotReads += 1;
      return browserControlResult(result);
    },
    async waitForTimeout() {},
  };

  const result = await observeTestContourSend(page, {
    identity: saved(),
    timeoutMs: 5_000,
    click: async () => { clicks += 1; },
  });

  assert.equal(clicks, 1);
  assert.equal(snapshotReads, 2);
  assert.deepEqual(result, {
    commandId: "send-command-queued",
    clientUserMessageId: "client-message-queued",
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    turnId: "turn-queued",
  });
});

test("Test Contour smoke persists the UI send intent and terminal before releasing its receipt", async () => {
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
  const events = [];
  let routeHandler = null;
  let resolveResponse;
  const page = {
    async route(pattern, handler) {
      events.push(["route", pattern]);
      routeHandler = handler;
    },
    async unroute(pattern, handler) {
      assert.equal(handler, routeHandler);
      events.push(["unroute", pattern]);
      routeHandler = null;
    },
    async waitForResponse(predicate) {
      assert.equal(predicate(response), true);
      return new Promise((resolve) => { resolveResponse = resolve; });
    },
  };
  const click = async () => {
    const handler = routeHandler;
    assert.ok(handler);
    await handler({
      request: () => request,
      async continue() {
        events.push(["effect"]);
        resolveResponse(response);
      },
      async abort() { events.push(["abort"]); },
    });
  };

  const result = await observeTestContourSend(page, {
    identity: saved(),
    timeoutMs: 5_000,
    click,
    async persistPrepared(operation) { events.push(["prepared", operation.commandId]); },
    async persistAccepted(operation) { events.push(["accepted", operation.accepted.turnId]); },
    async acknowledgeAccepted(commandId) { events.push(["ack", commandId]); },
    async persistSettled() { events.push(["settled"]); },
  });

  assert.equal(result.turnId, "turn-1");
  assert.deepEqual(events.map(([event]) => event), [
    "route", "prepared", "effect", "accepted", "unroute", "ack", "settled",
  ]);
});

test("Test Contour smoke rejects missing or mismatched authoritative send evidence", async () => {
  const params = {
    text: "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1",
    streamId: "stream-smoke",
    provider: "codex",
    threadId: "thread-smoke",
    clientUserMessageId: "client-message-1",
  };
  for (const scenario of [
    { name: "wrong receipt", receiptId: "other-command" },
    { name: "missing client message", remove: "clientUserMessageId" },
    { name: "wrong client message", clientUserMessageId: "other-client" },
    { name: "missing Stream", remove: "streamId" },
    { name: "wrong Stream", streamId: "other-stream" },
    { name: "missing provider", remove: "provider" },
    { name: "wrong provider", provider: "claude" },
    { name: "missing Thread", remove: "threadId" },
    { name: "wrong Thread", threadId: "other-thread" },
    { name: "missing turn", remove: "turnId" },
  ]) {
    const result = {
      accepted: true,
      streamId: "stream-smoke",
      provider: "codex",
      threadId: "thread-smoke",
      clientUserMessageId: "client-message-1",
      turnId: "turn-1",
    };
    if (scenario.remove) delete result[scenario.remove];
    for (const key of ["streamId", "provider", "threadId", "clientUserMessageId"]) {
      if (scenario[key]) result[key] = scenario[key];
    }
    const request = controlRequest({ params, commandId: "send-command-1" });
    const response = controlResponse(request, {
      payload: {
        ok: true,
        receiptId: scenario.receiptId ?? "send-command-1",
        result,
      },
    });
    let acceptedWrites = 0;
    let acknowledgements = 0;
    let settledWrites = 0;
    const page = {
      async waitForRequest(predicate) { assert.equal(predicate(request), true); return request; },
      async waitForResponse(predicate) { assert.equal(predicate(response), true); return response; },
    };
    await assert.rejects(observeTestContourSend(page, {
      identity: saved(),
      timeoutMs: 5_000,
      click: async () => {},
      async persistAccepted() { acceptedWrites += 1; },
      async acknowledgeAccepted() { acknowledgements += 1; },
      async persistSettled() { settledWrites += 1; },
    }), /invalid acceptance/u, scenario.name);
    assert.deepEqual([acceptedWrites, acknowledgements, settledWrites], [0, 0, 0], scenario.name);
  }
});

test("Test Contour smoke recovery preserves prepared send intent when authoritative evidence is incomplete", async () => {
  const invalidResults = [
    ["missing client message", "clientUserMessageId", null],
    ["wrong client message", "clientUserMessageId", "other-client"],
    ["missing Stream", "streamId", null],
    ["wrong Stream", "streamId", "other-stream"],
    ["missing provider", "provider", null],
    ["wrong provider", "provider", "claude"],
    ["missing Thread", "threadId", null],
    ["wrong Thread", "threadId", "other-thread"],
    ["missing turn", "turnId", null],
  ];
  for (const [name, field, value] of invalidResults) {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-smoke-send-evidence-"));
    const stateFile = path.join(root, "ui-smoke-conversation.json");
    const operation = {
      action: "send-message",
      commandId: "send-original",
      phase: "prepared",
      params: {
        text: TEST_CONTOUR_PROBE,
        streamId: "stream-smoke",
        provider: "codex",
        threadId: "thread-smoke",
        clientUserMessageId: "client-original",
      },
    };
    await writeFile(stateFile, `${JSON.stringify({ ...saved(), operation })}\n`, "utf8");
    const result = {
      accepted: true,
      streamId: "stream-smoke",
      provider: "codex",
      threadId: "thread-smoke",
      clientUserMessageId: "client-original",
      turnId: "turn-original",
    };
    if (value == null) delete result[field];
    else result[field] = value;
    let acknowledgements = 0;
    const page = {
      async evaluate(_callback, request) {
        if (!request.action) {
          acknowledgements += 1;
          return { ok: true, status: 200, payload: { ok: true, retired: true } };
        }
        assert.equal(request.action, "send-message", name);
        assert.equal(request.commandId, "send-original", name);
        return browserControlResult(result, { receiptId: "send-original" });
      },
    };
    try {
      await assert.rejects(reconcileTestContourSend(page, {
        operation,
        identity: saved(),
        stateFile,
        timeoutMs: 5_000,
      }), /invalid acceptance/u, name);
      assert.equal(acknowledgements, 0, name);
      assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), { ...saved(), operation }, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
