import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { preparedRuntimeVariantMatchesPublic, runtimeManifestMatchesPackage } from "../../src/domain/runtime-package-identity.mjs";
import { assertAgentHubUpgrade } from "../../src/domain/agent-hub-version.mjs";

function fixture() {
  const prepared = { releaseId: "publication-fixture", sourceRoot: "X:/private/prepared",
    publicationRevision: "a".repeat(40), createdAt: "2026-10-30T00:00:00Z", version: "2.1.0",
    releaseVersion: "2.1.0+build.29", publicVersion: "2.1.0", versionScheme: "semver-build-v1", buildNumber: 29,
    files: [{ path: "agent-hub-main.mjs", bytes: 17, sha256: "b".repeat(64) }] };
  const raw = Buffer.from(JSON.stringify(prepared, null, 2) + "\n");
  const { sourceRoot: _sourceRoot, ...published } = prepared;
  published.distributionSource = { repository: "IIITYRAELIII/AgentHub", commit: prepared.publicationRevision,
    preparedManifestSha256: createHash("sha256").update(raw).digest("hex") };
  return { prepared, raw, published, publicRaw: Buffer.from(JSON.stringify(published, null, 2) + "\n") };
}

test("canonical public package recognizes only its whole exact prepared parent without changing either manifest", () => {
  const f = fixture(), before = Buffer.from(f.raw);
  assert.equal(preparedRuntimeVariantMatchesPublic(f.raw, f.publicRaw), true);
  assert.equal(runtimeManifestMatchesPackage(f.publicRaw, f.publicRaw), true);
  assert.equal(runtimeManifestMatchesPackage(f.raw, f.publicRaw), true);
  assert.deepEqual(f.raw, before);
  assertAgentHubUpgrade(f.prepared, f.published, { sameArtifact: runtimeManifestMatchesPackage(f.raw, f.publicRaw) });
  assert.equal(preparedRuntimeVariantMatchesPublic(f.publicRaw, f.raw), false, "lineage is directional");
});

test("equal version or payload alone cannot waive raw parent, source or complete manifest identity", () => {
  const f = fixture();
  for (const change of [
    (p) => { p.distributionSource.preparedManifestSha256 = "c".repeat(64); },
    (p) => { p.distributionSource.commit = "d".repeat(40); },
    (p) => { p.distributionSource.repository = "foreign/publisher"; },
    (p) => { p.distributionSource.extra = true; },
    (p) => { p.sourceRoot = "X:/leaked-source"; },
    (p) => { p.releaseId = "foreign"; },
    (p) => { p.files[0].bytes++; },
    (p) => { p.createdAt = "different"; },
    (p) => { p.extra = true; },
  ]) {
    const published = structuredClone(f.published); change(published);
    const raw = Buffer.from(JSON.stringify(published));
    assert.equal(runtimeManifestMatchesPackage(f.raw, raw), false);
    assert.throws(() => assertAgentHubUpgrade(f.prepared, published, {
      sameArtifact: runtimeManifestMatchesPackage(f.raw, raw),
    }), /downgrade or reuse/u);
  }
  assert.equal(runtimeManifestMatchesPackage(Buffer.concat([f.raw, Buffer.from(" ")]), f.publicRaw), false);
  assert.equal(preparedRuntimeVariantMatchesPublic("not-json", f.publicRaw), false);
});
