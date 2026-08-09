"use strict";

function runtimeReloadAction({ currentRoot, targetRoot, clientReady = false } = {}) {
  if (!targetRoot || targetRoot === currentRoot) return "none";
  return clientReady ? "apply" : "prepare";
}

module.exports = { runtimeReloadAction };
