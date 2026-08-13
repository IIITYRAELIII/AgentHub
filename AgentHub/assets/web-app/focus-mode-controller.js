(() => {
  "use strict";

  const STORAGE_KEY = "agent-hub:focus-mode:v1";
  const LEGACY_ORANGE_STORAGE_KEY = "agent-hub:theme:orange:focus:v1";

  function stored(storage, theme = "") {
    try {
      const value = storage?.getItem?.(STORAGE_KEY);
      if (value != null) return value === "true";
      const legacy = storage?.getItem?.(LEGACY_ORANGE_STORAGE_KEY);
      if (legacy != null) return legacy === "true";
      return theme === "orange";
    } catch {
      return theme === "orange";
    }
  }

  function persist(storage, enabled) {
    const selected = Boolean(enabled);
    try {
      storage?.setItem?.(STORAGE_KEY, String(selected));
    } catch {
      // Недоступный localStorage не мешает переключать режим в текущей сессии.
    }
    return selected;
  }

  function apply(root, toggle, enabled) {
    const active = Boolean(enabled);
    if (active) root.dataset.focusMode = "true";
    else delete root.dataset.focusMode;
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(active));
      toggle.setAttribute(
        "aria-label",
        active ? "Выключить режим концентрации" : "Включить режим концентрации",
      );
      toggle.title = active
        ? "Выключить режим концентрации"
        : "Включить режим концентрации";
    }
    return active;
  }

  window.AgentHubFocusMode = Object.freeze({
    LEGACY_ORANGE_STORAGE_KEY,
    STORAGE_KEY,
    apply,
    persist,
    stored,
  });

  const root = document.documentElement;
  const toggle = document.querySelector("[data-focus-toggle]");
  const selectedTheme = localStorage?.getItem?.("agent-hub-theme") || root.dataset.theme;
  let enabled = stored(localStorage, selectedTheme);

  function providerLabel(value) {
    if (value === "codex") return "Codex";
    if (value === "claude") return "Claude";
    return "не указан";
  }

  function providerModelHint(target) {
    const dot = target?.querySelector?.(".provider-dot[data-provider]");
    const provider = target?.dataset?.streamProvider || dot?.dataset?.provider || "";
    const providerName = String(target?.dataset?.streamProviderLabel || providerLabel(provider)).trim();
    const modelName = String(target?.dataset?.streamModel || "").trim();
    return `Провайдер: ${providerName}${modelName ? `. Модель: ${modelName}` : ""}`;
  }

  function updateProviderHints() {
    document.querySelectorAll(".stream-tab[data-stream-provider]").forEach((tab) => {
      const hint = providerModelHint(tab);
      const dot = tab.querySelector(".provider-dot");
      if (dot) dot.title = hint;
      tab.title = root.dataset.focusMode === "true"
        ? hint
        : tab.dataset.streamTitle || tab.title;
    });
  }

  function sync() {
    apply(root, toggle, enabled);
    updateProviderHints();
  }

  toggle?.addEventListener("click", () => {
    enabled = persist(localStorage, !enabled);
    sync();
  });

  for (const target of [
    document.querySelector("[data-stream-tabs]"),
    document.querySelector("[data-activity-stream-list]"),
  ]) {
    if (target) new MutationObserver(updateProviderHints).observe(target, { childList: true, subtree: true });
  }

  sync();
})();
