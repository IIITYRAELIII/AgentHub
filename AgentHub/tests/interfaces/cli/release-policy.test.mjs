import assert from "node:assert/strict";
import test from "node:test";

import { runReleasePolicyCli } from "../../../src/interfaces/cli/release-policy.mjs";

test("release policy CLI previews and enables GitHub baseline through explicit command", async () => {
  const outputs = [];
  const calls = [];
  const args = [
    "github-baseline", "preview",
    "--project-root", "D:/bookworm",
    "--owner", "SidorukSV",
    "--repo", "bookworm",
    "--tag", "v5.1.52.148",
    "--release-id", "384471803",
    "--target-commit", "ca9804c0c55face48164a80d4e3caf0620e45053",
  ];

  const preview = await runReleasePolicyCli(args, {
    write: (value) => outputs.push(value),
    previewGithub: async (input) => {
      calls.push(["preview", input]);
      return { status: "preview", repository: { root: input.projectRoot, revision: input.expectedTargetCommit } };
    },
  });

  assert.equal(preview.status, "preview");
  assert.equal(JSON.parse(outputs[0]).status, "preview");
  assert.equal(calls[0][1].releaseTag, "v5.1.52.148");

  const enabled = await runReleasePolicyCli(["github-baseline", "enable", ...args.slice(2)], {
    write: () => {},
    enableGithub: async (input) => ({ status: "adopted", repository: { root: input.projectRoot } }),
  });
  assert.equal(enabled.status, "adopted");
});

test("release policy CLI rejects ambiguous commands", async () => {
  await assert.rejects(
    () => runReleasePolicyCli(["github-baseline", "enable", "--project-root"], { write: () => {} }),
    /Invalid option/u,
  );
  await assert.rejects(
    () => runReleasePolicyCli(["unknown", "enable"], { write: () => {} }),
    /Usage: npm run release:policy/u,
  );
});
