import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { assertNativeMergedResults, mergeSelectedResults, NATIVE_RELEASE_POLICY }
  from "../../../src/infrastructure/filesystem/native-release-merge.mjs";

const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });
const readJson = async file => JSON.parse(await readFile(file, "utf8").catch(error => {
  if (error.code === "ENOENT") return "null";
  throw error;
}));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value), "utf8");
const gap = label => Array.from({ length: 12 }, (_, i) => `${label} stable ${i}\n`).join("");
const body = ({ api = "function provide(legacy) {}", call = "base clean", shared = "base shared",
  tail = "base tail", selected = "", removed = "legacyRemoved();\n", publication = false, selection = false, extra = "" } = {}) =>
  `${api}\nfunction dispatch(first, publication, selection) {\n  if (first) return {\n    old: true,\n${extra}  };\n`
    + `${publication ? "  if (publication) return publicOwner();\n" : ""}`
    + `${selection ? "  if (selection) return selectionOwner();\n" : ""}  return normalOwner();\n}\n`
    + `${gap("api")}${call}\n${gap("selected")}${selected}${gap("call")}${shared}\n${gap("shared")}${removed}${gap("tail")}${tail}\n`;
async function commit(root, label, amend = false) {
  await gitAt(root, ["add", "."]);
  await gitAt(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
    "commit", ...(amend ? ["--amend", "--no-edit"] : ["-m", label])]);
  return gitAt(root, ["rev-parse", "HEAD"]);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-ordered-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"); await mkdir(sourceRoot);
  await gitAt(sourceRoot, ["init", "--initial-branch=main"]);
  await writeFile(path.join(sourceRoot, ".gitattributes"), "*.txt text eol=lf\n");
  await writeFile(path.join(sourceRoot, "selection.txt"), body());
  const base = await commit(sourceRoot, "publication");
  const create = async (label, value, from = base) => {
    await gitAt(sourceRoot, ["checkout", "--detach", from]);
    await writeFile(path.join(sourceRoot, "selection.txt"), value);
    return commit(sourceRoot, label);
  };
  const aBody = body({ call: "uniqueCall(legacy)", shared: "selected A", selected: "uniqueSelected();\n", removed: "", publication: true });
  const a = await create("A selected addition and deletion", aBody);
  const b = await create("B selected API", body({ api: "function provide() {}", shared: "selected B", selection: true }));
  const tasks = [{ taskId: "A", baseCommit: base, resultCommit: a }, { taskId: "B", baseCommit: base, resultCommit: b }];
  const compose = () => mergeSelectedResults({ root: path.join(root, "capture"), sourceRoot, baseCommit: base, tasks,
    identity: { policy: NATIVE_RELEASE_POLICY, baseCommit: base, tasks }, gitAt, readJson, writeJson });
  let repository;
  await assert.rejects(compose(), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT"); repository = error.conflictRoot; return true;
  });
  const resolved = body({ api: "function provide() {}", call: "uniqueCall()", shared: "selected A+B",
    selected: "uniqueSelected();\n", removed: "", publication: true, selection: true });
  await writeFile(path.join(repository, "selection.txt"), resolved);
  await commit(repository, "ordinary owned API compatibility resolution");
  const value = await compose();
  assert.ok(value.merges[1].resolution.conflictPaths.includes("selection.txt"));
  const savedJournal = await readFile(path.join(root, "capture", "merge.json"));
  async function later(value, from = base) {
    const c = await create("C later selected automatic edit", value, from);
    await gitAt(repository, ["fetch", "--no-tags", sourceRoot, c]);
    await gitAt(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "merge", "--no-edit", c]);
    const head = await gitAt(repository, ["rev-parse", "HEAD"]);
    const selected = [...tasks, { taskId: "C", baseCommit: base, resultCommit: c }];
    return { git: (args, options) => gitAt(repository, args, options), baseCommit: base, tasks: selected,
      merges: [...valueBefore.merges, { taskId: "C", resultCommit: c, commit: head }], head,
      tree: await gitAt(repository, ["rev-parse", "HEAD^{tree}"]),
      identity: { policy: NATIVE_RELEASE_POLICY, baseCommit: base, tasks: selected } };
  }
  const valueBefore = value;
  return { root, sourceRoot, repository, base, a, aBody, resolved, savedJournal, later };
}

