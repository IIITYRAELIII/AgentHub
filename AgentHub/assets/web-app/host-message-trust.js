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

  function isVscodeHostMessage(event, windowRef) {
    const source = event?.source ?? null;
    const protocol = String(windowRef?.location?.protocol ?? "").toLowerCase();
    const pageOrigin = String(windowRef?.location?.origin ?? "");
    return objectSource(source)
      && protocol === "vscode-webview:"
      && pageOrigin !== ""
      && pageOrigin !== "null"
      && String(event?.origin ?? "") === pageOrigin
      && Boolean(windowRef?.__agentHubVscode);
  }

  function isTrustedAgentHubHostMessage(event, windowRef = window) {
    const source = event?.source ?? null;
    if (objectSource(source) && embeddedFrameSources.has(source)) return false;
    /* VS Code 1.133 relays native host messages through its same-origin outer
       webview frame, so those events carry that wrapper WindowProxy rather
       than a null source. The native API capability plus the exact opaque
       vscode-webview origin identifies that channel. Ordinary web surfaces
       retain the stricter null/self rule, and every registered embedded frame
       remains denied before origin is considered. */
    return source === null || source === windowRef || isVscodeHostMessage(event, windowRef);
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
