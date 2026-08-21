"use strict";

function runtimeReloadAction({ currentRoot, targetRoot, clientReady = false, force = false } = {}) {
  if (!targetRoot || targetRoot === currentRoot) return "none";
  return clientReady || force ? "apply" : "prepare";
}

module.exports = { runtimeReloadAction };
