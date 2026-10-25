import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertNativeTaskHistories } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";

const exec = promisify(execFile);

test("complete native selected history is checked beyond 512 commits", async () => {
  const base = "a".repeat(40), result = "b".repeat(40);
  const rows = Array.from({ length: 600 }, (_, i) => `${i === 0 ? result : i.toString(16).padStart(40, "0")} ${base}`).join("\n");
  const port = async args => args[0] === "rev-list" ? rows : "";
  await assertNativeTaskHistories({ git: port, baseCommit: base, tasks: [{ taskId: "selected", baseCommit: base, resultCommit: result }] });
});
async function git(cwd, args, options = {}) {
  const { stdout } = await exec("git", args, { cwd, encoding: "buffer", windowsHide: true });
  return options.rawOutput ? stdout : stdout.toString("utf8").trim();
}
async function save(root, name, text) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), text);
}
async function commit(root) {
  await git(root, ["add", "-A"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "metadata fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

test("literal NUL metadata paths refuse invented quoted notes/version and preserve inherited entries", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-metadata-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "core.quotePath", "true"]);
  await save(root, ".gitattributes", "* text eol=lf\n");
  await save(root, "CHANGELOG.md", "agreed notes\n");
  await save(root, "pkg-Ж/package.json", JSON.stringify({ version: "1.0.0" }));
  const base = await commit(root);
  const port = (args, options) => git(root, args, options);
  const branch = async (id, start = base) => {
    const cwd = path.join(root, "..", path.basename(root) + "-" + id);
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await git(root, ["worktree", "add", "-b", id, cwd, start]);
    return cwd;
  };
  for (const [i, name] of ["ascii/CHANGELOG.md", "nonascii-Ж/CHANGELOG.md", " leading-[Ж]/CHANGELOG.md",
    "pkg-Ж/package.json"].entries()) {
    const cwd = await branch("invalid-" + i);
    await save(cwd, name, name.endsWith(".json") ? JSON.stringify({ version: "9.9.9" }) : "invented Task notes\n");
    const resultCommit = await commit(cwd);
    await assert.rejects(assertNativeTaskHistories({ git: port, baseCommit: base,
      tasks: [{ taskId: "task-" + i, baseCommit: base, resultCommit }] }), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  }
  const approvedRoot = await branch("approved");
  await save(approvedRoot, "nonascii-Ж/CHANGELOG.md", "approved inherited notes\n");
  await save(approvedRoot, " leading-[Ж]/CHANGELOG.md", "approved literal whitespace and brackets\n");
  await save(approvedRoot, "pkg-Ж/package.json", JSON.stringify({ version: "2.0.0" }));
  const approved = await commit(approvedRoot), own = await branch("own", approved);
  await save(own, "own.txt", "selected content\n");
  const resultCommit = await commit(own), tasks = [{ taskId: "own", baseCommit: base, resultCommit }];
  const request = { git: port, baseCommit: approved, tasks,
    historyAuthority: { bases: [approved], metadataBases: [approved], adoptions: [] } };
  await assertNativeTaskHistories(request);
  for (const malformed of [bytes => Buffer.concat([bytes, bytes]), bytes => bytes.subarray(0, bytes.length - 1)]) {
    await assert.rejects(assertNativeTaskHistories({ ...request, git: async (args, options) => {
      const output = await port(args, options);
      return args.includes("ls-tree") && args.includes(resultCommit) && String(args.at(-1)).includes("nonascii-")
        ? malformed(Buffer.from(output)) : output;
    } }), /malformed or ambiguous/);
  }
});
