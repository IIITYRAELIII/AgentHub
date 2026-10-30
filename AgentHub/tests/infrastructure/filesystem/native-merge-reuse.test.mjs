import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { withTaskOperationTiming } from "../../../src/infrastructure/process/task-operation-timing.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";

const execute = promisify(execFile);
async function git(cwd, ...args) {
  return (await execute("git", args, { cwd, windowsHide: true })).stdout.trim();
}
async function fixture(t, { hub = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nreuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); await mkdir(source);
  await git(source, "init", "--initial-branch=main");
  await writeFile(path.join(source, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(source, "shared.txt"), "before\n");
  if (hub) {
    await mkdir(path.join(source, "AgentHub/src"), { recursive: true });
    await writeFile(path.join(source, "AgentHub/package.json"), JSON.stringify({ name: "agent-hub", version: "2.0.3" }));
    await writeFile(path.join(source, "AgentHub/src/entry.mjs"), 'import "./present.mjs";\n');
    await writeFile(path.join(source, "AgentHub/src/present.mjs"), "export const present = true;\n");
  }
  const commit = async (cwd, message) => {
    await git(cwd, "add", "-A");
    await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const base = await commit(source, "base"), folders = new Map();
  const result = async (id, file, bytes) => {
    let folder = folders.get(id);
    if (!folder) {
      folder = path.join(root, id); await git(source, "worktree", "add", "-b", id, folder, base); folders.set(id, folder);
    }
    await writeFile(path.join(folder, file), bytes);
    return { taskId: id, taskRevision: 1, baseCommit: base, resultCommit: await commit(folder, id) };
  };
  const captures = path.join(root, "captures"); await mkdir(captures);
  const counts = { merge: 0 }, timings = [];
  const context = { repositoryRoot: source, primaryGitCommonDir: path.join(source, ".git"),
    baseProvenance: { schemaVersion: 1, kind: "agreed-main-native-git-v1", agreedMainCommit: base, publishedBaseCommit: base } };
  const request = (tasks, revision) => {
    const identity = { policy: "main-selected-git-merge-v1", workspaceId: "fixture", planRevision: revision, baseCommit: base, tasks };
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
    return { root: path.join(captures, key), sourceRoot: source, baseCommit: base, tasks, identity, reuseContext: context,
      gitAt: (cwd, args, options = {}) => {
        if (args.includes("merge") && args.includes("--no-ff")) counts.merge++;
        return runTaskGitCommand(args, { ...options, cwd });
      },
      readJson: filename => readFile(filename, "utf8").then(JSON.parse, error => { if (error.code === "ENOENT") return null; throw error; }),
      writeJson: (filename, value) => writeFile(filename, JSON.stringify(value)),
    };
  };
  const observations = [];
  const run = async input => {
    const before = counts.merge, start = performance.now(), events = [];
    try {
      return await withTaskOperationTiming({ operationId: `native-reuse-${path.basename(root)}-${input.identity.planRevision}`, taskId: "fixture",
        record: event => { timings.push(event); events.push(event); } }, () => mergeSelectedResults(input));
    } finally {
      observations.push({ revision: input.identity.planRevision, durationMs: performance.now() - start,
        mergeCalls: counts.merge - before,
        stages: events.filter(x => x.phase === "end" && x.stage?.startsWith("native:")).map(x => ({ stage: x.stage, durationMs: x.durationMs })) });
    }
  };
  t.after(() => t.diagnostic(JSON.stringify({ observations })));
  return { root, source, base, context, counts, timings, observations, result, request, run, commit, folders };
}

test("changed tail reuses only verified whole ordered prefix and keeps all current content", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "A.txt", "a\n"), b = await f.result("B", "B.txt", "b\n"), c = await f.result("C", "C.txt", "c\n");
  const first = await f.run(f.request([a, b, c], "one"));
  const oldJournal = await readFile(path.join(path.dirname(first.root), "merge.json"));
  const corrected = await f.result("C", "C-extra.txt", "correction\n");
  const before = f.counts.merge;
  const next = await f.run(f.request([a, b, corrected], "two"));
  assert.equal(f.counts.merge - before, 1, "unchanged A/B must not merge again");
  assert.deepEqual(next.merges.slice(0, 2).map(x => x.commit), first.merges.slice(0, 2).map(x => x.commit));
  assert.equal(await git(next.root, "show", "HEAD:C-extra.txt"), "correction");
  for (const file of ["A.txt", "B.txt", "C.txt"]) assert.ok(await git(next.root, "show", `HEAD:${file}`));
  assert.deepEqual(await readFile(path.join(path.dirname(first.root), "merge.json")), oldJournal);
  assert.equal(await git(f.source, "rev-parse", "HEAD"), f.base);
});

