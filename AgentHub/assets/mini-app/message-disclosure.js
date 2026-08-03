(() => {
  "use strict";

  // This is intentionally a visual limit only.  Message text remains intact
  // in the DOM and in every transport payload.
  const USER_MESSAGE_COLLAPSE_HEIGHT_PX = 264;

  function hasCollapsedOverflow(scrollHeight, collapseHeight = USER_MESSAGE_COLLAPSE_HEIGHT_PX) {
    return Number(scrollHeight) > Number(collapseHeight);
  }

  window.AgentHubMessageDisclosure = Object.freeze({
    USER_MESSAGE_COLLAPSE_HEIGHT_PX,
    hasCollapsedOverflow,
  });
})();
