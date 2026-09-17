import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  return execFileAsync("git", args, {
    cwd: repositoryRoot,
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
