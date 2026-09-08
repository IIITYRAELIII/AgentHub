import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createCodexContextMaintenanceComposition } from "../../src/composition/codex-context-maintenance-composition.mjs";
import { createHubStaticSettings } from "../../src/composition/hub-static-settings.mjs";

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
