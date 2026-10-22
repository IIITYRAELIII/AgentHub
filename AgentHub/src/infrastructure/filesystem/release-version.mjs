import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { calendarVersion, compareSemanticVersions, semanticVersion } from "../../domain/agent-hub-version.mjs";

const AGENT_HUB_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
function serializedJson(value, source) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(value, null, 2).replaceAll("\n", newline)}${newline}`;
}

function assertAgentHubMetadata(packageMetadata, lockMetadata) {
  if (packageMetadata?.name !== "agent-hub") {
    throw new Error("Agent Hub package.json has an unexpected package name");
  }
  if (lockMetadata?.name !== "agent-hub" || lockMetadata?.packages?.[""]?.name !== "agent-hub") {
    throw new Error("Agent Hub package-lock.json has an unexpected package name");
  }
}

export function agentHubCalendarVersion(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Agent Hub release date must be a valid Date");
  }
  return `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
}

export async function inspectAgentHubReleaseVersion({
  root = AGENT_HUB_ROOT,
  now = new Date(),
  expectedVersion = null,
  releaseType = "patch",
  readFileImpl = readFile,
} = {}) {
  const packageFile = path.join(root, "package.json");
  const lockFile = path.join(root, "package-lock.json");
  const [packageSource, lockSource] = await Promise.all([
    readFileImpl(packageFile, "utf8"),
    readFileImpl(lockFile, "utf8"),
  ]);
  const packageMetadata = JSON.parse(packageSource);
  const lockMetadata = JSON.parse(lockSource);
  assertAgentHubMetadata(packageMetadata, lockMetadata);

  const previousVersion = String(packageMetadata.version ?? "").trim();
  const version = expectedVersion == null
    ? nextAgentHubPublicVersion(previousVersion, releaseType)
    : String(expectedVersion).trim();
  if (!calendarVersion(version)) semanticVersion(version);
  if (calendarVersion(previousVersion) && !calendarVersion(version) && semanticVersion(version).core[0] < 2) {
    throw new Error("First installer semantic version must be 2.0.0 or a later supported version");
  }
  const comparison = calendarVersion(previousVersion) && !calendarVersion(version)
    ? -1 : !calendarVersion(previousVersion) && calendarVersion(version)
      ? 1 : compareSemanticVersions(previousVersion, version);
  if (comparison !== null && comparison > 0) {
    throw new Error(`Agent Hub version ${previousVersion} is newer than selected release ${version}`);
  }

  const lockVersion = String(lockMetadata.version ?? "").trim();
  const lockPackageVersion = String(lockMetadata.packages[""].version ?? "").trim();
  const changed = previousVersion !== version
    || lockVersion !== version
    || lockPackageVersion !== version;
  if (!changed) return { changed: false, previousVersion, version, files: [], writes: [] };

  packageMetadata.version = version;
  lockMetadata.version = version;
  lockMetadata.packages[""].version = version;
  return {
    changed: true,
    previousVersion,
    version,
    files: [packageFile, lockFile],
    writes: [
      { file: lockFile, content: serializedJson(lockMetadata, lockSource) },
      { file: packageFile, content: serializedJson(packageMetadata, packageSource) },
    ],
  };
}

export function nextAgentHubPublicVersion(previousVersion, releaseType = "patch") {
  if (!["major", "minor", "patch"].includes(releaseType)) throw new Error("Unknown semantic release type");
  if (calendarVersion(previousVersion)) return "2.0.0"; // Explicit first-installer decision.
  const previous = semanticVersion(previousVersion);
  if (previous.metadata) throw new Error("Package public version must not include a build");
  if (previous.prerelease.length && releaseType === "patch") return previous.core.join(".");
  const core = [...previous.core], index = { major: 0, minor: 1, patch: 2 }[releaseType];
  core[index] += 1;
  for (let i = index + 1; i < 3; i++) core[i] = 0;
  const result = core.join("."); semanticVersion(result); return result;
}

export async function prepareAgentHubReleaseVersion({ writeFileImpl = writeFile, ...options } = {}) {
  const result = await inspectAgentHubReleaseVersion(options);
  for (const update of result.writes) await writeFileImpl(update.file, update.content, "utf8");
  const { writes, ...publicResult } = result;
  return publicResult;
}

export async function prepareCommittedAgentHubReleaseVersion(options = {}) {
  // Publication validates the original selected/frozen version. Selecting a
  // new public version belongs to the existing freeze/preparation owner only.
  if (typeof options.expectedVersion !== "string" || !options.expectedVersion
      || options.expectedVersion !== options.expectedVersion.trim()) {
    throw new Error("Publication requires its original expected version");
  }
  const result = await prepareAgentHubReleaseVersion(options);
  if (result.changed) {
    throw new Error(
      `Версия Agent Hub автоматически повышена до v${result.version}. `
      + "Добавьте package.json, package-lock.json и запись CHANGELOG в release-коммит, затем повторите публикацию.",
    );
  }
  return result;
}
