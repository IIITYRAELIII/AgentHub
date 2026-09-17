import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createCodexContextMaintenanceComposition } from "../../src/composition/codex-context-maintenance-composition.mjs";
import { createHubStaticSettings } from "../../src/composition/hub-static-settings.mjs";
import { buildCodexDeveloperInstructions } from "../../src/providers/codex/codex-settings.mjs";

for (const [model, expected] of [
  ["GPT-5.6-Sol", "gpt-5.6-sol"],
  ["gpt-5.6-sol", "gpt-5.6-sol"],
  ["  GPT-5.6-Sol  ", "gpt-5.6-sol"],
  ["GPT-6-Astra", "gpt-6-astra"],
  ["gpt-6-astra", "gpt-6-astra"],
  [undefined, undefined],
]) {
  test(`rotation sends the canonical configured model for ${model ?? "an unspecified model"}`, async () => {
    const projectRoot = path.resolve("rotation-fixture");
    const config = {
      codexModels: [
        { value: "gpt-6-astra", label: "GPT-6-Astra" },
        { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      ],
      codexModel: "gpt-6-astra",
      codexSandboxMode: "workspace-write",
      projects: [],
      projectRoot,
      dataDir: path.join(projectRoot, "data"),
    };
    const { normalizeCodexModel } = createHubStaticSettings(config, projectRoot);
    const calls = [];
    const rawItem = { type: "compaction", encrypted_content: "opaque-compaction" };
    const service = createCodexContextMaintenanceComposition({
      config,
      normalizeCodexModel,
      transportRunning: () => true,
    readThread: async (threadId) => {
      assert.equal(threadId, "rotated-thread");
      return { thread: { id: threadId, status: { type: "idle" } } };
    },
      contextCompactions: {
        get: () => ({ id: "compact-source", status: "completed" }),
        waitForRawItem: async () => rawItem,
        clearRawItem: () => {},
      },
      sendRpc: async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "rotated-thread" } };
        return {};
      },
    });

    const result = await service.rotateCompacted({
      provider: "codex", threadId: "source-thread", model,
    }, {
      compactionId: "compact-source",
      source: { thread: { cwd: projectRoot, modelProvider: "openai", path: "unused-rollout" } },
    });

    assert.equal(result.thread.id, "rotated-thread");
    assert.deepEqual(calls, [{
      method: "thread/start",
      params: {
        cwd: projectRoot,
        ...(expected ? { model: expected } : {}),
        modelProvider: "openai",
        allowProviderModelFallback: true,
        ephemeral: false,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    }, {
      method: "thread/inject_items",
      params: { threadId: "rotated-thread", items: [rawItem] },
    }]);
  });
}

test("rotation preserves raw replacement history without launching an extra turn", async () => {
  const projectRoot = path.resolve("probe-rotation-fixture");
  const calls = [];
  const ordinaryInstructions = buildCodexDeveloperInstructions({ guide: "Guide" });
  const replacementHistory = [
    { role: "developer", content: "old probe-only instruction" },
    { role: "user", content: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1" },
    { role: "assistant", content: "AGENT_HUB_CONTEXT_PROBE_OK_V1" },
    { role: "developer", content: ordinaryInstructions },
    { role: "user", content: "Продолжай рабочую задачу" },
  ];
  const rawItem = { type: "compaction", replacement_history: replacementHistory };
  assert.doesNotMatch(ordinaryInstructions, /AGENT_HUB_CONTEXT_PROBE/u);
  const service = createCodexContextMaintenanceComposition({
    config: {
      codexSandboxMode: "workspace-write",
      projects: [],
      projectRoot,
      dataDir: path.join(projectRoot, "data"),
    },
    normalizeCodexModel: (value) => value,
    transportRunning: () => true,
    readThread: async (threadId) => {
      assert.equal(threadId, "rotated-thread");
      return { thread: { id: threadId, status: { type: "idle" } } };
    },
    contextCompactions: {
      get: () => ({ id: "compact-source", status: "completed" }),
      waitForRawItem: async () => rawItem,
      clearRawItem: () => {},
    },
    sendRpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "rotated-thread" } };
      return {};
    },
  });

  await service.rotateCompacted({
    provider: "codex",
    threadId: "source-thread",
    workingDirectory: projectRoot,
  }, {
    compactionId: "compact-source",
    source: { thread: { cwd: projectRoot } },
  });

  assert.equal(calls.some((call) => call.method === "turn/start"), false);
  assert.deepEqual(
    calls.find((call) => call.method === "thread/inject_items")?.params.items,
    [rawItem],
  );
});
