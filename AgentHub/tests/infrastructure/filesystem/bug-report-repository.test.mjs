import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { AGENT_HUB_VERSION } from "../../../src/infrastructure/filesystem/agent-hub-package.mjs";
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

test("initial bug report scan returns every report already present at HEAD", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-existing-bug-report-"));
  const reportId = "018f6c86-3f34-7a31-8f27-16f5b96cce60";
  const reportFolder = `AgentHub/Bugs/bug-${reportId}`;
  try {
    await git(root, "init", "--initial-branch=main");
    await git(root, "config", "user.name", "Agent Hub Test");
    await git(root, "config", "user.email", "agent-hub@example.test");
    await mkdir(path.join(root, reportFolder), { recursive: true });
    await writeFile(path.join(root, reportFolder, "report.md"), [
      "# Bug report",
      "",
      "## Description",
      "",
      "Уже загружен через Git",
      "",
      "## Screenshots",
      "",
      "- screenshot-01.png",
      "",
    ].join("\n"), "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Existing bug report");

    const head = (await git(root, "rev-parse", "HEAD")).trim();
    assert.deepEqual(await new BugReportRepository({ repository: root }).addedSince(""), {
      head,
      baseline: true,
      reports: [{
        id: reportId,
        folder: reportFolder,
        text: "Уже загружен через Git",
        screenshots: 1,
      }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const baseline = (await git(repository, "rev-parse", "HEAD")).trim();

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
    const remoteHead = (await git(root, `--git-dir=${origin}`, "rev-parse", "main")).trim();
    const committed = (await git(root, `--git-dir=${origin}`, "diff-tree", "--no-commit-id", "--name-only", "-r", remoteHead))
      .trim().split(/\r?\n/u);
    assert.deepEqual(committed, [
      `AgentHub/Bugs/bug-${reportId}/report.md`,
      `AgentHub/Bugs/bug-${reportId}/screenshot-01.png`,
    ]);
    assert.equal((await git(repository, "diff", "--cached", "--name-only")).trim(), "notes.txt");
    assert.equal((await git(repository, "rev-parse", "HEAD")).trim(), baseline);
    const publishedReport = await git(
      root,
      `--git-dir=${origin}`,
      "show",
      `main:AgentHub/Bugs/bug-${reportId}/report.md`,
    );
    assert.match(publishedReport, /Кнопка не отвечает/u);
    assert.match(publishedReport, new RegExp(`Agent Hub: ${AGENT_HUB_VERSION.replaceAll(".", "\\.")}`, "u"));
    assert.deepEqual(await reports.addedSince(""), {
      head: (await git(repository, "rev-parse", "HEAD")).trim(),
      reports: [],
      baseline: true,
    });
    assert.deepEqual(await reports.addedSince(baseline), {
      head: baseline,
      reports: [],
      baseline: false,
    });
    await assert.rejects(() => readFile(screenshot), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bug report publishes without pushing existing local commits", async () => {
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

    const localHead = (await git(repository, "rev-parse", "HEAD")).trim();
    const reports = new BugReportRepository({ repository });
    const result = await reports.submit({
      text: "Не отправлять соседний commit",
      reportId: "018f6c86-3f34-7a31-8f27-16f5b96cce62",
    });

    assert.equal(result.pushed, true);
    assert.equal((await git(repository, "rev-parse", "HEAD")).trim(), localHead);
    await assert.rejects(
      () => git(root, `--git-dir=${origin}`, "show", "main:local.txt"),
      /Command failed/u,
    );
    assert.match(
      await git(root, `--git-dir=${origin}`, "show", `main:AgentHub/Bugs/bug-${result.id}/report.md`),
      /Не отправлять соседний commit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bug report publishes when local main is behind upstream", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-bug-report-behind-"));
  const origin = path.join(root, "origin.git");
  const repository = path.join(root, "Utilities");
  const publisher = path.join(root, "publisher");
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
    const localHead = (await git(repository, "rev-parse", "HEAD")).trim();

    await git(root, "clone", origin, publisher);
    await git(publisher, "config", "user.name", "Publisher");
    await git(publisher, "config", "user.email", "publisher@example.test");
    await writeFile(path.join(publisher, "remote.txt"), "new upstream content\n", "utf8");
    await git(publisher, "add", "remote.txt");
    await git(publisher, "commit", "-m", "Advance upstream");
    await git(publisher, "push", "origin", "main");

    const reports = new BugReportRepository({ repository });
    const result = await reports.submit({
      text: "Локальная main отстаёт",
      reportId: "018f6c86-3f34-7a31-8f27-16f5b96cce63",
    });

    assert.equal(result.pushed, true);
    assert.equal((await git(repository, "rev-parse", "HEAD")).trim(), localHead);
    assert.equal(
      await git(root, `--git-dir=${origin}`, "show", "main:remote.txt"),
      "new upstream content\n",
    );
    assert.match(
      await git(root, `--git-dir=${origin}`, "show", `main:AgentHub/Bugs/bug-${result.id}/report.md`),
      /Локальная main отстаёт/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
