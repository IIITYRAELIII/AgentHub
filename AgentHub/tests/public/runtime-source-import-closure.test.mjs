import { readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isRuntimeSourceFile, isRuntimeSourceModule, verifyRuntimeImportClosure } from "../../src/infrastructure/filesystem/runtime-manifest-verifier.mjs";

// Exercise the packaging contract against this checkout, including a native
// composition. Unit fixtures alone cannot detect a merge that drops a module
// while retaining its importer. No runtime or provider is started here.
test("the current source checkout contains every first-party runtime import", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile()) files.push(entry.name);
  }
  await visit("src");
  await visit("assets");
  await verifyRuntimeImportClosure(root, files.filter(isRuntimeSourceFile).sort());
});

test("the retired release observer graph is outside runtime source membership", () => {
  for (const name of ["release-progress/server.mjs", "release-progress/identity.mjs", "release-progress/index.html"]) {
    assert.equal(isRuntimeSourceFile(name), false, name);
  }
});

test("native source membership includes the declared Git JSON companion and refuses missing dependencies", async () => {
  const importer = "src/infrastructure/filesystem/preparation-git-isolation.mjs";
  const policy = "src/infrastructure/filesystem/git-invocation-policy.json";
  const helper = "src/infrastructure/filesystem/preparation-policy-helper.mjs";
  const unrelated = "src/infrastructure/filesystem/unrelated-data.json";
  const bodies = new Map([
    [importer, 'import policy from "./git-invocation-policy.json" with { type: "json" }; import "./preparation-policy-helper.mjs"; export { policy };'],
    [policy, '{"windowsPrefix":["-c","core.longpaths=true"]}'],
    [helper, "export const identity = 'fixture';"],
    [unrelated, "{}"],
  ]);
  // Use the same source membership and module reads as package verification.
  const names = [...bodies.keys()];
  const sources = new Map(names.filter(isRuntimeSourceModule)
    .map(name => [name, Buffer.from(bodies.get(name))]));
  const included = names.filter(isRuntimeSourceFile);
  const readModule = name => sources.get(name).toString("utf8");
  assert.equal(included.includes(unrelated), false);
  await verifyRuntimeImportClosure("/owned/source", included, { readModule });
  await assert.rejects(verifyRuntimeImportClosure("/owned/source",
    names.filter(name => name !== policy).filter(isRuntimeSourceFile), { readModule }),
  /missing relative imports:.*\.\/git-invocation-policy\.json/u);
  await assert.rejects(verifyRuntimeImportClosure("/owned/source",
    names.filter(name => name !== helper).filter(isRuntimeSourceFile), { readModule }),
  /missing relative imports:.*\.\/preparation-policy-helper\.mjs/u);
});
