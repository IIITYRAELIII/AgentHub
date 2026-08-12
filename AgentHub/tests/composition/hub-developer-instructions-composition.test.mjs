import assert from "node:assert/strict";
import test from "node:test";

import { resolveHubDeveloperInstructions } from "../../src/composition/hub-developer-instructions-composition.mjs";

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
