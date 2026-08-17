(() => {
  "use strict";

  // This is intentionally a visual limit only.  Message text remains intact
  // in the DOM and in every transport payload.
  const USER_MESSAGE_COLLAPSE_HEIGHT_PX = 93;
  const TURN_TRACE_ACTIVITY_GROUP_ID = "trace:activities";

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

  function standaloneLiveStageDetail({ stage = "", traceGroups = [] } = {}) {
    if (Array.isArray(traceGroups) && traceGroups.length) return "";
    return liveStageParts(stage).detail;
  }

  function turnTraceContent(groups = []) {
    const reasoningBlocks = [];
    const activities = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const reasoning = String(group?.reasoning ?? "").trim();
      if (reasoning) reasoningBlocks.push(reasoning);
      if (Array.isArray(group?.activities)) activities.push(...group.activities);
    }
    return { reasoningBlocks, activities };
  }

  function liveTraceDisclosureOpen({ groupId = "", openGroupIds = [] } = {}) {
    return Array.from(openGroupIds ?? []).includes(String(groupId));
  }

  window.AgentHubMessageDisclosure = Object.freeze({
    USER_MESSAGE_COLLAPSE_HEIGHT_PX,
    TURN_TRACE_ACTIVITY_GROUP_ID,
    hasCollapsedOverflow,
    liveActivityDisclosureOpen,
    liveActivityTitle,
    liveStageParts,
    standaloneLiveStageDetail,
    liveTraceDisclosureOpen,
    turnTraceContent,
  });
})();
