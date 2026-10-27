import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function fixture(initial = {}) {
  const window = {};
  vm.runInNewContext(await readFile(new URL("../../assets/web-app/theme-preference.js", import.meta.url), "utf8"), { window });
  const api = window.AgentHubThemePreference;
  const values = new Map(Object.entries(initial));
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const applied = [];
  const boot = (options = {}) => api.initialize({
    storage: () => storage, catalog: [{ id: "nexus" }, { id: "orbit" }, { id: "orange" }],
    apply: (theme) => applied.push(theme), ...options,
  });
  return { api, values, storage, applied, boot };
}

test("an old choice migrates once; subsequent boots and future upgrades retain manual choices", async () => {
  const f = await fixture({ "agent-hub-theme": "orange", "unrelated-setting": "keep" });
  assert.equal(f.boot().migration, "completed");
  assert.equal(f.applied.at(-1), "nexus");
  assert.equal(f.values.get(f.api.STORAGE_KEY), "nexus");
  assert.equal(f.values.get(f.api.NEXUS_MIGRATION_KEY), "done");
  assert.equal(f.boot().migration, "unchanged");
  f.storage.setItem(f.api.STORAGE_KEY, "orbit");
  // A fresh execution context models a later release; no release number is input.
  const future = await fixture(Object.fromEntries(f.values));
  assert.equal(future.boot().migration, "unchanged");
  assert.equal(future.applied.at(-1), "orbit");
  assert.equal(future.values.get("unrelated-setting"), "keep");
});

test("skipped releases and clean installations execute the same permanent migration", async () => {
  for (const saved of [null, "orbit", "removed-old-theme"]) {
    const f = await fixture(saved ? { "agent-hub-theme": saved } : {});
    assert.equal(f.boot().migration, "completed");
    assert.equal(f.applied.at(-1), "nexus");
  }
});

test("a catalog without Nexus preserves selection and leaves migration available", async () => {
  const f = await fixture({ "agent-hub-theme": "legacy-orange" });
  f.boot({ catalog: [{ id: "orbit" }, { id: "orange" }], aliases: { "legacy-orange": "orange" } });
  assert.equal(f.applied.at(-1), "orange");
  assert.equal(f.values.has(f.api.NEXUS_MIGRATION_KEY), false);
  assert.equal(f.boot().migration, "completed");
  assert.equal(f.applied.at(-1), "nexus");
});

test("application failure cannot consume or persist the migration", async () => {
  const f = await fixture({ "agent-hub-theme": "orbit" });
  assert.throws(() => f.boot({ apply: () => { throw new Error("apply failed"); } }), /apply failed/u);
  assert.equal(f.values.get(f.api.STORAGE_KEY), "orbit");
  assert.equal(f.values.has(f.api.NEXUS_MIGRATION_KEY), false);
});

test("read, theme-write and marker-write failures report incomplete persistence and retry", async () => {
  for (const failure of ["access", "read", "theme", "marker"]) {
    const f = await fixture({ "agent-hub-theme": "orbit" });
    const broken = {
      getItem: (key) => { if (failure === "read") throw new Error("blocked"); return f.storage.getItem(key); },
      setItem: (key, value) => {
        if (key === (failure === "theme" ? f.api.STORAGE_KEY : f.api.NEXUS_MIGRATION_KEY)) throw new Error("quota");
        assert.equal(f.applied.at(-1), "nexus");
        f.storage.setItem(key, value);
      },
    };
    assert.equal(f.boot({ storage: () => { if (failure === "access") throw new Error("blocked"); return broken; } }).migration, "storage-unavailable");
    assert.equal(f.values.has(f.api.NEXUS_MIGRATION_KEY), false);
    assert.equal(f.applied.at(-1), "nexus");
    assert.equal(f.boot().migration, "completed");
  }
});