test("identical whole conflict context reuses marker resolution while retaining new automatic changes", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "shared.txt", "A\n"), b = await f.result("B", "shared.txt", "B\n");
  const original = f.request([a, b], "one");
  await assert.rejects(f.run(original), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  const checkout = path.join(original.root, "repository");
  await writeFile(path.join(checkout, "shared.txt"), "A\nB\n");
  await f.commit(checkout, "resolve both original contributions");
  await f.run(original);
  const old = await readFile(path.join(original.root, "merge.json"));
  const nextB = await f.result("B", "new.txt", "new automatic contribution\n");
  const next = await f.run(f.request([a, nextB], "two"));
  assert.equal(await git(next.root, "show", "HEAD:shared.txt"), "A\nB");
  assert.equal(await git(next.root, "show", "HEAD:new.txt"), "new automatic contribution");
  assert.equal(next.merges[1].resultCommit, nextB.resultCommit);
  assert.deepEqual((await git(next.root, "show", "-s", "--format=%P", next.head)).split(" "), [next.merges[0].commit, nextB.resultCommit]);
  assert.deepEqual(await readFile(path.join(original.root, "merge.json")), old);
  assert.equal(await git(f.source, "status", "--porcelain=v1"), "");
});

test("middle correction, removal, reordering and full Task entry drift never retain an old suffix", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "A.txt", "a\n"), b = await f.result("B", "B.txt", "b\n"), c = await f.result("C", "C.txt", "c\n");
  await f.run(f.request([a, b, c], "one"));
  const nextB = await f.result("B", "B-new.txt", "new\n");
  let before = f.counts.merge;
  const middle = await f.run(f.request([a, nextB, c], "middle"));
  assert.equal(f.counts.merge - before, 2);
  assert.equal(await git(middle.root, "show", "HEAD:B-new.txt"), "new");
  before = f.counts.merge;
  const removed = await f.run(f.request([a, c], "removed"));
  assert.equal(f.counts.merge - before, 1);
  await assert.rejects(git(removed.root, "show", "HEAD:B.txt"));
  await assert.rejects(git(removed.root, "merge-base", "--is-ancestor", nextB.resultCommit, removed.head));
  before = f.counts.merge;
  await f.run(f.request([{ ...a, taskRevision: 2 }, c], "entry-change"));
  assert.equal(f.counts.merge - before, 2, "same commits do not hide a changed complete entry");
  before = f.counts.merge;
  const reordered = await f.run(f.request([c, a], "order-change"));
  assert.equal(f.counts.merge - before, 2);
  assert.deepEqual(reordered.merges.map(x => x.taskId), ["C", "A"]);
});

