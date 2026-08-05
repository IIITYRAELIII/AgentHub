import { normalizeCodexSandboxMode } from "../../domain/agent-runtime-settings.mjs";

export {
  CODEX_SANDBOX_MODES,
  normalizeCodexSandboxMode,
} from "../../domain/agent-runtime-settings.mjs";

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
