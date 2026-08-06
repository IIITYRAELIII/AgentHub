import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../src/composition/agent-hub-composition.mjs", import.meta.url);
const OWNER = new URL("../../src/composition/execution-bootstrap-phase-composition.mjs", import.meta.url);

test("execution phase owns orchestration, Telegram and bootstrap assembly", async () => {
  const [root, owner] = await Promise.all([readFile(ROOT, "utf8"), readFile(OWNER, "utf8")]);
  for (const factory of [
    "createRuntimeOrchestrationComposition",
    "createTelegramRuntimeComposition",
    "createAgentHubBootstrapComposition",
  ]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(owner.includes(factory), true, `${factory} is not owned by execution phase`);
  }
  assert.equal(root.includes("createExecutionBootstrapPhase"), true);
  assert.equal(owner.indexOf("createRuntimeOrchestrationComposition(")
    < owner.indexOf("createTelegramRuntimeComposition("), true);
  assert.equal(owner.indexOf("createTelegramRuntimeComposition(")
    < owner.indexOf("createAgentHubBootstrapComposition("), true);
  assert.equal(owner.includes("ports.bootstrap.bind(bootstrap)"), true);
});