test("base and whole provenance drift create ordinary new computation rather than cross-boundary reuse", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "A.txt", "a\n"), b = await f.result("B", "B.txt", "b\n");
  await f.run(f.request([a, b], "one"));
  let before = f.counts.merge;
  await f.run({ ...f.request([a, b], "provenance"), reuseContext: { ...f.context, baseProvenance: { ...f.context.baseProvenance, observedAuthority: "different" } } });
  assert.equal(f.counts.merge - before, 2);
  await writeFile(path.join(f.source, "base-new.txt"), "new main\n");
  const baseCommit = await f.commit(f.source, "new agreed main");
  const input = f.request([a, b], "base"); input.baseCommit = baseCommit; input.identity = { ...input.identity, baseCommit };
  before = f.counts.merge;
  const next = await f.run(input);
  assert.equal(f.counts.merge - before, 2);
  assert.equal(await git(next.root, "show", "HEAD:base-new.txt"), "new main");
});

test("prefix checkout lost reply reopens its exact new intent without replaying old merges", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "A.txt", "a\n"), b = await f.result("B", "B.txt", "b\n");
  const old = await f.run(f.request([a, b], "one"));
  const corrected = await f.result("B", "B-extra.txt", "extra\n");
  const input = f.request([a, corrected], "two"), originalGit = input.gitAt;
  let lose = true;
  input.gitAt = async (cwd, args, options) => {
    if (cwd === old.root && args[0] === "pack-objects") {
      const state = JSON.parse(await readFile(path.join(input.root, "merge.json")));
      assert.ok(state.reuseTransportIntent, "transport intent must precede old-object import");
    }
    const value = await originalGit(cwd, args, options);
    if (lose && args[0] === "checkout" && args.at(-1) === old.merges[0].commit) { lose = false; throw new Error("lost prefix checkout reply"); }
    return value;
  };
  const before = f.counts.merge;
  await assert.rejects(f.run(input), /lost prefix checkout reply/u);
  const pending = JSON.parse(await readFile(path.join(input.root, "merge.json")));
  assert.equal(pending.next, 0); assert.equal(pending.reuseIntent.head, old.merges[0].commit);
  const result = await f.run({ ...input, gitAt: originalGit });
  assert.equal(f.counts.merge - before, 1);
  assert.equal(await git(result.root, "show", "HEAD:B-extra.txt"), "extra");
});

test("retained conflict abort lost reply resumes the new identity and preserves a later foreign edit", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "shared.txt", "A\n"), b = await f.result("B", "shared.txt", "B\n");
  const oldInput = f.request([a, b], "one");
  await assert.rejects(f.run(oldInput), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  await writeFile(path.join(oldInput.root, "repository/shared.txt"), "A\nB\n");
  await f.commit(path.join(oldInput.root, "repository"), "original resolution"); await f.run(oldInput);
  const corrected = await f.result("B", "extra.txt", "new\n");
  const input = f.request([a, corrected], "two"), originalGit = input.gitAt;
  let lose = true;
  input.gitAt = async (cwd, args, options) => {
    const value = await originalGit(cwd, args, options);
    if (lose && args[0] === "merge" && args[1] === "--abort") { lose = false; throw new Error("lost reused conflict abort"); }
    return value;
  };
  await assert.rejects(f.run(input), /lost reused conflict abort/u);
  const native = path.join(input.root, "repository"), journal = await readFile(path.join(input.root, "merge.json"));
  assert.ok(JSON.parse(journal).conflict.retainedResolution);
  await writeFile(path.join(native, "foreign.txt"), "do not overwrite\n");
  await assert.rejects(f.run({ ...input, gitAt: originalGit }), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  assert.equal(await readFile(path.join(native, "foreign.txt"), "utf8"), "do not overwrite\n");
  await rm(path.join(native, "foreign.txt"));
  const result = await f.run({ ...input, gitAt: originalGit });
  assert.equal(await git(result.root, "show", "HEAD:shared.txt"), "A\nB");
  assert.equal(await git(result.root, "show", "HEAD:extra.txt"), "new");
});

