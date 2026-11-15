import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { withPreparationGitIsolation } from "../../../src/infrastructure/filesystem/preparation-git-isolation.mjs";

const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });

test("detached owned inputs avoid history copies and reject changed conflict sides before transport", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-detached-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), dataDir = path.join(root, "data");
  await mkdir(source); await gitAt(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, ".gitattributes"), "* text eol=lf\n*.bin -text\n");
  const history = randomBytes(64 * 1024);
  await writeFile(path.join(source, "existing.bin"), history);
  await writeFile(path.join(source, "shared.txt"), "base\n");
  const commit = async (cwd, message) => {
    await gitAt(cwd, ["add", "-A"]);
    await gitAt(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", message]);
    return gitAt(cwd, ["rev-parse", "HEAD"]);
  };
  const base = await commit(source, "small shared input history");
  const result = async (taskId, file, body) => {
    await gitAt(source, ["checkout", "--detach", base]);
    await writeFile(path.join(source, file), body);
    return { taskId, taskRevision: 1, baseCommit: base, resultCommit: await commit(source, taskId) };
  };
  const a = await result("a", "shared.txt", "A\n"), b = await result("b", "shared.txt", "B\n");
  const context = { repositoryRoot: source, primaryGitCommonDir: path.join(source, ".git"),
    baseProvenance: { schemaVersion: 1, kind: "agreed-main-native-git-v1", agreedMainCommit: base, publishedBaseCommit: base } };
  const captures = path.join(root, "captures"); await mkdir(captures);
  const owner = new TaskGitWorkspaceService({ dataDir });
  const transports = [];
  const request = (tasks, revision) => {
    const identity = { policy: "main-selected-git-merge-v1", workspaceId: "fixture", planRevision: revision, baseCommit: base, tasks };
    const capture = path.join(captures, createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24));
    return { root: capture, sourceRoot: source, baseCommit: base, tasks, identity, reuseContext: context,
      gitAt: async (cwd, args, options = {}) => {
        if (args[0] === "pack-objects" && cwd !== source) {
          const receiver = path.join(capture, "repository");
          const head = await gitAt(receiver, ["rev-parse", "HEAD"]);
          let donorHasHead = true;
          try { await gitAt(cwd, ["cat-file", "-e", head + "^{commit}"]); } catch { donorHasHead = false; }
          transports.push({ revision, inputs: String(options.input ?? "").trim().split(/\r?\n/u),
            receiverRefs: await gitAt(receiver, ["for-each-ref", "--format=%(objectname)"]),
            receiverHead: head, donorHasHead });
        }
        return gitAt(cwd, args, options);
      },
      readJson: file => readFile(file, "utf8").then(JSON.parse, e => { if (e.code === "ENOENT") return null; throw e; }),
      writeJson: (file, value) => writeFile(file, JSON.stringify(value)) };
  };
  const run = input => owner.withNativeRepositoryOwner({ sourceRoot: source, repositoryRoot: input.root },
    ({ lease, objects }) => withPreparationGitIsolation(dataDir, () => mergeSelectedResults({ ...input,
      provisionNativeObjects: values => objects.provision(values),
      verifyNativeObjects: values => objects.assertConsumer(values),
    }), lease, objects));
  const original = request([a, b], "old");
  await assert.rejects(run(original), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  const donor = path.join(original.root, "repository");
  await writeFile(path.join(donor, "shared.txt"), "A\nB\n");
  const oldResolution = await commit(donor, "preserve both real conflict arms");
  await run(original);
  const originalJournal = await readFile(path.join(original.root, "merge.json"));
  const c = await result("c", "automatic.txt", "current automatic contribution\n");
  const current = request([c, a, b], "detached-new-head");
  const merged = await run(current);
  const positive = transports.filter(x => x.revision === "detached-new-head");
  assert.equal(positive.length, 1);
  assert.equal(positive[0].receiverRefs, "");
  assert.equal(positive[0].donorHasHead, false, "the donor cannot supply the receiver's freshly recomposed HEAD");
  const bundles = (await readdir(current.root)).filter(x => /^retained-.*\.bundle$/u.test(x));
  assert.equal(bundles.length, 1);
  const bundle = path.join(current.root, bundles[0]), bytes = (await stat(bundle)).size;
  const header = (await readFile(bundle)).subarray(0, 4096).toString("utf8").split("\n\n", 1)[0];
  const baseDeclared = header.split(/\r?\n/u).some(line => line.startsWith("-" + base + " "));
  assert.equal(await gitAt(merged.root, ["show", "HEAD:shared.txt"]), "A\nB");
  assert.equal(await gitAt(merged.root, ["show", "HEAD:automatic.txt"]), "current automatic contribution");
  assert.equal(await gitAt(merged.root, ["rev-parse", "HEAD:existing.bin"]),
    await gitAt(source, ["rev-parse", base + ":existing.bin"]));
  await gitAt(merged.root, ["fsck", "--connectivity-only", "--no-dangling", merged.head]);
  await assert.rejects(readFile(path.join(merged.root, ".git/objects/info/alternates")), { code: "ENOENT" });
  assert.deepEqual((await gitAt(merged.root, ["show", "-s", "--format=%P", merged.head])).split(" "),
    [merged.merges[1].commit, b.resultCommit]);
  assert.deepEqual(await readFile(path.join(original.root, "merge.json")), originalJournal);
  const reopened = await run(current);
  assert.equal(reopened.head, merged.head); assert.equal((await stat(bundle)).size, bytes);

  const changed = await result("b", "shared.txt", "B changed\n");
  const next = request([c, a, changed], "changed-side");
  await assert.rejects(run(next), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  const rejectedHintTransports = transports.filter(x => x.revision === "changed-side"
    && (x.inputs[0] === oldResolution || x.inputs[0] === merged.head));
  const marker = await readFile(path.join(next.root, "repository/shared.txt"), "utf8");
  assert.match(marker, /B changed/u);
  assert.equal(await gitAt(path.join(next.root, "repository"), ["rev-parse", "MERGE_HEAD"]), changed.resultCommit);
  assert.deepEqual(await readFile(path.join(original.root, "merge.json")), originalJournal);
  t.diagnostic(JSON.stringify({ fixtureHistoryB: history.length, retainedBundleB: bytes, baseDeclared,
    rejectedHintTransports: rejectedHintTransports.length, detachedHeadMissingInDonor: true,
    sharedInputsRetained: true, currentAutomaticRetained: true, oldJournalUnchanged: true }));
  assert.deepEqual({ baseDeclared, smallerThanSharedHistory: bytes < history.length / 4,
    rejectedHintTransports: rejectedHintTransports.length },
  { baseDeclared: true, smallerThanSharedHistory: true, rejectedHintTransports: 0 });
});
