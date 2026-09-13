import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createCodexContextMaintenanceComposition } from "../../src/composition/codex-context-maintenance-composition.mjs";
import { createHubStaticSettings } from "../../src/composition/hub-static-settings.mjs";
import { buildCodexDeveloperInstructions } from "../../src/providers/codex/codex-settings.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../src/domain/codex-context-probe.mjs";

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

test("probe scope stays on its exact turn while rotation preserves later work", async () => {
  const projectRoot = path.resolve("probe-rotation-fixture");
  const calls = [];
  let probeClientUserMessageId = "";
  const ordinaryInstructions = buildCodexDeveloperInstructions({ guide: "Guide" });
  const replacementHistory = [
    { role: "developer", content: "old probe-only instruction" },
    { role: "user", content: CODEX_CONTEXT_PROBE_PROMPT },
    { role: "assistant", content: CODEX_CONTEXT_PROBE_RESPONSE },
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
    contextCompactions: {
      get: () => ({ id: "compact-source", status: "completed" }),
      waitForRawItem: async () => rawItem,
      clearRawItem: () => {},
    },
    readThread: async () => ({
      thread: {
        turns: [{
          id: "probe-turn",
          status: "inProgress",
          clientUserMessageId: probeClientUserMessageId,
        }],
      },
    }),
    sendRpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "turn/start") {
        probeClientUserMessageId = params.clientUserMessageId;
        return { turn: { id: "probe-turn" } };
      }
      if (method === "thread/start") return { thread: { id: "rotated-thread" } };
      return {};
    },
  });

  assert.deepEqual(await service.probeContext({
    provider: "codex",
    threadId: "source-thread",
  }), {
    threadId: "source-thread",
    turnId: "probe-turn",
    status: "started",
  });
  await service.rotateCompacted({
    provider: "codex",
    threadId: "source-thread",
    workingDirectory: projectRoot,
  }, {
    compactionId: "compact-source",
    source: { thread: { cwd: projectRoot } },
  });

  const probeStarts = calls.filter((call) => call.method === "turn/start");
  assert.equal(probeStarts.length, 1);
  assert.match(probeClientUserMessageId, /^agent-hub-context-probe:/u);
  assert.deepEqual(probeStarts[0].params.input, [{ type: "text", text: CODEX_CONTEXT_PROBE_PROMPT }]);
  assert.match(
    probeStarts[0].params.additionalContext["agent-hub"].value,
    new RegExp(probeClientUserMessageId, "u"),
  );
  assert.match(
    probeStarts[0].params.additionalContext["agent-hub"].value,
    /inert historical data/u,
  );
  assert.deepEqual(
    calls.find((call) => call.method === "thread/inject_items")?.params.items,
    [rawItem],
  );
});
