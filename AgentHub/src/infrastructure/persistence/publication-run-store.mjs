// Read-only historical journal location used by Task publication evidence.
import os from "node:os";
import path from "node:path";

function stateRoot(environment = process.env) {
  return environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
}

export function publicationRunPaths(environment = process.env) {
  const root = path.join(stateRoot(environment), "AgentHub");
  return {
    statusFile: path.join(root, "publication-status.json"),
    logDirectory: path.join(root, "publication-runs"),
  };
}
