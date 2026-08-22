import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { testFingerprint } from "../../test-suite.mjs";

test("test checkpoint fingerprints only transitive module dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-fingerprint-"));
  try {
    await writeFile(path.join(root, "dependency.mjs"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(root, "side-effect.mjs"), "globalThis.loaded = true;\n", "utf8");
    await writeFile(path.join(root, "test.mjs"), [
      "import './side-effect.mjs';",
      "import { value } from './dependency.mjs';",
      "export default value;",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(root, "unrelated.mjs"), "export const unrelated = 1;\n", "utf8");

    const initial = await testFingerprint("test.mjs", { cwd: root });
    await writeFile(path.join(root, "unrelated.mjs"), "export const unrelated = 2;\n", "utf8");
    assert.equal(await testFingerprint("test.mjs", { cwd: root }), initial);

    await writeFile(path.join(root, "dependency.mjs"), "export const value = 2;\n", "utf8");
    assert.notEqual(await testFingerprint("test.mjs", { cwd: root }), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