test("owned resolution is re-proved through a later clean same-file amendment", async t => {
  const f = await fixture(t);
  const input = await f.later(body({ tail: "new selected tail", extra: "    added: true,\n" }));
  assert.equal(await readFile(path.join(f.repository, "selection.txt"), "utf8"),
    f.resolved.replace("base tail\n", "new selected tail\n").replace("    old: true,\n", "    old: true,\n    added: true,\n"));
  await assertNativeMergedResults(input);
  await assertNativeMergedResults(input);
  assert.deepEqual(await readFile(path.join(f.root, "capture", "merge.json")), f.savedJournal);
  const fresh = structuredClone(input.merges);
  fresh[1].resolution.binding.diffSha256 = "0".repeat(64);
  await assert.rejects(assertNativeMergedResults({ ...input, merges: fresh }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  const foreign = structuredClone(input.merges); foreign[2].commit = f.a;
  await assert.rejects(assertNativeMergedResults({ ...input, merges: foreign }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  const otherTasks = input.tasks.map((item, i) => i === 2 ? { ...item, resultCommit: f.a } : item);
  await assert.rejects(assertNativeMergedResults({ ...input, tasks: otherTasks }), /Prepared native result evidence changed/u);
  await assert.rejects(assertNativeMergedResults({ ...input, baseCommit: f.a }), /Contained native result changed the prefix/u);
});

for (const loss of ["earlier addition", "earlier deletion"]) test(`later automatic merge cannot lose ${loss}`, async t => {
  const f = await fixture(t);
  const changed = loss === "earlier addition"
    ? f.aBody.replace("uniqueSelected();\n", "") : f.aBody.replace(gap("tail"), `legacyRemoved();\n${gap("tail")}`);
  const input = await f.later(changed, f.a);
  const actual = await readFile(path.join(f.repository, "selection.txt"), "utf8");
  assert.equal(actual.includes("uniqueSelected();"), loss !== "earlier addition");
  assert.equal(actual.includes("legacyRemoved();"), loss === "earlier deletion");
  await assert.rejects(assertNativeMergedResults(input), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
    && error.missingPaths.includes("selection.txt"));
  assert.deepEqual(await readFile(path.join(f.root, "capture", "merge.json")), f.savedJournal);
});

for (const loss of ["new selected text", "new mode", "new binary payload", "new symlink type"]) test(`final proof rejects lost ${loss}`, async t => {
  const f = await fixture(t);
  const input = await f.later(body({ tail: "new selected tail" }));
  const selectedFile = path.join(f.repository, "selection.txt");
  if (loss === "new selected text") {
    await writeFile(selectedFile, f.resolved);
  } else if (loss === "new mode") {
    await gitAt(f.repository, ["update-index", "--chmod=+x", "selection.txt"]);
  } else if (loss === "new binary payload") {
    await writeFile(selectedFile, Buffer.from([0, 1, 2, 3, 255]));
  } else {
    const oid = await gitAt(f.repository, ["hash-object", "-w", "--stdin"], { input: Buffer.from("elsewhere\n") });
    await gitAt(f.repository, ["update-index", "--cacheinfo", `120000,${oid},selection.txt`]);
  }
  // Use Git's tree/commit writer for index-only mode/type cases so the fixture
  // does not need OS symlink privilege or reinterpret its ordinary text file.
  if (loss === "new mode" || loss === "new symlink type") {
    input.tree = await gitAt(f.repository, ["write-tree"]);
    input.head = await gitAt(f.repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
      "commit-tree", input.tree, "-p", input.merges[1].commit, "-p", input.tasks[2].resultCommit, "-m", "incorrect final entry"]);
  } else {
    input.head = await commit(f.repository, "incorrect final content", true);
    input.tree = await gitAt(f.repository, ["rev-parse", "HEAD^{tree}"]);
  }
  input.merges[2].commit = input.head;
  await assert.rejects(assertNativeMergedResults(input), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING");
});
