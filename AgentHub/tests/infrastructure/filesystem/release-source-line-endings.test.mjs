import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const repositoryRoot = path.dirname(projectRoot);

const normalizedReleaseSources = [
  "AgentHub/docs/contracts/PERF-001-local-latency.md",
  "AgentHub/docs/contracts/RST-001-restart-recovery.md",
  "AgentHub/src/application/hub-mcp-service.mjs",
  "AgentHub/src/application/task-operation-reconciliation-service.mjs",
  "AgentHub/src/application/workspace-release-preflight-service.mjs",
  "AgentHub/src/domain/task-release-snapshot.mjs",
  "AgentHub/src/infrastructure/filesystem/release-git-workspace.mjs",
  "AgentHub/src/infrastructure/filesystem/release-task-net-projection.mjs",
  "AgentHub/src/infrastructure/filesystem/task-git-workspace.mjs",
  "AgentHub/src/infrastructure/persistence/task-board-store.mjs",
  "AgentHub/tests/application/task-operation-reconciliation-service.test.mjs",
];

async function git(args, options = {}) {
  return gitAt(repositoryRoot, args, options);
}

async function gitAt(cwd, args, options = {}) {
  return execFileAsync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

test("release source artifacts have repository-owned LF normalization", async () => {
  const { stdout: attributes } = await git([
    "check-attr",
    "--cached",
    "eol",
    "--",
    ...normalizedReleaseSources,
  ]);
  const lines = attributes.trim().split(/\r?\n/u);
  assert.equal(lines.length, normalizedReleaseSources.length);
  for (const line of lines) {
    assert.match(line, /: eol: lf$/u);
  }

  for (const sourcePath of normalizedReleaseSources) {
    const { stdout: blob } = await git(["show", `:${sourcePath}`], { encoding: "buffer" });
    assert.equal(
      blob.includes(13),
      false,
      `${sourcePath} must not contain CR bytes in the Git artifact`,
    );
  }
});

test("repository attributes normalize staged release sources under either autocrlf policy", async (t) => {
  const attributes = await readFile(path.join(projectRoot, ".gitattributes"));
  for (const autoCrlf of ["true", "false"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `ah-release-eol-${autoCrlf}-`));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    await gitAt(root, ["init", "--initial-branch=main"]);
    await gitAt(root, ["config", "core.autocrlf", autoCrlf]);
    await writeFile(path.join(root, ".gitattributes"), attributes);
    await writeFile(path.join(root, "release.mjs"), "first\r\nsecond\r\n", "utf8");
    await writeFile(path.join(root, "contract.md"), "first\r\nsecond\r\n", "utf8");
    await writeFile(path.join(root, "module.bsl"), "first\r\nsecond\r\n", "utf8");
    const binary = Buffer.from([0, 13, 10, 255, 13, 10]);
    await writeFile(path.join(root, "fixture.bin"), binary);
    await gitAt(root, ["add", "--", "."]);

    for (const sourcePath of ["release.mjs", "contract.md"]) {
      const { stdout } = await gitAt(root, ["show", `:${sourcePath}`], { encoding: "buffer" });
      assert.deepEqual(stdout, Buffer.from("first\nsecond\n"));
    }
    const { stdout: binaryBlob } = await gitAt(root, ["show", ":fixture.bin"], { encoding: "buffer" });
    assert.deepEqual(binaryBlob, binary);
    const { stdout: unrelatedAttributes } = await gitAt(root, [
      "check-attr", "eol", "--", "module.bsl", "fixture.bin",
    ]);
    assert.match(unrelatedAttributes, /module\.bsl: eol: unspecified/u);
    assert.match(unrelatedAttributes, /fixture\.bin: eol: unspecified/u);
  }
});
