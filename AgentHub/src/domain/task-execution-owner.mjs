export const TASK_EXECUTION_OWNERS = Object.freeze({
  HUB: "hub",
  VSCODE: "vscode",
  DESKTOP: "desktop",
  CLI: "cli",
  EXTERNAL: "external",
});

export function normalizeTaskExecutionOwner(owner) {
  return owner === "telegram" ? TASK_EXECUTION_OWNERS.HUB : owner;
}

export function taskExecutionRuntimeLabel(owner) {
  owner = normalizeTaskExecutionOwner(owner);
  if (owner === TASK_EXECUTION_OWNERS.HUB) return "Agent Hub Server";
  if (owner === TASK_EXECUTION_OWNERS.VSCODE) return "VSCode App Server";
  if (owner === TASK_EXECUTION_OWNERS.DESKTOP) return "Codex Desktop App";
  if (owner === TASK_EXECUTION_OWNERS.CLI) return "Codex CLI";
  return "External Codex";
}

export function taskExecutionRuntimeShortLabel(owner) {
  owner = normalizeTaskExecutionOwner(owner);
  if (owner === TASK_EXECUTION_OWNERS.HUB) return "HUB";
  if (owner === TASK_EXECUTION_OWNERS.VSCODE) return "VSC";
  if (owner === TASK_EXECUTION_OWNERS.DESKTOP) return "APP";
  if (owner === TASK_EXECUTION_OWNERS.CLI) return "CLI";
  return "EXT";
}

export function taskExecutionRunningEmoji(owner, fallback = "🧵") {
  owner = normalizeTaskExecutionOwner(owner);
  return owner === TASK_EXECUTION_OWNERS.HUB ? "⚡" : fallback;
}
