import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../src/composition/agent-hub-composition.mjs", import.meta.url);
const OWNER = new URL("../../src/composition/interaction-shell-phase-composition.mjs", import.meta.url);

test("interaction phase owns server, Desktop and run shell assembly", async () => {
  const [root, owner] = await Promise.all([readFile(ROOT, "utf8"), readFile(OWNER, "utf8")]);
  for (const factory of [
    "createServerControlComposition",
    "createDesktopShellComposition",
    "createRunShellComposition",
  ]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(owner.includes(factory), true, `${factory} is not owned by interaction phase`);
  }
  assert.equal(root.includes("createInteractionShellPhase"), true);
  assert.match(root, /infrastructure:\s*\{[\s\S]*workspaceCatalogStore,[\s\S]*\},\s*provider: providerApplication/u);
  assert.match(owner, /workspaceCatalogStore: infrastructure\.workspaceCatalogStore/u);
  assert.equal(owner.includes("desktopCommandsPort: ports.desktopCommands"), true);
  assert.equal(owner.includes("runShell: ports.runShell"), true);
});
