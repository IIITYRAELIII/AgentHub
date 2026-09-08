import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "contract-registry-cli.mjs");

function affected(file) {
  return execFileSync(process.execPath, [cli, "affected", file], {
    cwd: root,
    encoding: "utf8",
  }).trim().split(/\r?\n/u).filter(Boolean).map((line) => line.split("\t", 1)[0]);
}

test("message projection owners map to their exact affected contracts", () => {
  assert.ok(affected("src/interfaces/desktop/desktop-task-history.mjs").includes("UI-001"));
  assert.ok(affected("src/interfaces/desktop/desktop-snapshot.mjs").includes("UI-001"));
  assert.ok(affected("src/infrastructure/persistence/task-sync-store.mjs").includes("TURN-001"));
  assert.ok(affected("src/interfaces/telegram/task-view-controller.mjs").includes("TURN-001"));
  assert.deepEqual(
    ["MSG-001", "TURN-001", "UI-001"].every((id) => (
      affected("src/providers/codex/codex-task-snapshot-service.mjs").includes(id)
    )),
    true,
  );
  assert.deepEqual(
    ["MSG-001", "TURN-001", "UI-001"].every((id) => (
      affected("src/application/task-history.mjs").includes(id)
    )),
    true,
  );
});

test("the canonical token-cost owner maps to usage attribution", () => {
  assert.ok(affected("src/domain/token-usage.mjs").includes("USG-001"));
});

test("the accounting history boundaries map to usage attribution", () => {
  for (const boundary of [
    "src/interfaces/desktop/desktop-system-service.mjs",
    "assets/web-app/app.js",
    "assets/web-app/hub-client.js",
  ]) assert.ok(affected(boundary).includes("USG-001"), `USG-001 does not own ${boundary}`);
});
