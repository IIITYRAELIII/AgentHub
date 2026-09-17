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

export function buildCodexDeveloperInstructions({
  guide = "", global = "", workspace = "", stream = "", context = "",
} = {}) {
  const guideContent = String(guide ?? "");
  if (!guideContent.trim()) throw new Error("Agent Hub Guide is required");
  const sections = [
    [
      "<agent_hub_instruction_precedence>",
      "Within Agent Hub-managed instructions, later layers refine earlier layers:",
      "Agent Hub Guide < Global pre-turn instructions < Workspace < Stream.",
      "Workspace and Stream rules are the specific workflow policy for this Hub context and override conflicting repository defaults.",
      "Use the User Prompt as the task-specific intent unless it conflicts with system, safety, or developer requirements.",
      "</agent_hub_instruction_precedence>",
    ].join("\n"),
    `<agent_hub_guide>\n${guideContent}\n</agent_hub_guide>`,
  ];
  const globalContent = String(global ?? "");
  const workspaceContent = String(workspace ?? "");
  const streamContent = String(stream ?? "");
  if (globalContent.trim()) {
    sections.push(`<global_pre_turn_instructions>\n${globalContent}\n</global_pre_turn_instructions>`);
  }
  if (workspaceContent.trim()) {
    sections.push(`<workspace_instructions>\n${workspaceContent}\n</workspace_instructions>`);
  }
  if (streamContent.trim()) {
    sections.push(`<stream_instructions>\n${streamContent}\n</stream_instructions>`);
  }
  const contextContent = String(context ?? "");
  if (contextContent.trim()) sections.push(contextContent);
  return sections.join("\n\n");
}

export function buildCodexApplicationContext(developerInstructions) {
  return {
    "agent-hub": { kind: "application", value: String(developerInstructions ?? "") },
  };
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
