import { readdir } from "node:fs/promises";
import path from "node:path";
import { E2E_FILES, VSCODE_FILES, VISUAL_FILES, PROFILE_FILES } from "../../domain/test-suite-groups.mjs";

// Publication executes in frozen/main. The rolling dev contour is a separate
// preview, not a second check of that immutable release source.
// Product checks are contributed by the independently pinned release recipe.
export const RELEASE_CHECK_IDS = [];

export async function discoverReleaseTestInventory(root) {
  const entries = new Map();
  const add = entry => entries.set(entry.id, entry);
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!["node_modules", "build", "dist", ".wrangler", "WIP", ".git"].includes(entry.name)) await walk(path.join(directory, entry.name));
      } else if (entry.name.endsWith(".test.mjs") && !entry.name.endsWith(".e2e.test.mjs")) {
        const file = path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/");
        add({ id: file, file, suite: file.startsWith("tests/composition/") ? "architecture" : VISUAL_FILES.includes(file) ? "visual" : "unit", isolation: true });
      }
    }
  }
  await walk(root);
  for (const file of E2E_FILES) add({ id: file, file, suite: "e2e", isolation: false });
  for (const file of VSCODE_FILES) add({ id: `VSCodeExtension/${file}`, file, suite: "vscode", directory: "VSCodeExtension", isolation: false });
  for (const [profile, files] of Object.entries(PROFILE_FILES)) for (const file of files) {
    add({ id: `profile:${profile}:${file}`, file, suite: profile, isolation: profile !== "reliability", env: { AGENT_HUB_TEST_PROFILES: profile } });
  }
  add({ id: "syntax-check.mjs", file: "syntax-check.mjs", suite: "syntax" });
  add({ id: "install_test.py", file: "install_test.py", suite: "installer" });
  for (const id of RELEASE_CHECK_IDS) add({ id, suite: "release-check" });
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}
