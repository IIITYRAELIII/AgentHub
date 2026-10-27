import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactVersionIdentity, MAX_BUILD_NUMBER } from "../../../src/domain/agent-hub-version.mjs";
import { nextRuntimeReleaseVersion } from "../../../src/infrastructure/filesystem/runtime-release-version.mjs";

async function fixture(t, manifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-retained-suffix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "old");
  await mkdir(release);
  const file = path.join(release, "runtime-manifest.json");
  const bytes = JSON.stringify({ releaseId: "old", version: "2.0.0", releaseVersion: "2.0.0.2", files: [], ...manifest });
  await writeFile(file, bytes);
  return { root, release, file, bytes: Buffer.from(bytes) };
}

test("retained pre-migration semantic suffix contributes its build without changing identity or bytes", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "first"));
  await writeFile(path.join(f.root, "first/runtime-manifest.json"), JSON.stringify({
    releaseId: "first", version: "2.0.0", releaseVersion: "2.0.0.1", files: [],
  }));
  assert.equal(await nextRuntimeReleaseVersion({ releasesDir: f.root, packageVersion: "2.0.0", allocationFloor: 0 }), "2.0.0+build.3");
  assert.equal(await nextRuntimeReleaseVersion({ releasesDir: f.root, packageVersion: "2.0.0", allocationFloor: 40 }), "2.0.0+build.41");
  assert.deepEqual(await readFile(f.file), f.bytes);
  // Allocation migration is not permission to install, rename or emit this old format.
  assert.throws(() => artifactVersionIdentity("2.0.0.2"), /Invalid artifact version/u);
});

test("retained suffix observes other public versions and verified Android code globally", async t => {
  const f = await fixture(t, { version: "2.0.10", releaseVersion: "2.0.10.29" });
  const mobile = Buffer.from(JSON.stringify({ versionCode: 50 }));
  await mkdir(path.join(f.release, "assets/mobile"), { recursive: true });
  await writeFile(path.join(f.release, "assets/mobile/update.json"), mobile);
  const manifest = JSON.parse(f.bytes);
  manifest.files.push({ path: "assets/mobile/update.json", bytes: mobile.length,
    sha256: createHash("sha256").update(mobile).digest("hex") });
  await writeFile(f.file, JSON.stringify(manifest));
  assert.equal(await nextRuntimeReleaseVersion({ releasesDir: f.root, packageVersion: "2.1.0", allocationFloor: 0 }), "2.1.0+build.51");
  await writeFile(path.join(f.release, "assets/mobile/update.json"), JSON.stringify({ versionCode: 49 }));
  await assert.rejects(nextRuntimeReleaseVersion({ releasesDir: f.root, packageVersion: "2.1.0", allocationFloor: 0 }), /integrity/u);
});

for (const [label, changed] of [
  ["unknown scheme", { versionScheme: "unknown" }],
  ["partial new metadata", { versionScheme: "semver-build-v1" }],
  ["explicit null metadata", { publicVersion: null }],
  ["fabricated build", { buildNumber: 2 }],
  ["mismatched public prefix", { releaseVersion: "2.1.0.2" }],
  ["leading-zero core", { version: "02.0.0", releaseVersion: "02.0.0.2" }],
  ["leading-zero suffix", { releaseVersion: "2.0.0.02" }],
  ["zero suffix", { releaseVersion: "2.0.0.0" }],
  ["missing suffix", { releaseVersion: undefined }],
  ["coerced artifact", { releaseVersion: ["2.0.0.2"] }],
  ["prerelease suffix", { version: "2.0.0-rc.1", releaseVersion: "2.0.0-rc.1.2" }],
  ["non-ASCII suffix", { releaseVersion: "2.0.0.2\u0660" }],
  ["unbounded suffix", { releaseVersion: `2.0.0.${MAX_BUILD_NUMBER + 1}` }],
  ["foreign release", { releaseId: "foreign" }],
  ["missing inventory", { files: undefined }],
  ["partial canonical artifact", { releaseVersion: "2.0.0+build.2" }],
]) {
  test(`retained suffix refuses ${label} and preserves the original`, async t => {
    const f = await fixture(t, changed);
    await assert.rejects(nextRuntimeReleaseVersion({ releasesDir: f.root, packageVersion: "2.0.0", allocationFloor: 0 }));
    assert.deepEqual(await readFile(f.file), f.bytes);
  });
}

test("retained suffix cannot overflow the Android build limit", async t => {
  const f = await fixture(t, { releaseVersion: `2.0.0.${MAX_BUILD_NUMBER}` });
  await assert.rejects(nextRuntimeReleaseVersion({ releasesDir: f.root, packageVersion: "2.0.0", allocationFloor: 0 }), /build/u);
  assert.deepEqual(await readFile(f.file), f.bytes);
});
