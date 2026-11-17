// Read-only historical journal location used by Task publication evidence.
import os from "node:os";
import path from "node:path";

export function publicationRunPaths(environment = process.env) {
  const root = path.join(stateRoot(environment), "AgentHub");
  return {
    statusFile: path.join(root, "publication-status.json"),
    logDirectory: path.join(root, "publication-runs"),
  };
}
