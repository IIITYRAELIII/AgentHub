import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { BugReportRepository } from "../../../src/infrastructure/filesystem/bug-report-repository.mjs";

const execFileAsync = promisify(execFile);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function git(cwd, ...args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout;
}

test("bug report commit and push contain only one generated report folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-bug-report-"));
  const origin = path.join(root, "origin.git");
  const repository = path.join(root, "Utilities");
  const screenshot = path.join(root, "screen.png");
  try {
    await git(root, "init", "--bare", "--initial-branch=main", origin);
    await git(root, "init", "--initial-branch=main", repository);
    await git(repository, "config", "user.name", "Agent Hub Test");
    await git(repository, "config", "user.email", "agent-hub@example.test");
    await mkdir(path.join(repository, "AgentHub"), { recursive: true });
    await writeFile(path.join(repository, "AgentHub", "package.json"), "{}\n", "utf8");
    await writeFile(path.join(repository, "notes.txt"), "initial\n", "utf8");
    await git(repository, "add", "AgentHub/package.json", "notes.txt");
    await git(repository, "commit", "-m", "Initial");
    await git(repository, "remote", "add", "origin", origin);
    await git(repository, "push", "-u", "origin", "main");

    await writeFile(path.join(repository, "notes.txt"), "user staged change\n", "utf8");
    await git(repository, "add", "notes.txt");
    await writeFile(screenshot, PNG);

    const reports = new BugReportRepository({
      repository,
      now: () => new Date("2026-08-05T09:10:11.000Z"),
    });
    const reportId = "018f6c86-3f34-7a31-8f27-16f5b96cce61";
    const result = await reports.submit({
      text: "Кнопка не отвечает",
      source: "browser",
      reportId,
      screenshots: [{ file: screenshot, type: "image/png" }],
    });

    assert.deepEqual(result, {
      id: reportId,
      folder: `AgentHub/Bugs/bug-${reportId}`,
      screenshots: 1,
      pushed: true,
    });
    const committed = (await git(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))
      .trim().split(/\r?\n/u);
    assert.deepEqual(committed, [
      `AgentHub/Bugs/bug-${reportId}/report.md`,
      `AgentHub/Bugs/bug-${reportId}/screenshot-01.png`,
    ]);
    assert.equal((await git(repository, "diff", "--cached", "--name-only")).trim(), "notes.txt");
    assert.match(
      await git(root, `--git-dir=${origin}`, "show", `main:AgentHub/Bugs/bug-${reportId}/report.md`),
      /Кнопка не отвечает/u,
    );
    await assert.rejects(() => readFile(screenshot), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bug report refuses to push when main already has unpushed commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-bug-report-ahead-"));
  const origin = path.join(root, "origin.git");
  const repository = path.join(root, "Utilities");
  try {
    await git(root, "init", "--bare", "--initial-branch=main", origin);
    await git(root, "init", "--initial-branch=main", repository);
    await git(repository, "config", "user.name", "Agent Hub Test");
    await git(repository, "config", "user.email", "agent-hub@example.test");
    await mkdir(path.join(repository, "AgentHub"), { recursive: true });
    await writeFile(path.join(repository, "AgentHub", "package.json"), "{}\n", "utf8");
    await git(repository, "add", "AgentHub/package.json");
    await git(repository, "commit", "-m", "Initial");
    await git(repository, "remote", "add", "origin", origin);
    await git(repository, "push", "-u", "origin", "main");
    await writeFile(path.join(repository, "local.txt"), "ahead\n", "utf8");
    await git(repository, "add", "local.txt");
    await git(repository, "commit", "-m", "Local ahead");

    const reports = new BugReportRepository({ repository });
    await assert.rejects(
      () => reports.submit({
        text: "Не отправлять соседний commit",
        reportId: "018f6c86-3f34-7a31-8f27-16f5b96cce62",
      }),
      /main должна быть синхронизирована/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
