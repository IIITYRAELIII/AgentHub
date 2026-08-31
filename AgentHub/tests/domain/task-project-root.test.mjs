import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredProjectForTaskWorkingDirectory,
  taskProjectRoot,
} from "../../src/domain/task-project-root.mjs";

test("Task project root is owned by Stream settings with Workspace fallback", () => {
  const workspace = { settings: { workingDirectory: "D:/workspace" } };
  assert.equal(taskProjectRoot({
    workspace,
    stream: { settings: { workingDirectory: "D:/stream" } },
  }), "D:/stream");
  assert.equal(taskProjectRoot({
    workspace,
    stream: { settings: { workingDirectory: "" } },
  }), "D:/workspace");
});

test("a verified managed Task worktree resolves through its configured repository", async () => {
  const configured = { path: "D:/repo" };
  const calls = [];
  const project = await configuredProjectForTaskWorkingDirectory({
    workingDirectory: "C:/AgentHub/task-worktrees/task/repo",
    findProject: (value) => value === configured.path ? configured : null,
    taskGitWorkspaces: {
      managedRepositoryRoot: async (value) => {
        calls.push(value);
        return configured.path;
      },
    },
  });

  assert.equal(project, configured);
  assert.deepEqual(calls, ["C:/AgentHub/task-worktrees/task/repo"]);
});
