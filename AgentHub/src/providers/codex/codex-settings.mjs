import {
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
} from "../../domain/agent-runtime-settings.mjs";

export {
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
} from "../../domain/agent-runtime-settings.mjs";

export const CODEX_REASONING_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};

export const CODEX_COLLABORATION_MODE_LABELS = {
  default: "Work",
  plan: "Plan",
};

export function resolveCodexThreadSettings(payload, current = {}) {
  const source = payload?.threadSettings ?? payload ?? {};
  const collaborationSettings = source.collaborationMode?.settings ?? {};
  const modelCandidate = source.model ?? collaborationSettings.model;
  const reasoningCandidate = source.reasoningEffort
    ?? source.effort
    ?? collaborationSettings.reasoning_effort;
  const model = String(modelCandidate ?? "").trim() || current.model;
  const reasoningEffort = CODEX_REASONING_EFFORTS.includes(reasoningCandidate)
    ? reasoningCandidate
    : current.reasoningEffort;
  return { model, reasoningEffort };
}

export function buildCodexCollaborationMode({ mode, model, reasoningEffort }) {
  if (!CODEX_COLLABORATION_MODES.includes(mode)) throw new Error("unknown Codex collaboration mode");
  if (!CODEX_REASONING_EFFORTS.includes(reasoningEffort)) throw new Error("unknown Codex reasoning effort");
  if (!String(model ?? "").trim()) throw new Error("Codex model is required");

  return {
    mode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: null,
    },
  };
}
