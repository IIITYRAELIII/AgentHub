export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const CODEX_COLLABORATION_MODES = ["default", "plan"];

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
