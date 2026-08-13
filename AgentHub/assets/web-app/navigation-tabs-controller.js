(() => {
  "use strict";

  const NAVIGATION_TABS = new Set([
    "tasks",
    "chat",
    "dashboard",
    "journal",
    "statistics",
    "background",
    "server",
  ]);
  const STANDALONE_NAVIGATION_TABS = new Set([
    "dashboard",
    "journal",
    "statistics",
    "background",
    "server",
  ]);

  function normalizeNavigationTab(value) {
    const tab = String(value ?? "");
    return NAVIGATION_TABS.has(tab) ? tab : "tasks";
  }

  function isStandaloneNavigationTab(value) {
    return STANDALONE_NAVIGATION_TABS.has(String(value ?? ""));
  }

  function currentNavigationTab(view, pane) {
    return isStandaloneNavigationTab(view)
      ? String(view)
      : (pane === "chat" ? "chat" : "tasks");
  }

  function storedNavigationTab(storage, key) {
    try {
      return normalizeNavigationTab(storage?.getItem(key));
    } catch {
      return "tasks";
    }
  }

  window.AgentHubNavigationTabs = Object.freeze({
    currentNavigationTab,
    isStandaloneNavigationTab,
    normalizeNavigationTab,
    storedNavigationTab,
  });
})();
