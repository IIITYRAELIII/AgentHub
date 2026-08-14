let compositionPromise;

export { createFatalProcessHandler } from "./src/runtime/fatal-process-handler.mjs";

function loadComposition() {
  compositionPromise ??= import("./src/composition/agent-hub-composition.mjs");
  return compositionPromise;
}

export async function startAgentHub(...args) {
  const composition = await loadComposition();
  return composition.startAgentHub(...args);
}

export async function shutdownAgentHub(...args) {
  if (!compositionPromise) return undefined;
  const composition = await compositionPromise;
  return composition.shutdownAgentHub(...args);
}
