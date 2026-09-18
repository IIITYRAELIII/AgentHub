(() => {
  "use strict";

  const STORAGE_KEY = "agent-hub:activity-rail-visibility:v1";

  function normalize(value) {
    return value === "hidden" ? "hidden" : "visible";
  }

  function stored(storage) {
    try {
      return normalize(storage?.getItem(STORAGE_KEY));
    } catch {
      return "visible";
    }
  }

  function apply(root, toggle, value) {
    const selected = normalize(value);
    if (root?.dataset) root.dataset.activityRailVisibility = selected;
    if (toggle) toggle.checked = selected === "visible";
    return selected;
  }

  function persist(storage, value) {
    const selected = normalize(value);
    try {
      storage?.setItem(STORAGE_KEY, selected);
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
    return selected;
  }

  if (typeof document === "object") {
    apply(
      document.documentElement,
      document.querySelector("[data-activity-rail-visibility-toggle]"),
      stored(globalThis.localStorage),
    );
  }

  window.AgentHubActivityRailPreference = Object.freeze({
    STORAGE_KEY,
    apply,
    normalize,
    persist,
    stored,
  });
})();
