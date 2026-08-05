import assert from "node:assert/strict";
import test from "node:test";
import { findRepositoryWriteConflict } from "./src/infrastructure/filesystem/repository-conflict.mjs";

const target = {
  provider: "codex",
  projectRoot: "C:\\Work\\Project",
  threadId: "target",
};

test("repository conflict ignores the same task and detects another task in the same repo", () => {
  const conflict = findRepositoryWriteConflict(target, "C:\\Work\\Repo", [{
    ...target,
    repoRoot: "C:\\Work\\Repo",
    taskTitle: "Та же задача",
  }, {
    provider: "claude",
    projectRoot: "C:\\Work\\Other",
    threadId: "other",
    repoRoot: "C:\\Work\\Repo",
    taskTitle: "Другая задача",
  }]);
  assert.equal(conflict?.taskTitle, "Другая задача");
});

test("repository conflict allows tasks in different repositories", () => {
  assert.equal(findRepositoryWriteConflict(target, "C:\\Work\\RepoA", [{
    provider: "claude",
    projectRoot: "C:\\Work\\Other",
    threadId: "other",
    repoRoot: "C:\\Work\\RepoB",
  }]), null);
});

test("repository conflict detects an overlap between multi-repository workspaces", () => {
  const conflict = findRepositoryWriteConflict(target, ["C:\\Work\\A", "C:\\Work\\Shared"], [{
    provider: "codex",
    projectRoot: "C:\\Work\\Other",
    threadId: "other",
    repoRoots: ["C:\\Work\\B", "C:\\Work\\Shared"],
  }]);
  assert.equal(conflict?.threadId, "other");
});
