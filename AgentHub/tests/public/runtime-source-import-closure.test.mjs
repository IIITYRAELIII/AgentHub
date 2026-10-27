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
  await visit("release-progress");
  await verifyRuntimeImportClosure(root, files.filter(isRuntimeSourceFile).sort());
});

test("native source membership reads the declared release observer graph and still refuses a missing identity", async () => {
  const bodies = new Map([
    ["src/infrastructure/process/release-progress-monitor.mjs", 'import { identity } from "../../../release-progress/identity.mjs"; export { identity };'],
    ["release-progress/server.mjs", 'import { identity } from "./identity.mjs"; import { read } from "./reader.mjs"; export { identity, read };'],
    ["release-progress/reader.mjs", 'export const read = () => null;'],
    ["release-progress/identity.mjs", 'export const identity = "exact observer identity";'],
    ["release-progress/index.html", "<main>observer</main>"],
    ["release-progress/app.js", "void 0;"],
    ["release-progress/style.css", "main { display: block; }"],
    ["release-progress/unrelated.mjs", 'import "./not-shipped.mjs";'],
    ["release-progress/README.md", "not a runtime asset"],
  ]);
  const names = [...bodies.keys()];
  const included = names.filter(isRuntimeSourceFile);
  const sources = new Map(names.filter(isRuntimeSourceModule).map(name => [name, Buffer.from(bodies.get(name))]));
  assert.equal(included.includes("release-progress/unrelated.mjs"), false);
  assert.equal(included.includes("release-progress/README.md"), false);
  const readModule = name => sources.get(name).toString("utf8");
  await verifyRuntimeImportClosure("/owned/source", included, { readModule });
  await assert.rejects(verifyRuntimeImportClosure("/owned/source", included.filter(name => name !== "release-progress/identity.mjs"), {
    readModule,
  }), /missing relative imports:.*release-progress\/identity\.mjs/u);
});
