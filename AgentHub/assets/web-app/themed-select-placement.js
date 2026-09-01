"use strict";

(() => {
  function resolve(select, menu, { documentRoot = document } = {}) {
    const dialog = select?.closest?.("dialog") ?? null;
    return Object.freeze({
      host: dialog ?? documentRoot.body,
      usePopover: !dialog && typeof menu?.showPopover === "function",
    });
  }

  window.AgentHubThemedSelectPlacement = Object.freeze({ resolve });
})();
