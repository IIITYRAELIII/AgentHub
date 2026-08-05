import { captureProcess } from "../infrastructure/process/process-capture.mjs";
import { resolveClaudeInvocation as resolveInstalledClaudeInvocation } from "../providers/claude/claude-invocation.mjs";

export function createProviderProcessComposition({
  config,
  getProjectRoot,
  stopProcessTree,
}) {
  function resolveClaudeInvocation() {
    return resolveInstalledClaudeInvocation({
      requested: config.claudeExecutable || "claude",
      prefixArgs: config.claudeExecutableArgs,
    });
  }

  function spawnCapture(command, args, options = {}) {
    return captureProcess(command, args, {
      cwd: getProjectRoot(),
      stopProcess: (worker) => stopProcessTree(worker.pid),
      ...options,
    });
  }

  return {
    resolveClaudeInvocation,
    spawnCapture,
  };
}
