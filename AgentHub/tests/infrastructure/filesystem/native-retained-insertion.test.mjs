import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { assertNativeMergedResults, NATIVE_RELEASE_POLICY }
  from "../../../src/infrastructure/filesystem/native-release-merge.mjs";

const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });
// Literal Git fixture data, not loaded application source. This small fragment
// keeps the ambiguous method-header alignment from the real counterexample.
const block = `  awaitTransitionAdmissionNoEffect(workspaceId, error) {
    const identity = sha256(String(workspaceId ?? "").trim()).slice(0, 24);
    const lockPath = path.join(this.dataDir, "locks", \`release-await-\${identity}.lock\`);
    return interprocessLockAdmissionTimeoutPath(error) === lockPath
      ? { kind: "release-await-lock-admission-v1", workspaceId, lockPath } : null;
  }

`;
const tail = `              identity = { ...identity, preparedCandidate: preparedSource.binding };
              await writeJsonAtomic(identityFile, identity);
          } else if (!existingPrepared) throw new Error("Frozen generation has no original prepared binding");
        const isolated = new ReleaseGitWorkspaceService({
          dataDir: generationDataDir,
          contourExternalEffects: this.#contourExternalEffects,
          environment: this.#environment,
          readPreparationOriginal: this.#readPreparationOriginal,
        isolated.#publicationDataDir = this.#publicationDataDir;
        isolated.#repositoryOwner = this.#repositoryOwner;
`;

async function fixture(t, { published = block + tail, selected = block + block + tail,
  candidate = block + tail, earlier, selectedMode, candidateMode } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-retained-insertion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args, options) => gitAt(root, args, options);
  await git(["init", "--initial-branch=main"]);
  await writeFile(path.join(root, ".gitattributes"), "*.txt text eol=lf\n");
  async function commit(body, label, mode) {
    await writeFile(path.join(root, "selection.txt"), body);
    await git(["add", "."]);
    if (mode) {
      const oid = await git(["hash-object", "-w", "--stdin"], { input: Buffer.from(body) });
      await git(["update-index", "--cacheinfo", `${mode},${oid},selection.txt`]);
    }
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", label]);
    return git(["rev-parse", "HEAD"]);
  }
  const publication = await commit(published, "publication");
  const tasks = [];
  if (earlier) tasks.push({ taskId: "earlier", baseCommit: publication,
    resultCommit: await commit(earlier, "earlier unique selected content") });
  const result = await commit(selected, "selected addition", selectedMode);
  tasks.push({ taskId: "selected", baseCommit: publication, resultCommit: result });
  const head = await commit(candidate, "retained candidate", candidateMode);
  const tree = await git(["rev-parse", "HEAD^{tree}"]);
  const input = { git, baseCommit: head, tasks, head, tree,
    merges: tasks.map(task => ({ taskId: task.taskId, resultCommit: task.resultCommit,
      commit: head, contained: true })),
    identity: { policy: NATIVE_RELEASE_POLICY, baseCommit: head, tasks } };
  return { root, git, input, publication, result, candidate };
}

test("exact retained insertion survives an ambiguously aligned method-header hunk", async t => {
  const f = await fixture(t);
  const raw = await f.git(["merge-tree", "--write-tree", "--name-only", "-z",
    `--merge-base=${f.publication}`, f.input.head, f.result], { rawOutput: true });
  const replay = String(raw).split("\0")[0];
  assert.deepEqual(await f.git(["show", `${replay}:selection.txt`], { rawOutput: true }), Buffer.from(block + block + tail));
  const patch = String(await f.git(["diff", "--no-ext-diff", "--no-textconv", "--unified=0",
    f.input.head, replay, "--", "selection.txt"], { rawOutput: true }));
  const addition = patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"))
    .map(line => line.slice(1)).join("\n") + "\n";
  assert.ok(!f.candidate.includes(addition), "fixture must exercise the ambiguous hunk, not the old literal fast path");
  const before = await f.git(["rev-parse", "HEAD"]);
  await assertNativeMergedResults(f.input);
  assert.equal(await f.git(["rev-parse", "HEAD"]), before);
  assert.equal(await readFile(path.join(f.root, "selection.txt"), "utf8"), f.candidate);
});

for (const lost of ["earlier", "new"]) test(`a repeated block cannot hide ${lost} unique selected loss`, async t => {
  const early = block + tail + "unique earlier selected content\n";
  const selected = block + block + tail + "unique earlier selected content\nunique new selected content\n";
  const candidate = block + tail + (lost === "earlier" ? "unique new selected content\n" : "unique earlier selected content\n");
  const f = await fixture(t, { earlier: early, selected, candidate });
  await assert.rejects(assertNativeMergedResults(f.input), error => error.code === "RELEASE_SELECTED_CONTENT_MISSING"
    && error.missingPaths.includes("selection.txt"));
});

for (const kind of ["near match", "permuted block"]) test(`literal insertion refuses a ${kind}`, async t => {
  const similar = kind === "near match" ? block.replace("return interprocessLock", "return differentLock")
    : block.replace('    const identity = sha256(String(workspaceId ?? "").trim()).slice(0, 24);\n'
      + '    const lockPath = path.join(this.dataDir, "locks", `release-await-${identity}.lock`);\n',
    '    const lockPath = path.join(this.dataDir, "locks", `release-await-${identity}.lock`);\n'
      + '    const identity = sha256(String(workspaceId ?? "").trim()).slice(0, 24);\n');
  assert.notEqual(similar, block);
  const f = await fixture(t, { published: similar + tail, selected: similar + block + tail, candidate: similar + tail });
  await assert.rejects(assertNativeMergedResults(f.input), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

for (const kind of ["mode", "binary"]) test(`a repeated block cannot hide selected ${kind} loss`, async t => {
  const options = kind === "mode" ? { selectedMode: "100755", candidateMode: "100644" }
    : { published: "\0" + block + tail, selected: "\0" + block + block + tail, candidate: "\0" + block + tail };
  const f = await fixture(t, options);
  await assert.rejects(assertNativeMergedResults(f.input), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

for (const kind of ["removal", "replacement"]) test(`literal duplication does not waive a selected ${kind}`, async t => {
  const published = block + tail + "legacy selected line\n";
  const selected = block + block + tail + (kind === "replacement" ? "new selected line\n" : "");
  const f = await fixture(t, { published, selected, candidate: published });
  await assert.rejects(assertNativeMergedResults(f.input), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});
