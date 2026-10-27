import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { artifactVersion, artifactVersionIdentity, assertAgentHubUpgrade, compareSemanticVersions,
  displayArtifactVersion, manifestVersionIdentity, semanticVersion } from "../../src/domain/agent-hub-version.mjs";
import { nextRuntimeReleaseVersion } from "../../src/infrastructure/filesystem/runtime-release-version.mjs";
import { inspectAgentHubReleaseVersion, nextAgentHubPublicVersion } from "../../src/infrastructure/filesystem/release-version.mjs";
import { readAgentHubReleaseVersion } from "../../src/infrastructure/filesystem/agent-hub-package.mjs";

const manifest = (version, build, releaseId = "fixture") => ({ releaseId, version,
  publicVersion: version, buildNumber: build, versionScheme: "semver-build-v1", releaseVersion: artifactVersion(version, build) });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-semver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("SemVer precedence includes numeric prereleases and excludes build metadata", () => {
  const ordered = ["2.0.0-alpha", "2.0.0-alpha.1", "2.0.0-alpha.beta", "2.0.0-beta",
    "2.0.0-beta.2", "2.0.0-beta.11", "2.0.0-rc.1", "2.0.0", "2.0.9", "2.0.10", "2.1.0", "3.0.0"];
  for (let i = 1; i < ordered.length; i++) assert.equal(compareSemanticVersions(ordered[i-1], ordered[i]), -1);
  assert.equal(compareSemanticVersions("2.0.0+build.10", "2.0.0+build.9"), 0);
});
for (const invalid of ["02.0.0", "2.0", "2.0.0-01", "2.0.0-rc.01", "2.0.0+", "2.0.0-",
  "2.0.0\n", "9007199254740992.0.0"]) {
  test("invalid semantic version refuses: " + JSON.stringify(invalid), () => assert.throws(() => semanticVersion(invalid)));
}
test("first installer is 2.0.0, later changes use semantic patch/minor/major", () => {
  assert.equal(nextAgentHubPublicVersion("2026.10.22"), "2.0.0");
  assert.equal(nextAgentHubPublicVersion("2.0.9"), "2.0.10");
  assert.equal(nextAgentHubPublicVersion("2.0.9", "minor"), "2.1.0");
  assert.equal(nextAgentHubPublicVersion("2.3.9", "major"), "3.0.0");
  assert.equal(nextAgentHubPublicVersion("2.0.0-rc.1"), "2.0.0");
});
test("verified legacy identity migrates; semantic downgrade and build reuse refuse", () => {
  const old = { version: "2026.10.22", releaseVersion: "2026.10.22.31" };
  assert.equal(assertAgentHubUpgrade(old, manifest("2.0.0", 32)).buildNumber, 32);
  for (const next of [manifest("1.9.9", 33), manifest("2.0.0-rc.1", 33), manifest("2.0.0", 32)]) {
    assert.throws(() => assertAgentHubUpgrade(manifest("2.0.0", 32), next), /downgrade|reuse/);
  }
  assert.doesNotThrow(() => assertAgentHubUpgrade(manifest("2.0.9", 32), manifest("2.0.10", 33)));
  assert.throws(() => assertAgentHubUpgrade({ version: "untrusted" }, manifest("2.0.0", 33)));
  assert.throws(() => assertAgentHubUpgrade(manifest("2.0.0", 32), old));
});
test("artifact identities bind public version, bounded integer build and display", () => {
  const exact = manifest("2.0.0", 123);
  assert.equal(displayArtifactVersion(exact.releaseVersion), "2.0.0 · сборка 123");
  assert.equal(displayArtifactVersion("2026.10.22.31"), "2026.10.22.31");
  for (const changed of [{ ...exact, buildNumber: 124 }, { ...exact, publicVersion: "2.1.0" },
    { ...exact, versionScheme: "unknown" }]) assert.throws(() => manifestVersionIdentity(changed));
  for (const value of ["2.0.0+build.0", "2.0.0+build.01", "2.0.0+build.2100000001", "2.0.0.4"]) {
    assert.throws(() => artifactVersionIdentity(value));
  }
});
test("existing manifest allocator observes global builds and Android codes across versions", async t => {
  const root = await fixture(t);
  for (const [name, value] of [["old", { version: "2026.10.22", releaseVersion: "2026.10.22.31" }],
    ["semantic", manifest("2.0.0", 40)]]) {
    await mkdir(path.join(root, name)); await writeFile(path.join(root, name, "runtime-manifest.json"), JSON.stringify({ ...value, releaseId: name, files: [] }));
  }
  await mkdir(path.join(root, "old/assets/mobile"), { recursive: true });
  await writeFile(path.join(root, "old/assets/mobile/update.json"), JSON.stringify({ versionCode: 50 }));
  const priorFile = path.join(root, "old/runtime-manifest.json");
  const prior = JSON.parse(await readFile(priorFile, "utf8"));
  const mobile = await readFile(path.join(root, "old/assets/mobile/update.json"));
  prior.files.push({ path: "assets/mobile/update.json", bytes: mobile.length, sha256: createHash("sha256").update(mobile).digest("hex") });
  await writeFile(priorFile, JSON.stringify(prior));
  assert.equal(await nextRuntimeReleaseVersion({ releasesDir: root, packageVersion: "2.0.1", allocationFloor: 10 }), "2.0.1+build.51");
  assert.equal(await nextRuntimeReleaseVersion({ releasesDir: root, packageVersion: "2026.10.22" }), "2026.10.22.32");
  // Frozen floor is derived from original N. No new time-derived allocation on retry.
  assert.equal(await nextRuntimeReleaseVersion({ releasesDir: root, packageVersion: "2.0.1", allocationFloor: 60 }), "2.0.1+build.61");
});
test("unknown and partial retained allocation refuses without deleting evidence", async t => {
  const root = await fixture(t); await mkdir(path.join(root, "partial.staging-original"));
  await assert.rejects(nextRuntimeReleaseVersion({ releasesDir: root, packageVersion: "2.0.0" }), /Partial/);
  await rm(path.join(root, "partial.staging-original"), { recursive: true });
  await mkdir(path.join(root, "unknown"));
  await assert.rejects(nextRuntimeReleaseVersion({ releasesDir: root, packageVersion: "2.0.0" }), /Unknown/);
});