test("changed conflict stages stay a genuine new conflict and do not use the earlier resolution", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "shared.txt", "A\n"), b = await f.result("B", "shared.txt", "B\n");
  const old = f.request([a, b], "one");
  await assert.rejects(f.run(old), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  await writeFile(path.join(old.root, "repository/shared.txt"), "A\nB\n"); await f.commit(path.join(old.root, "repository"), "resolve"); await f.run(old);
  const oldBytes = await readFile(path.join(old.root, "merge.json"));
  const nextB = await f.result("B", "shared.txt", "B changed\n");
  const input = f.request([a, nextB], "changed");
  await assert.rejects(f.run(input), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  assert.equal(await git(path.join(input.root, "repository"), "rev-parse", "MERGE_HEAD"), nextB.resultCommit);
  assert.match(await readFile(path.join(input.root, "repository/shared.txt"), "utf8"), /B changed/u);
  assert.deepEqual(await readFile(path.join(old.root, "merge.json")), oldBytes);
});

test("a forged completed cached tree never supplies extra automatic bytes", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "A.txt", "a\n"), b = await f.result("B", "B.txt", "b\n");
  const original = f.request([a, b], "one");
  const first = await f.run(original);
  await writeFile(path.join(first.root, "foreign.txt"), "not selected\n"); await git(first.root, "add", "foreign.txt");
  const tree = await git(first.root, "write-tree");
  const forged = await git(first.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
    "commit-tree", tree, "-p", f.base, "-p", a.resultCommit, "-m", "forged prefix");
  const file = path.join(original.root, "merge.json"), state = JSON.parse(await readFile(file));
  state.merges = [{ taskId: a.taskId, resultCommit: a.resultCommit, commit: forged }];
  state.identity.tasks = [a]; state.next = 1; state.head = forged;
  await writeFile(file, JSON.stringify(state)); const bytes = await readFile(file);
  const before = f.counts.merge;
  const result = await f.run(f.request([a, b], "two"));
  assert.equal(f.counts.merge - before, 2, "unverified hint must not skip ordinary merges");
  await assert.rejects(git(result.root, "show", "HEAD:foreign.txt"));
  assert.deepEqual(await readFile(file), bytes);
});

test("cache journal races and current selection races cannot publish a stale prefix", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "A.txt", "a\n"), b = await f.result("B", "B.txt", "b\n");
  const old = f.request([a, b], "one"); await f.run(old);
  const corrected = await f.result("B", "B-new.txt", "new\n");
  const input = f.request([a, corrected], "two"), originalGit = input.gitAt;
  let changed = false, raced;
  input.gitAt = async (cwd, args, options) => {
    const value = await originalGit(cwd, args, options);
    if (!changed && cwd === path.join(old.root, "repository") && args[0] === "pack-objects") {
      changed = true;
      const file = path.join(old.root, "merge.json"), state = JSON.parse(await readFile(file));
      state.concurrentObservation = true; raced = JSON.stringify(state); await writeFile(file, raced);
    }
    return value;
  };
  const before = f.counts.merge;
  const result = await f.run(input);
  assert.equal(changed, true);
  assert.equal(f.counts.merge - before, 2);
  assert.equal(await readFile(path.join(old.root, "merge.json"), "utf8"), raced);
  assert.equal(await git(result.root, "show", "HEAD:B-new.txt"), "new");
  const racing = f.request([a, corrected], "selection-race"), writer = racing.writeJson;
  racing.writeJson = async (file, state) => {
    await writer(file, state);
    if (state.reuseIntent) racing.identity.tasks[0].taskRevision++;
  };
  await assert.rejects(f.run(racing), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  assert.equal(await git(path.join(racing.root, "repository"), "rev-parse", "HEAD"), f.base);
});

