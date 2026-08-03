import assert from "node:assert/strict";
import test from "node:test";

import {
  localCodexRepositoryPath,
  resolveCodexJournalProject,
} from "./codex-journal-project.mjs";

const project = { path: "D:\\VSC_Tyrael" };

function findProject(value) {
  const candidate = String(value ?? "").toLowerCase();
  return candidate === project.path.toLowerCase()
    || candidate.startsWith(`${project.path.toLowerCase()}\\`)
    ? project
    : null;
}

test("external Codex exec resolves through its local repository URL", async () => {
  const resolved = await resolveCodexJournalProject({
    cwd: "C:\\Users\\user\\AppData\\Local\\Temp\\codex-exec",
    path: "rollout.jsonl",
  }, {
    findProject,
    readSession: async () => ({
      repositoryUrl: "D:\\VSC_Tyrael\\Utilities\\WIP\\fixture\\origin.git",
    }),
  });

  assert.equal(resolved, project);
});

test("external Codex exec cannot import an unrelated or remote repository", async () => {
  for (const repositoryUrl of [
    "C:\\unrelated\\origin.git",
    "https://example.com/team/repository.git",
  ]) {
    assert.equal(await resolveCodexJournalProject({
      cwd: "C:\\Temp\\codex-exec",
      repositoryUrl,
    }, { findProject }), null);
  }
});

test("a disappeared external rollout does not block journal audit", async () => {
  assert.equal(await resolveCodexJournalProject({
    cwd: "C:\\Temp\\codex-exec",
    path: "missing-rollout.jsonl",
  }, {
    findProject,
    readSession: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  }), null);
});

test("local repository paths accept native and file URL forms", () => {
  assert.equal(
    localCodexRepositoryPath("D:\\VSC_Tyrael\\repo.git"),
    "D:\\VSC_Tyrael\\repo.git",
  );
  assert.equal(
    localCodexRepositoryPath("file:///D:/VSC_Tyrael/repo.git"),
    "D:\\VSC_Tyrael\\repo.git",
  );
  assert.equal(localCodexRepositoryPath("https://example.com/repo.git"), "");
});
