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

test("Stream Team Lead tooltip explains independent review governance in Russian", async () => {
  const settings = await roleSettingsApi();
  const text = settings.teamLeadTooltip.join("\n");
  assert.match(text, /независимое ревью.*другому потоку Workspace.*Исполнитель не проверяет собственную работу/iu);
  assert.match(text, /ограничь ревью требованиями Task.*фактическим diff.*последствиями внесённых изменений/iu);
  assert.match(text, /не выполняют её требования.*вызывают или усиливают любую реальную регрессию.*лишнюю функциональность.*удалить/iu);
  assert.match(text, /Старые независимые проблемы.*искусственные крайние случаи.*без воспроизводимых доказательств.*вне scope не блокируют/iu);
  assert.match(text, /верни ту же Task исполнителю.*снова передай исправленный результат на независимое ревью/iu);
  assert.match(text, /максимальный номер.*S<number>.*прибавь 1.*назови новый S2/iu);

  const children = [];
  const container = {
    ownerDocument: {
      createElement: () => ({ textContent: "" }),
    },
    replaceChildren: (...values) => children.push(...values),
  };
  assert.equal(settings.renderTeamLeadTooltip(container), true);
  assert.deepEqual(children.map((item) => item.textContent), [...settings.teamLeadTooltip]);
});
