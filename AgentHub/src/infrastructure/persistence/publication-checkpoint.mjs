// Read-only legacy checkpoint codec. Remove after the corresponding original
// generations/recovery consumers are terminal and explicitly migrated.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export function publicationCheckpointFile(environment = process.env) {
  const root = environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
  return path.join(root, "AgentHub", "publication-checkpoint.json");
}

export async function readPublicationCheckpoint(file = publicationCheckpointFile()) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
