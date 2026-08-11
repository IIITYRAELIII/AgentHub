(() => {
  "use strict";

  const STORAGE_KEY = "agent-hub:background-motion:v1";

  function normalize(value) {
    return value === "off" ? "off" : "on";
  }

  function stored(storage) {
    try {
      return normalize(storage?.getItem(STORAGE_KEY));
    } catch {
      return "on";
    }
  }

  function apply(root, toggle, value) {
    const selected = normalize(value);
    if (root?.dataset) root.dataset.backgroundMotion = selected;
    if (toggle) toggle.checked = selected === "on";
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

  function enabled(root, reducedMotion) {
    return root?.dataset?.backgroundMotion !== "off" && reducedMotion?.matches !== true;
  }

  if (typeof document === "object") {
    apply(
      document.documentElement,
      document.querySelector("[data-background-motion-toggle]"),
      stored(globalThis.localStorage),
    );
  }

  window.AgentHubBackgroundMotionPreference = Object.freeze({
    STORAGE_KEY,
    apply,
    enabled,
    normalize,
    persist,
    stored,
  });
})();
