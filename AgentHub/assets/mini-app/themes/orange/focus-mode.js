(function initOrangeFocus(global) {
  "use strict";

  const THEME_ID = "orange";
  const STORAGE_KEY = "agent-hub:theme:orange:focus:v1";

  function stored(storage) {
    try {
      const value = storage?.getItem?.(STORAGE_KEY);
      return value == null ? true : value === "true";
    } catch {
      return true;
    }
  }

  function persist(storage, enabled) {
    try {
      storage?.setItem?.(STORAGE_KEY, String(Boolean(enabled)));
    } catch {
      // Недоступный localStorage не мешает переключать режим в текущей сессии.
    }
    return Boolean(enabled);
  }

  function apply(root, toggle, theme, enabled) {
    const activeTheme = theme === THEME_ID;
    const activeFocus = activeTheme && Boolean(enabled);
    if (activeFocus) root.dataset.focusMode = "true";
    else delete root.dataset.focusMode;
    if (toggle) {
      toggle.hidden = !activeTheme;
      toggle.setAttribute("aria-pressed", String(activeFocus));
      toggle.setAttribute(
        "aria-label",
        activeFocus ? "Выключить режим концентрации" : "Включить режим концентрации",
      );
      toggle.title = activeFocus
        ? "Выключить режим концентрации"
        : "Включить режим концентрации";
    }
    return activeFocus;
  }

  const api = Object.freeze({ THEME_ID, STORAGE_KEY, stored, persist, apply });
  global.AgentHubOrangeFocus = api;

  const document = global.document;
  if (!document?.documentElement) return;

  const root = document.documentElement;
  const toggle = document.querySelector("[data-orange-focus-toggle]");
  const storage = global.localStorage;
  let enabled = stored(storage);

  function providerLabel(value) {
    if (value === "codex") return "Codex";
    if (value === "claude") return "Claude";
    return "не указан";
  }

  function updateProviderHints() {
    if (root.dataset.theme !== THEME_ID) return;
    document.querySelectorAll(".stream-tab[data-stream-provider] .provider-dot")
      .forEach((dot) => {
        const tab = dot.closest("[data-stream-provider]");
        dot.title = `Провайдер: ${providerLabel(tab?.dataset.streamProvider)}`;
      });
    document.querySelectorAll(".activity-stream-item .provider-dot[data-provider]")
      .forEach((dot) => {
        dot.title = `Провайдер: ${providerLabel(dot.dataset.provider)}`;
      });
  }

  function sync() {
    apply(root, toggle, root.dataset.theme, enabled);
    updateProviderHints();
  }

  toggle?.addEventListener("click", () => {
    enabled = persist(storage, !enabled);
    sync();
  });

  new MutationObserver(sync).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  for (const target of [
    document.querySelector("[data-stream-tabs]"),
    document.querySelector("[data-activity-stream-list]"),
  ]) {
    if (target) new MutationObserver(updateProviderHints).observe(target, { childList: true, subtree: true });
  }

  sync();
})(window);