test("provenance changes after transport intent refuse before importing or checking out a cached prefix", async t => {
  const f = await fixture(t);
  const a = await f.result("A", "A.txt", "a\n"), b = await f.result("B", "B.txt", "b\n");
  await f.run(f.request([a, b], "one"));
  const next = await f.result("B", "B-extra.txt", "new\n"), input = f.request([a, next], "two");
  const writer = input.writeJson;
  input.writeJson = async (file, state) => {
    await writer(file, state);
    if (state.reuseTransportIntent) input.reuseContext.baseProvenance.agreedMainCommit = "0".repeat(40);
  };
  await assert.rejects(f.run(input), { code: "RELEASE_NATIVE_CHECKOUT_CHANGED" });
  const pending = JSON.parse(await readFile(path.join(input.root, "merge.json")));
  assert.equal(pending.reuseTransportIntent.identityHash.length, 64);
  assert.equal(pending.next, 0);
  assert.equal(await git(path.join(input.root, "repository"), "rev-parse", "HEAD"), f.base);
});

test("actual preparation admits one legacy prepared seed and still refuses missing runtime imports before promotion", async t => {
  const f = await fixture(t, { hub: true });
  const origin = path.join(f.root, "origin.git");
  await git(f.root, "init", "--bare", "--initial-branch=main", origin);
  await git(f.source, "remote", "add", "origin", origin); await git(f.source, "push", "origin", "main");
  const a = await f.result("A", "A.txt", "a\n"), b = await f.result("B", "B.txt", "b\n");
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data"),
    environment: { ...process.env, LOCALAPPDATA: path.join(f.root, "runtime"), XDG_STATE_HOME: path.join(f.root, "runtime") } });
  const request = (tasks, planRevision) => ({ workspaceId: "fixture", projectRoot: f.source,
    approvedBaseCommit: f.base, frozenTasks: tasks, planRevision });
  const first = await service.prepareCandidate(request([a, b], "one"));
  const nativeRoot = path.join(path.dirname(first.releaseRoot), "native-merges");
  const names = await readdir(nativeRoot);
  assert.equal(names.length, 1);
  const journalFile = path.join(nativeRoot, names[0], "merge.json"), legacy = JSON.parse(await readFile(journalFile));
  delete legacy.reuseContext; // Private fixture representing an actual pre-upgrade v1 capture.
  await writeFile(journalFile, JSON.stringify(legacy)); const legacyBytes = await readFile(journalFile);
  const corrected = await f.result("B", "B-new.txt", "new\n");
  let ordinaryMerges = 0;
  const spawn = childProcess.spawn;
  childProcess.spawn = function (executable, args, ...options) {
    if (String(executable) === "git" && args.includes("merge") && args.includes("--no-ff")) ordinaryMerges++;
    return Reflect.apply(spawn, this, [executable, args, ...options]);
  };
  syncBuiltinESMExports();
  let second;
  try { second = await service.prepareCandidate(request([a, corrected], "two")); }
  finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  assert.equal(ordinaryMerges, 1, "legacy seed must be verified and imported, not silently recomposed");
  assert.equal(second.manifest.merges[0].commit, first.manifest.merges[0].commit);
  assert.deepEqual(await readFile(journalFile), legacyBytes, "never add a stamp to the historical journal");
  assert.equal(await git(second.releaseRoot, "show", "HEAD:B-new.txt"), "new");
  const checkpointFile = path.join(path.dirname(second.releaseRoot), "checkpoint.json"), checkpoint = await readFile(checkpointFile);
  const bad = await f.result("Bad", "AgentHub/src/missing-user.mjs", 'import "./absent.mjs";\n');
  await assert.rejects(service.prepareCandidate(request([a, corrected, bad], "missing-import")), /Native runtime import closure failed/u);
  assert.deepEqual(await readFile(checkpointFile), checkpoint);
  assert.equal((await service.frozenCandidate(f.source)).preReleaseHead, second.preReleaseHead);
  const nextB = await f.result("B", "late.txt", "later correction\n");
  let authorityValid = true, drifted = false;
  childProcess.spawn = function (executable, args, ...options) {
    const child = Reflect.apply(spawn, this, [executable, args, ...options]);
    if (String(executable) === "git" && args.includes("fetch") && args.some(x => String(x).includes("retained-"))) {
      child.once("close", () => { authorityValid = false; drifted = true; });
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(service.prepareCandidate({ ...request([a, nextB], "authority-drift"),
      validateBeforeCommit: async () => { if (!authorityValid) throw new Error("controlled current authority changed"); } }),
    /controlled current authority changed/u);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  assert.equal(drifted, true, "fault occurs after the actual retained-object fetch, not before lookup");
  assert.deepEqual(await readFile(checkpointFile), checkpoint);
  assert.equal((await service.frozenCandidate(f.source)).preReleaseHead, second.preReleaseHead);
  assert.equal(await git(f.source, "rev-parse", "HEAD"), f.base);
  assert.equal(await git(f.source, "status", "--porcelain=v1"), "");
});

