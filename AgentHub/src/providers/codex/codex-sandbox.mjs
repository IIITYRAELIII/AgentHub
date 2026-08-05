export const CODEX_SANDBOX_MODES = ["workspace-write", "danger-full-access"];

export function normalizeCodexSandboxMode(value, { fallback = "workspace-write" } = {}) {
  const mode = String(value ?? fallback).trim().toLowerCase();
  if (!CODEX_SANDBOX_MODES.includes(mode)) {
    throw new Error(`codexSandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(", ")}`);
  }
  return mode;
}

export function codexThreadSandboxSettings(mode) {
  return {
    approvalPolicy: "on-request",
    sandbox: normalizeCodexSandboxMode(mode),
  };
}

export function codexTurnSandboxSettings(mode, projectRoot) {
  const normalized = normalizeCodexSandboxMode(mode);
  if (normalized === "danger-full-access") {
    return {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  if (!String(projectRoot ?? "").trim()) throw new Error("projectRoot is required for workspace-write sandbox");
  return {
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [projectRoot],
      networkAccess: false,
    },
  };
}
