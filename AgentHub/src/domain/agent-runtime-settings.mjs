export const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
]);

export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const CODEX_COLLABORATION_MODES = ["default", "plan"];
export const CODEX_SANDBOX_MODES = ["workspace-write", "danger-full-access"];

export function normalizeCodexSandboxMode(value, { fallback = "workspace-write" } = {}) {
  const mode = String(value ?? fallback).trim().toLowerCase();
  if (!CODEX_SANDBOX_MODES.includes(mode)) {
    throw new Error(`codexSandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(", ")}`);
  }
  return mode;
}
