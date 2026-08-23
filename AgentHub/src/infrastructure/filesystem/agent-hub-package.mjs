import { readFileSync } from "node:fs";
import path from "node:path";

export const AGENT_HUB_PACKAGE_FILE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "package.json",
);

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function readAgentHubPackage({
  packageFile = AGENT_HUB_PACKAGE_FILE,
  readFileImpl = readFileSync,
} = {}) {
  const metadata = JSON.parse(readFileImpl(packageFile, "utf8"));
  if (metadata?.name !== "agent-hub") {
    throw new Error(`Agent Hub package metadata has an unexpected name: ${metadata?.name ?? "missing"}`);
  }
  const version = String(metadata.version ?? "").trim();
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Agent Hub package metadata has an invalid version: ${version || "missing"}`);
  }
  return { ...metadata, version };
}

export function readAgentHubVersion(options = {}) {
  return readAgentHubPackage(options).version;
}

export const AGENT_HUB_VERSION = readAgentHubVersion();
