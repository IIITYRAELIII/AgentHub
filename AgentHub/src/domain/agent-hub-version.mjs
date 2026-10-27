// Product precedence and artifact identity are different contracts. Build
// metadata never participates in SemVer precedence; it is checked separately.
export const SEMVER_BUILD_SCHEME = "semver-build-v1";
export const MAX_BUILD_NUMBER = 2_100_000_000; // Android's existing platform bound.
const NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`, "u");

export function semanticVersion(value) {
  if (typeof value !== "string" || value.length > 128) throw new Error("Invalid semantic version");
  const match = SEMVER.exec(value);
  if (!match || match.slice(1, 4).some(n => !Number.isSafeInteger(Number(n)))
      || (match[4] ?? "").split(".").some(n => /^\d+$/u.test(n) && n.length > 1 && n[0] === "0")) {
    throw new Error("Invalid semantic version");
  }
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [], metadata: match[5] ?? null };
}

export function compareSemanticVersions(left, right) {
  const a = semanticVersion(left), b = semanticVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn) return x.length === y.length ? (x < y ? -1 : 1) : Math.sign(x.length - y.length);
    return x < y ? -1 : 1;
  }
  return 0;
}

export function calendarVersion(value) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/u.exec(String(value));
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function buildNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BUILD_NUMBER) throw new Error("Invalid build number");
  return value;
}

export function artifactVersion(publicVersion, build) {
  if (semanticVersion(publicVersion).metadata) throw new Error("Public version must not contain build metadata");
  return `${publicVersion}+build.${buildNumber(build)}`;
}

export function artifactVersionIdentity(value) {
  if (typeof value !== "string") throw new Error("Invalid artifact version");
  const semantic = /^(.*)\+build\.([1-9]\d*)$/u.exec(value);
  if (semantic) {
    const publicVersion = semantic[1], number = buildNumber(Number(semantic[2]));
    if (artifactVersion(publicVersion, number) !== value) throw new Error("Invalid artifact version");
    return { versionScheme: SEMVER_BUILD_SCHEME, publicVersion, buildNumber: number };
  }
  const legacy = /^(\d+\.\d+\.\d+)(?:\.([1-9]\d*))?$/u.exec(value);
  if (!legacy || !calendarVersion(legacy[1])) throw new Error("Invalid artifact version");
  return { versionScheme: "legacy-calendar", publicVersion: legacy[1],
    buildNumber: legacy[2] ? buildNumber(Number(legacy[2])) : 1 };
}

export function manifestVersionIdentity(manifest) {
  const identity = artifactVersionIdentity(manifest?.releaseVersion ?? manifest?.version);
  if (identity.publicVersion !== manifest?.version) throw new Error("Manifest public/artifact version mismatch");
  if (identity.versionScheme === SEMVER_BUILD_SCHEME) {
    if (manifest.versionScheme !== SEMVER_BUILD_SCHEME || manifest.buildNumber !== identity.buildNumber
        || manifest.publicVersion !== identity.publicVersion) {
      throw new Error("Manifest version scheme/build mismatch");
    }
  } else if (manifest.versionScheme != null || manifest.buildNumber != null || manifest.publicVersion != null) {
    throw new Error("Unknown legacy manifest version metadata");
  }
  return identity;
}

export function assertAgentHubUpgrade(previous, next, { sameArtifact = false } = {}) {
  const b = manifestVersionIdentity(next);
  if (!previous) return b;
  const a = manifestVersionIdentity(previous);
  if (sameArtifact) return b;
  if (b.versionScheme !== SEMVER_BUILD_SCHEME
      || (a.versionScheme === "legacy-calendar" && semanticVersion(b.publicVersion).core[0] < 2)
      || (a.versionScheme === SEMVER_BUILD_SCHEME && compareSemanticVersions(b.publicVersion, a.publicVersion) < 0)
      || b.buildNumber <= a.buildNumber) throw new Error("Version/build downgrade or reuse refused");
  return b;
}

export function displayArtifactVersion(value) {
  try {
    const identity = artifactVersionIdentity(value);
    if (identity.versionScheme === SEMVER_BUILD_SCHEME) return `${identity.publicVersion} · сборка ${identity.buildNumber}`;
  } catch { /* Legacy/unknown labels are displayed without inventing a build. */ }
  return value;
}
