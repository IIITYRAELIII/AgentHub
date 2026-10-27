import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyRuntimeImportClosure } from "../../src/infrastructure/filesystem/runtime-manifest-verifier.mjs";

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
  await verifyRuntimeImportClosure(root, files.sort());
});
