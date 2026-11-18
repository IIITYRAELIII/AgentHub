import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
const ICON_SOURCE = path.join("VSCodeExtension", "media", "agent-hub-mark.png");
const HOST_SOURCE_NAMES = Object.freeze(["AgentHub.RuntimeHost.cs", "AgentHub.IconBuilder.cs", "app.manifest"]);
export const RUNTIME_HOST_SOURCE_INPUTS = Object.freeze([
  ...HOST_SOURCE_NAMES.map(name => `RuntimeHost/${name}`), "VSCodeExtension/media/agent-hub-mark.png",
]);
export async function runtimeHostSourceHash(sourceRoot, { readSource = readFile } = {}) {
  const hostRoot = path.join(sourceRoot, "RuntimeHost");
  const hash = createHash("sha256");
  hash.update("agent-hub-runtime-host-build-v3\0", "utf8");
  for (const name of HOST_SOURCE_NAMES) {
    hash.update(name, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readSource(path.join(hostRoot, name)));
    hash.update("\0", "utf8");
  }
  hash.update(ICON_SOURCE, "utf8");
  hash.update("\0", "utf8");
  hash.update(await readSource(path.join(sourceRoot, ICON_SOURCE)));
  hash.update("\0", "utf8");
  return hash.digest("hex");
}
