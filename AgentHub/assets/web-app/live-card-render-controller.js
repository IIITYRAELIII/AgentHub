(() => {
  "use strict";

  function liveCardRenderParts({
    visibleText = "",
    standaloneReasoning = "",
    traceGroups = [],
    activities = [],
    stageDetail = "",
    fileContext = null,
    bodyState = null,
  } = {}) {
    const groups = Array.isArray(traceGroups) ? traceGroups : [];
    const activityValues = Array.isArray(activities) ? activities : [];
    const activityFeedVisible = groups.length === 0 && activityValues.length > 0;
    const traceActivityCount = groups.reduce(
      (total, group) => total + (Array.isArray(group?.activities) ? group.activities.length : 0),
      0,
    );
    return {
      reasoning: { text: String(standaloneReasoning ?? ""), fileContext },
      trace: { groups },
      traceSummary: {
        visible: groups.length > 0 && traceActivityCount > 0,
        count: traceActivityCount,
        stageDetail: String(stageDetail ?? ""),
      },
      body: { text: String(visibleText ?? ""), fileContext, state: bodyState },
      activityFeed: {
        visible: activityFeedVisible,
        // Grouped traces already own these activities. Keeping the hidden
        // duplicate empty avoids building the same potentially large DOM twice.
        activities: activityFeedVisible ? activityValues : [],
      },
      activityFeedSummary: {
        visible: activityFeedVisible,
        count: activityFeedVisible ? activityValues.length : 0,
        stageDetail: activityFeedVisible ? String(stageDetail ?? "") : "",
      },
    };
  }

  function createLiveCardRenderController({ serialize = JSON.stringify } = {}) {
    const stateByOwner = new WeakMap();
    return Object.freeze({
      reconcile(owner, key, value, render) {
        if ((!owner || (typeof owner !== "object" && typeof owner !== "function"))
          || typeof render !== "function") return false;
        let signature;
        try {
          signature = serialize(value);
        } catch {
          render();
          return true;
        }
        let state = stateByOwner.get(owner);
        if (!state) {
          state = new Map();
          stateByOwner.set(owner, state);
        }
        const part = String(key ?? "");
        if (state.has(part) && state.get(part) === signature) return false;
        render();
        state.set(part, signature);
        return true;
      },
      forget(owner) {
        return Boolean(owner && stateByOwner.delete(owner));
      },
    });
  }

  window.AgentHubLiveCardRender = Object.freeze({
    createLiveCardRenderController,
    liveCardRenderParts,
  });
})();
