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

test("Stream Team Lead is an independent persisted boolean", async () => {
  const settings = await roleSettingsApi();

  assert.equal(settings.teamLeadEnabled({ teamLead: true }), true);
  assert.equal(settings.teamLeadEnabled({ teamLead: false }), false);
  assert.equal(settings.teamLeadEnabled({ role: "team-lead" }), false);
  assert.deepEqual(
    { ...settings.withTeamLead({ provider: "codex", architect: true }, true) },
    { provider: "codex", architect: true, teamLead: true },
  );
  assert.deepEqual(
    { ...settings.withTeamLead({ provider: "claude", teamLead: true }, false) },
    { provider: "claude", teamLead: false },
  );
});

test("Stream Team Lead tooltip replaces stale paragraphs without duplication", async () => {
  const settings = await roleSettingsApi();

  let children = [{ textContent: "Stale tooltip" }];
  const container = {
    ownerDocument: {
      createElement: (tagName) => ({ tagName, textContent: "" }),
    },
    replaceChildren: (...values) => { children = values; },
  };
  assert.ok(settings.teamLeadTooltip.length > 0);
  assert.equal(settings.renderTeamLeadTooltip(container), true);
  assert.deepEqual(children.map((item) => item.textContent), [...settings.teamLeadTooltip]);
  assert.ok(children.every((item) => item.tagName === "p"));
  assert.equal(settings.renderTeamLeadTooltip(container), true);
  assert.deepEqual(children.map((item) => item.textContent), [...settings.teamLeadTooltip]);
});
