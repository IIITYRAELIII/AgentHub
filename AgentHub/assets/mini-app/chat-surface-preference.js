(() => {
  "use strict";

  const STORAGE_KEY = "agent-hub:chat-surface:v1";

  function normalize(value) {
    return value === "transparent" ? "transparent" : "themed";
  }

  function stored(storage) {
    try {
      const value = storage?.getItem(STORAGE_KEY);
      return value == null ? "transparent" : normalize(value);
    } catch {
      return "transparent";
    }
  }

  function apply(root, toggle, value) {
    const selected = normalize(value);
    if (root?.dataset) root.dataset.chatSurface = selected;
    if (toggle) toggle.checked = selected === "transparent";
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

  window.AgentHubChatSurfacePreference = Object.freeze({
    STORAGE_KEY,
    apply,
    normalize,
    persist,
    stored,
  });
})();
