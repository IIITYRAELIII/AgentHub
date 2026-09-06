(() => {
  "use strict";

  const embeddedFrameSources = new WeakSet();

  function objectSource(source) {
    return (typeof source === "object" && source !== null) || typeof source === "function";
  }

  function registerEmbeddedFrame(frame) {
    const source = frame?.contentWindow;
    if (objectSource(source)) embeddedFrameSources.add(source);
    return source ?? null;
  }

  function isTrustedAgentHubHostMessage(event, windowRef = window) {
    const source = event?.source ?? null;
    if (objectSource(source) && embeddedFrameSources.has(source)) return false;
    /* VS Code host messages have no page Window source. Same-window messages
       remain available for the web shell; every iframe, opener and nested
       foreign browsing context fails closed independently of message shape. */
    return source === null || source === windowRef;
  }

  function guardHostMessage(listener, windowRef = window) {
    if (typeof listener !== "function") throw new TypeError("host message listener is required");
    return function guardedHostMessage(event) {
      if (!isTrustedAgentHubHostMessage(event, windowRef)) return undefined;
      return listener.call(this, event);
    };
  }

  window.AgentHubHostMessageTrust = Object.freeze({
    guardHostMessage,
    isTrustedAgentHubHostMessage,
    registerEmbeddedFrame,
  });
})();
