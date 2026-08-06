import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("./src/composition/agent-hub-composition.mjs", import.meta.url);
const OWNER = new URL("./src/composition/client-runtime-composition.mjs", import.meta.url);

test("client runtime phase owns clients, restoration and Codex lifecycle assembly", async () => {
  const [root, owner] = await Promise.all([
    readFile(ROOT, "utf8"),
    readFile(OWNER, "utf8"),
  ]);
  for (const factory of [
    "createClientInterfaceComposition",
    "createDeliveryOutboxComposition",
    "createTaskStateWiring",
    "createRuntimeFacadesComposition",
    "createRuntimeStateBootstrapWiring",
    "createStatePersistenceComposition",
    "createCodexLifecycleComposition",
    "createCodexTaskSettingsComposition",
    "createRuntimeCommandRoutingComposition",
  ]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(owner.includes(factory), true, `${factory} is not owned by client runtime phase`);
  }
  assert.equal(root.includes("createClientRuntimeComposition"), true);
  assert.equal(owner.indexOf("ports.deferredInputPresentation.bind(")
    < owner.indexOf("createRuntimeStateBootstrapWiring("), true);
});
