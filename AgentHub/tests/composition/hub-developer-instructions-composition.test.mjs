import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveHubDeveloperInstructions } from "../../src/composition/hub-developer-instructions-composition.mjs";
import { PreTurnInstructionStore } from "../../src/infrastructure/persistence/pre-turn-instruction-store.mjs";

test("shipped Guide injects the CUA-first and isolated Edge fallback policy into Codex turns", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-guide-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preTurnInstructions = new PreTurnInstructionStore({
    guideFile: path.resolve(import.meta.dirname, "..", "..", "AGENT_HUB_GUIDE.md"),
    globalFile: path.join(directory, "global.md"),
  });
  await preTurnInstructions.loadGuide();

  const result = await resolveHubDeveloperInstructions({
    provider: "codex",
    threadId: "thread-1",
    streamId: "stream-1",
    workspaceCatalogStore: {
      developerRulesForStream: () => ({ workspace: { content: "" }, stream: { content: "" } }),
    },
    preTurnInstructions,
    hubMcpService: { developerContext: () => "<agent_hub_context>token</agent_hub_context>" },
  });

  assert.match(result, /inspect the available browser surfaces and tabs with `cua\.getState\(\)`/u);
  assert.match(result, /use `agent_hub\.hub_browser` as the fallback/u);
  assert.match(result, /one isolated agent-owned Microsoft Edge session/u);
  assert.match(result, /timeout, App Server replacement, or task completion/u);
});

test("Hub developer instructions resolve a first Stream turn for every provider", async () => {
  const contexts = [];
  const result = await resolveHubDeveloperInstructions({
    provider: "claude",
    threadId: null,
    streamId: "stream-1",
    workspaceCatalogStore: {
      developerRulesForStream: (streamId) => ({
        workspace: { content: `Workspace ${streamId}` },
        stream: { content: "Stream rule" },
      }),
    },
    preTurnInstructions: {
      snapshot: async () => ({
        guide: { content: "Guide rule" },
        global: { content: "Global rule" },
      }),
    },
    hubMcpService: {
      developerContext: (context) => {
        contexts.push(context);
        return "MCP context";
      },
    },
  });

  assert.deepEqual(contexts, [{ provider: "claude", threadId: null, streamId: "stream-1" }]);
  assert.match(result, /<agent_hub_guide>\nGuide rule/u);
  assert.match(result, /<global_pre_turn_instructions>\nGlobal rule/u);
  assert.match(result, /<workspace_instructions>\nWorkspace stream-1/u);
  assert.match(result, /<stream_instructions>\nStream rule/u);
  assert.match(result, /MCP context/u);
});

test("Hub developer instructions allow an unbound first provider turn", async () => {
  const result = await resolveHubDeveloperInstructions({
    provider: "claude",
    threadId: null,
    streamId: null,
    workspaceCatalogStore: {
      developerRulesForThread: () => { throw new Error("unbound Thread must not be resolved"); },
    },
    preTurnInstructions: {
      snapshot: async () => ({ guide: { content: "Guide rule" }, global: { content: "" } }),
    },
    hubMcpService: { developerContext: () => "" },
  });

  assert.match(result, /<agent_hub_guide>\nGuide rule/u);
  assert.doesNotMatch(result, /<workspace_instructions>/u);
  assert.doesNotMatch(result, /<stream_instructions>/u);
});

test("Hub developer instructions reject a bound Stream without MCP context", async () => {
  await assert.rejects(
    () => resolveHubDeveloperInstructions({
      provider: "codex",
      threadId: "thread-1",
      streamId: "stream-1",
      workspaceCatalogStore: {
        developerRulesForStream: () => ({ workspace: { content: "" }, stream: { content: "" } }),
      },
      preTurnInstructions: {
        snapshot: async () => ({ guide: { content: "Guide rule" }, global: { content: "" } }),
      },
      hubMcpService: { developerContext: () => "" },
    }),
    /could not inject the current Stream MCP context/u,
  );
});
