import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const AGENT_HUB_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const CALENDAR_VERSION_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/u;

function calendarVersionParts(value) {
  const match = CALENDAR_VERSION_PATTERN.exec(String(value ?? "").trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    ? parts
    : null;
}

function compareCalendarVersions(left, right) {
  const leftParts = calendarVersionParts(left);
  const rightParts = calendarVersionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

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

  const version = expectedVersion == null
    ? agentHubCalendarVersion(now)
    : String(expectedVersion).trim();
  if (!calendarVersionParts(version)) throw new Error("Agent Hub frozen release version is invalid");
  const previousVersion = String(packageMetadata.version ?? "").trim();
  const comparison = compareCalendarVersions(previousVersion, version);
  if (comparison !== null && comparison > 0) {
    throw new Error(`Agent Hub version ${previousVersion} is newer than local release date ${version}`);
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

export async function prepareAgentHubReleaseVersion({ writeFileImpl = writeFile, ...options } = {}) {
  const result = await inspectAgentHubReleaseVersion(options);
  for (const update of result.writes) await writeFileImpl(update.file, update.content, "utf8");
  const { writes, ...publicResult } = result;
  return publicResult;
}

export async function prepareCommittedAgentHubReleaseVersion(options = {}) {
  const result = await prepareAgentHubReleaseVersion(options);
  if (result.changed) {
    throw new Error(
      `Версия Agent Hub автоматически повышена до v${result.version}. `
      + "Добавьте package.json, package-lock.json и запись CHANGELOG в release-коммит, затем повторите публикацию.",
    );
  }
  return result;
}
