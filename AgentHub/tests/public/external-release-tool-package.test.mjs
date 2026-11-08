import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readReleaseToolPackage } from "../../src/infrastructure/process/release-tool-package.mjs";
import { isRuntimeSourceFile } from "../../src/infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { buildRuntime } from "../../build-runtime.mjs";
const configured = await readReleaseToolPackage();
const { toolIdentity } = await configured.module("src/tool-identity.mjs");

test("independent tool pin loads its exported API and rejects another version", async () => {
  const root = configured.root;
  const identity = await toolIdentity();
  const tool = await readReleaseToolPackage({ root, expectedSha256: identity.sha256 });
  assert.equal(tool.version, identity.version); assert.equal(tool.sha256, identity.sha256);
  assert.equal(typeof (await tool.module("src/publish-all.mjs")).createAllPublicationTools, "function");
  await assert.rejects(readReleaseToolPackage({ root, expectedSha256: "0".repeat(64) }), /differs from its pinned/);
  await assert.rejects(tool.module("../AgentHub/package.json"), /outside its pinned export/);
  await tool.assertUnchanged();
});

test("tool export is self-contained and source-only operators are excluded from runtime", async () => {
  const root = configured.root;
  const manifest = JSON.parse(await readFile(path.join(root, "export-manifest.json"), "utf8"));
  // Static packaging invariant: importing modules cannot exercise an accidental
  // dormant Hub import, so verify every exported import specifier explicitly.
  for (const file of manifest.files.filter(name => name.endsWith(".mjs"))) {
    const text = await readFile(path.join(root, file), "utf8");
    for (const match of text.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("."), `${file}: undeclared external dependency ${specifier}`);
      const target = path.relative(root, path.resolve(root, path.dirname(file), specifier)).replaceAll("\\", "/");
      assert.ok(manifest.files.includes(target), `${file}: import outside standalone export ${target}`);
    }
    assert.equal(isRuntimeSourceFile(`ReleaseTools/${file}`), false);
  }
  for (const file of ["release.mjs", "publish-all.mjs", "publish-changed.mjs", "release-api.mjs", "build-runtime.mjs",
    "src/composition/release-api-runtime.mjs", "src/interfaces/mcp/release-api-host.mjs"]) {
    assert.equal(isRuntimeSourceFile(file), false, file);
  }
  assert.equal(isRuntimeSourceFile("agent-hub-main.mjs"), true);
  assert.equal(isRuntimeSourceFile("release-operation-publication-runner.mjs"), true);
});

test("application self-build delegates only preparation with the exact source and frozen version", async () => {
  let input;
  const result = await buildRuntime(["--runtime-root", "owned-output", "--release-id", "original",
    "--source-commit", "a".repeat(40), "--artifact-version", "2.1.5+build.123"], {
    prepare: async value => { input = value; return { releaseId: value.releaseId }; },
  });
  assert.equal(result.releaseId, "original"); assert.equal(input.publicationRevision, "a".repeat(40));
  assert.equal(input.expectedReleaseVersion, "2.1.5+build.123");
  assert.equal(input.sourceRoot, path.resolve(import.meta.dirname, "../.."));
  await assert.rejects(buildRuntime(["--runtime-root", "owned-output"]), /Self-build requires/);
});
