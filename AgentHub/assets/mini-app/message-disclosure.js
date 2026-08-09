(() => {
  "use strict";

  // This is intentionally a visual limit only.  Message text remains intact
  // in the DOM and in every transport payload.
  const USER_MESSAGE_COLLAPSE_HEIGHT_PX = 264;

  function hasCollapsedOverflow(scrollHeight, collapseHeight = USER_MESSAGE_COLLAPSE_HEIGHT_PX) {
    return Number(scrollHeight) > Number(collapseHeight);
  }

  function liveActivityDisclosureOpen({ open = false, wasHidden = false, visible = false } = {}) {
    return Boolean(visible && !wasHidden && open);
  }

  function liveActivityTitle({ label = "Вызовы инструментов", count = 0, stage = "" } = {}) {
    const base = `${String(label)} (${Math.max(0, Number(count) || 0)})`;
    const suffix = String(stage ?? "").trim();
    return suffix ? `${base} · ${suffix}` : base;
  }

  function liveStageParts(stage = "") {
    const value = String(stage ?? "").trim();
    const separator = value.indexOf(" · ");
    return separator >= 0
      ? { status: value.slice(0, separator).trim(), detail: value.slice(separator + 3).trim() }
      : { status: value, detail: "" };
  }

  window.AgentHubMessageDisclosure = Object.freeze({
    USER_MESSAGE_COLLAPSE_HEIGHT_PX,
    hasCollapsedOverflow,
    liveActivityDisclosureOpen,
    liveActivityTitle,
    liveStageParts,
  });
})();
