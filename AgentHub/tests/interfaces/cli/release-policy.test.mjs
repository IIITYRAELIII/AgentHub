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

test("release policy CLI previews and records one exact Task upstream adoption", async () => {
  const calls = [];
  const args = [
    "task-upstream-adoption", "preview",
    "--project-root", "D:/bookworm",
    "--task-id", "51515151-5151-4151-8151-515151515151",
    "--branch", "HUB-216",
    "--task-base", "1111111111111111111111111111111111111111",
    "--accepted-local-main", "2222222222222222222222222222222222222222",
    "--adopted-commit", "3333333333333333333333333333333333333333",
    "--snapshot-commit", "4444444444444444444444444444444444444444",
    "--request-id", "operator-review-1",
  ];
  const preview = await runReleasePolicyCli(args, {
    write: () => {},
    previewTaskUpstream: async (input) => {
      calls.push(["preview", input]);
      return { status: "preview", recordHash: "receipt" };
    },
    enableTaskUpstream: async () => assert.fail("enable was not expected"),
  });
  assert.equal(preview.status, "preview");
  assert.equal(calls[0][1].acceptedLocalMainCommit, "2222222222222222222222222222222222222222");

  const enabled = await runReleasePolicyCli(["task-upstream-adoption", "enable", ...args.slice(2)], {
    write: () => {},
    previewTaskUpstream: async () => assert.fail("preview was not expected"),
    enableTaskUpstream: async (input) => {
      calls.push(["enable", input]);
      return { status: "adopted", recordHash: "receipt" };
    },
  });
  assert.equal(enabled.status, "adopted");
  assert.equal(calls[1][1].requestId, "operator-review-1");
});

test("release policy CLI previews and enables one exact local publisher receipt", async () => {
  const calls = [];
  const args = [
    "local-publication-receipt", "preview",
    "--project-root", "D:/repo",
    "--workspace-id", "workspace-1",
    "--run-id", "run-1",
    "--revision", "1".repeat(40),
    "--generation", "generation-1",
    "--published-at", "2026-09-11T16:24:23.662Z",
    "--state-sha256", "2".repeat(64),
    "--receipt-sha256", "3".repeat(64),
    "--release-id", "release-1",
    "--origin", "https://github.com/Example/Utilities.git",
    "--origin-main", "4".repeat(40),
    "--request-id", "operator-1",
  ];
  const preview = await runReleasePolicyCli(args, {
    write: () => {},
    previewLocalPublication: async (input) => {
      calls.push(["preview", input]);
      return { status: "preview", repository: { root: input.projectRoot } };
    },
  });
  assert.equal(preview.status, "preview");
  assert.equal(calls[0][1].expectedReceiptSha256, "3".repeat(64));

  const enabled = await runReleasePolicyCli(["local-publication-receipt", "enable", ...args.slice(2)], {
    write: () => {},
    enableLocalPublication: async (input) => {
      calls.push(["enable", input]);
      return { status: "adopted", repository: { root: input.projectRoot } };
    },
  });
  assert.equal(enabled.status, "adopted");
  assert.equal(calls[1][1].requestId, "operator-1");
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