test("cached prefix checkout preserves an ignored collision and can resume after its owner retires it", async t => {
  const f = await fixture(t);
  // A tracked path in the selected result is ignored in the base checkout.
  // Reuse must keep Git's existing no-overwrite-ignore protection.
  await writeFile(path.join(f.source, ".git/info/exclude"), "private.txt\n");
  const a = await f.result("A", "A.txt", "a\n");
  const folder = f.folders.get("A");
  await writeFile(path.join(folder, "private.txt"), "selected private path\n");
  await git(folder, "add", "-f", "private.txt");
  a.resultCommit = await f.commit(folder, "tracked selected private path");
  const b = await f.result("B", "B.txt", "b\n");
  await f.run(f.request([a, b], "one"));
  const corrected = await f.result("B", "B-extra.txt", "extra\n");
  const input = f.request([a, corrected], "two"), writer = input.writeJson;
  let create = true;
  input.writeJson = async (file, state) => {
    await writer(file, state);
    if (create && state.reuseIntent) {
      create = false;
      const checkout = path.join(input.root, "repository");
      await git(checkout, "config", "core.excludesFile", path.join(f.source, ".git/info/exclude"));
      await writeFile(path.join(checkout, "private.txt"), "owner data to preserve\n");
    }
  };
  await assert.rejects(f.run(input));
  const local = path.join(input.root, "repository/private.txt");
  assert.equal(await readFile(local, "utf8"), "owner data to preserve\n");
  await rm(local); // Only this private fixture's exact owned collision.
  const next = await f.run(input);
  assert.equal(await git(next.root, "show", "HEAD:private.txt"), "selected private path");
});

test("comparable cold and verified-prefix preparation retain identical full content with fewer merges", async t => {
  const f = await fixture(t), tasks = [];
  for (let i = 0; i < 8; i++) {
    const payload = Array.from({ length: 512 }, (_, line) => createHash("sha256").update(`${i}:${line}`).digest("hex")).join("\n") + "\n";
    tasks.push(await f.result(`Task${i}`, `task-${i}.txt`, payload));
  }
  await f.run(f.request(tasks, "initial"));
  const corrected = await f.result("Task7", "correction.txt", "same corrected tail\n");
  const selected = [...tasks.slice(0, 7), corrected];
  const beforeCold = f.counts.merge;
  const cold = await f.run({ ...f.request(selected, "cold-control"), reuseContext: null });
  const coldMerges = f.counts.merge - beforeCold;
  const beforeWarm = f.counts.merge;
  const warm = await f.run(f.request(selected, "verified-prefix"));
  assert.equal(coldMerges, 8);
  assert.equal(f.counts.merge - beforeWarm, 1);
  assert.equal(warm.tree, cold.tree, "same exact inputs must retain the entire same final tree");
  assert.equal(await git(warm.root, "show", "HEAD:correction.txt"), "same corrected tail");
  t.diagnostic(JSON.stringify({ comparable: f.observations.slice(-2),
    statement: "Observed fixture elapsed only, no timing threshold or production speed guarantee" }));
});
