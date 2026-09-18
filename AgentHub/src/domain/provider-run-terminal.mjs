const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

export function normalizeProviderRunTerminalStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "completed" || status === "complete" || status === "succeeded") return "completed";
  if (["aborted", "cancelled", "canceled", "interrupted", "stopped"].includes(status)) return "aborted";
  if (["failed", "error", "errored", "timed_out", "timeout"].includes(status)) return "failed";
  return null;
}

export function rememberProviderRunTerminalStatus(run, value) {
  const status = normalizeProviderRunTerminalStatus(value);
  if (!status) throw new Error(`unsupported provider run terminal status ${String(value ?? "") || "empty"}`);
  const current = normalizeProviderRunTerminalStatus(run?.providerTerminalStatus);
  if (current) return current;
  if (!run || typeof run !== "object") throw new TypeError("provider run is required");
  run.providerTerminalStatus = status;
  return status;
}

export function providerRunTerminalIdentity(run) {
  const provider = String(run?.provider ?? "").trim().toLowerCase();
  const threadId = String(run?.threadId ?? "").trim();
  const turnId = String(run?.turnId ?? "").trim();
  const status = normalizeProviderRunTerminalStatus(run?.providerTerminalStatus);
  if (!provider || !threadId || !turnId || !status) return null;
  return { provider, threadId, turnId, status };
}

export function providerRunTerminalStatusSupported(value) {
  return TERMINAL_STATUSES.has(String(value ?? "").trim().toLowerCase());
}
