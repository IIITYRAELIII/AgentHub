import assert from "node:assert/strict";
import test from "node:test";

import { resolveHubDeveloperInstructions } from "../../src/composition/hub-developer-instructions-composition.mjs";
import { PreTurnInstructionStore } from "../../src/infrastructure/persistence/pre-turn-instruction-store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("generic annotation Guide editor snapshot composes the canonical rule for Codex and Claude",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'hub-guide-'));
  try {
    const store=new PreTurnInstructionStore({guideFile:fileURLToPath(new URL('../../AGENT_HUB_GUIDE.md',import.meta.url)),globalFile:path.join(temp,'global.md')});
    const document=await store.loadGuide();
    const rule='When answering a comment from <response-annotations>, add :agent-annotation{index="N"}, where N is the item\'s 1-based index. This lets the user clearly see which comment you are answering.';
    const closed="Closed Tasks and Tasks at workflow Done are archives. Read their evidence,\nbut do not reactivate or change them without the user's explicit request\nto resume that exact Task. Check current state before acting.\n\nTrack new fixes in a separate Task linked to the archive.\nPreserve the original result and history.";
    assert.ok(document.content.includes(rule)); assert.ok(document.content.includes(closed));
    assert.equal(document.content.includes(':codex-annotation'),false);
    assert.deepEqual((await store.snapshot()).guide,document);
    const copy=store.guide(); copy.content='modified editor copy'; assert.equal(store.guide().content,document.content);
    for(const provider of ['codex','claude']) {
      const result=await resolveHubDeveloperInstructions({provider,threadId:null,streamId:null,
        workspaceCatalogStore:{},preTurnInstructions:store,hubMcpService:{developerContext:()=>''}});
      assert.ok(result.includes('<agent_hub_guide>\n'+document.content));
      assert.equal(result.split(rule).length,2); assert.ok(result.includes(closed));
    }
  } finally {await rm(temp,{recursive:true,force:true});}
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
