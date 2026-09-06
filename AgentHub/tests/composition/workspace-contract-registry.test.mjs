import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("SYS-002 owns the structured preferences and permanent-delete boundaries", async () => {
  const registry = JSON.parse(await readFile(
    path.join(ROOT, "docs", "contracts", "registry.json"),
    "utf8",
  ));
  const contract = registry.contracts.find(({ id }) => id === "SYS-002");
  assert.ok(contract);
  for (const boundary of [
    "src/application/agent-preferences-store.mjs",
    "src/application/run-coordinator.mjs",
    "src/application/workspace-catalog-service.mjs",
    "src/composition/desktop-shell-composition.mjs",
    "src/infrastructure/persistence/workspace-catalog-store.mjs",
    "src/infrastructure/persistence/task-board-store.mjs",
    "src/interfaces/web/mini-app-server.mjs",
  ]) assert.ok(contract.paths.includes(boundary), `SYS-002 does not own ${boundary}`);
});
