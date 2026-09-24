"use strict";

(() => {
  function resolve(select, menu, { documentRoot = document } = {}) {
    const dialog = select?.closest?.("dialog") ?? null;
    return Object.freeze({
      // Keep modal menus inside the dialog's non-inert subtree, but promote
      // them to the top layer so themed filters cannot become their fixed
      // containing block or clip them at the dialog boundary.
      host: dialog ?? documentRoot.body,
      usePopover: typeof menu?.showPopover === "function",
    });
  }

  window.AgentHubThemedSelectPlacement = Object.freeze({ resolve });
})();