test("allocator verifies shared Android content without requiring every retained duplicate body", async t => {
  const root = await fixture(t), raw = Buffer.from(JSON.stringify({ versionCode: 100 }));
  const metadata = { path: "assets/mobile/update.json", bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
  for (const name of ["retired", "current"]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "runtime-manifest.json"), JSON.stringify({
      releaseId: name, version: "2026.10.12", releaseVersion: "2026.10.12.31", files: [metadata] }));
  }
  await mkdir(path.join(root, "current/assets/mobile"), { recursive: true });
  const file = path.join(root, "current/assets/mobile/update.json");
  await writeFile(file, raw);
  assert.equal(await nextRuntimeReleaseVersion({ releasesDir: root, packageVersion: "2.0.0", allocationFloor: 10 }), "2.0.0+build.101");
  await writeFile(file, Buffer.from("tampered"));
  await assert.rejects(nextRuntimeReleaseVersion({ releasesDir: root, packageVersion: "2.0.0" }), /integrity/u);
  await rm(file);
  await assert.rejects(nextRuntimeReleaseVersion({ releasesDir: root, packageVersion: "2.0.0" }), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, "retired/assets/mobile/update.json")), { code: "ENOENT" });
});
test("release metadata inspection migrates without editing Task files; old frozen calendar remains exact", async t => {
  const root = await fixture(t);
  const pkg = { name: "agent-hub", version: "2026.10.12" };
  const lock = { ...pkg, packages: { "": pkg } };
  await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  const before = await readFile(path.join(root, "package.json"));
  assert.equal((await inspectAgentHubReleaseVersion({ root })).version, "2.0.0");
  assert.deepEqual(await readFile(path.join(root, "package.json")), before);
  assert.equal((await inspectAgentHubReleaseVersion({ root, expectedVersion: "2026.10.12" })).changed, false);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ ...pkg, version: "2.0.0" }));
  await writeFile(path.join(root, "runtime-manifest.json"), JSON.stringify(manifest("2.0.0", 123)));
  assert.equal(readAgentHubReleaseVersion({ packageFile: path.join(root, "package.json") }), "2.0.0+build.123");
  await assert.rejects(inspectAgentHubReleaseVersion({ root, expectedVersion: "2026.10.12" }), /newer/);
});
test("Android uses frozen public version/code without allocating a second build", () => {
  const result = execFileSync(process.execPath, ["release-version.mjs", "--android-artifact", "2.0.0-rc.1+build.30000001"],
    { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" });
  assert.deepEqual(JSON.parse(result), { versionName: "2.0.0-rc.1", versionCode: 30000001 });
});
