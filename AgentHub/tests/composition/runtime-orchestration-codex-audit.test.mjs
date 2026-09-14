import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

test("runtime orchestration keeps Codex terminal audit enabled", async () => {
  const source = await readFile(
    path.join(repositoryRoot, "AgentHub", "src", "composition", "runtime-orchestration-composition.mjs"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /terminalAuditEnabled\s*:\s*false/u,
    "Codex terminal audit must not be disabled in runtime orchestration",
  );
  const application = await readFile(
    path.join(repositoryRoot, "AgentHub", "src", "composition", "provider-application-composition.mjs"),
    "utf8",
  );
  const observability = await readFile(
    path.join(repositoryRoot, "AgentHub", "src", "composition", "codex-observability-composition.mjs"),
    "utf8",
  );
  assert.match(application, /taskRuns\.values\(\)\.some\(taskRunIsActive\)/u);
  assert.match(application, /runtimeData\.deferredInputs\.size === 0/u);
  assert.match(observability, /persistProgress: saveState/u);
});
