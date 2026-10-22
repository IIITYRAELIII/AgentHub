import { readFileSync } from "node:fs";
import path from "node:path";
import { artifactVersionIdentity, manifestVersionIdentity, semanticVersion } from "../../domain/agent-hub-version.mjs";

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
  semanticVersion(version);
  return { ...metadata, version };
}

export function readAgentHubVersion(options = {}) {
  return readAgentHubPackage(options).version;
}

export function agentHubReleaseSequence(packageVersion, releaseVersion) {
  if (String(releaseVersion).includes("+build.")) {
    const identity = artifactVersionIdentity(releaseVersion);
    if (identity.publicVersion !== packageVersion) throw new Error("Agent Hub runtime manifest has an invalid release version");
    return identity.buildNumber;
  }
  const prefix = `${packageVersion}.`;
  const sequenceText = String(releaseVersion ?? "").trim().slice(prefix.length);
  if (!String(releaseVersion ?? "").startsWith(prefix)
    || !/^[1-9]\d*$/u.test(sequenceText)
    || !Number.isSafeInteger(Number(sequenceText))) {
    throw new Error(`Agent Hub runtime manifest has an invalid release version: ${releaseVersion ?? "missing"}`);
  }
  return Number(sequenceText);
}

export function readAgentHubReleaseVersion({
  packageFile = AGENT_HUB_PACKAGE_FILE,
  manifestFile = path.join(path.dirname(packageFile), "runtime-manifest.json"),
  readFileImpl = readFileSync,
} = {}) {
  const packageVersion = readAgentHubVersion({ packageFile, readFileImpl });
  let manifest;
  try {
    manifest = JSON.parse(readFileImpl(manifestFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return packageVersion;
    throw error;
  }
  if (manifest?.releaseVersion == null) return packageVersion;
  agentHubReleaseSequence(packageVersion, manifest.releaseVersion);
  if (manifest.releaseVersion.includes("+build.")) manifestVersionIdentity(manifest);
  return manifest.releaseVersion;
}

export const AGENT_HUB_VERSION = readAgentHubReleaseVersion();
