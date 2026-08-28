import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function roleSettingsApi() {
  const source = await readFile(
    new URL("../../assets/web-app/stream-role-settings.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubStreamRoleSettings;
}

test("Stream Architect is an independent persisted boolean", async () => {
  const settings = await roleSettingsApi();

  assert.equal(settings.architectEnabled({ architect: true }), true);
  assert.equal(settings.architectEnabled({ architect: false }), false);
  assert.equal(settings.architectEnabled({ releaseRole: "architect" }), false);
  assert.deepEqual(
    { ...settings.withArchitect({ provider: "codex", model: "gpt-5.6" }, true) },
    { provider: "codex", model: "gpt-5.6", architect: true },
  );
  assert.deepEqual(
    { ...settings.withArchitect({ provider: "claude", architect: true }, false) },
    { provider: "claude", architect: false },
  );
});
