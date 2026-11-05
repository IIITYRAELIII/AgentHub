(() => {
  "use strict";

  const STORAGE_KEY = "agent-hub-theme";
  // Permanent identity: retain across releases so skipped upgrades still migrate.
  const NEXUS_MIGRATION_KEY = "agent-hub:theme-migration:nexus";

  function initialize({ storage, catalog, aliases = {}, apply }) {
    const available = new Set(catalog.map(({ id }) => id));
    const fallback = catalog[0].id;
    let selected = fallback;
    let target;
    let pending = false;
    try {
      target = storage();
      const saved = target.getItem(STORAGE_KEY);
      const candidate = aliases[saved] ?? saved;
      if (available.has(candidate)) selected = candidate;
      pending = available.has("nexus") && target.getItem(NEXUS_MIGRATION_KEY) !== "done";
    } catch {
      apply(available.has("nexus") ? "nexus" : selected);
      return { migration: "storage-unavailable" };
    }
    if (pending) selected = "nexus";
    apply(selected);
    if (!pending) return { theme: selected, migration: "unchanged" };
    try {
      // Never consume the migration before application and the theme write succeed.
      target.setItem(STORAGE_KEY, selected);
      target.setItem(NEXUS_MIGRATION_KEY, "done");
      return { theme: selected, migration: "completed" };
    } catch {
      // The active theme is usable, but a future startup must retry persistence.
      return { theme: selected, migration: "storage-unavailable" };
    }
  }

  window.AgentHubThemePreference = Object.freeze({ STORAGE_KEY, NEXUS_MIGRATION_KEY, initialize });
})();
