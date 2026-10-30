import path from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { taskGitIdentityHash } from "../../domain/task-git-reference.mjs";
import { createSelectedGitBundle } from "./selected-git-bundle.mjs";
import { measureTaskOperation, recordTaskOperationTiming } from "../process/task-operation-timing.mjs";

// Hints only. The native sequencer retains every journal/effect boundary and
// re-verifies these Git objects without an old identity's review capability.
let implementation;
export async function nativeReuseContext(value) {
  if (!value) return null;
  implementation ??= Promise.all([readFile(new URL(import.meta.url)),
    readFile(new URL("./native-release-merge.mjs", import.meta.url))])
    .then(parts => createHash("sha256").update(Buffer.concat(parts)).digest("hex"));
  return { ...structuredClone(value), version: 1, implementation: await implementation };
}

const plain = info => info && !info.isSymbolicLink();
const same = (a, b) => plain(a) && plain(b)
  && ["dev", "ino", "size", "mtimeNs", "ctimeNs", "birthtimeNs"].every(k => a[k] === b[k]);
async function info(file) {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function snapshot(root) {
  const file = path.join(root, "merge.json"), repository = path.join(root, "repository");
  const parent = await info(root), repo = await info(repository), before = await info(file);
  if (!plain(parent) || !parent.isDirectory() || !plain(repo) || !repo.isDirectory()
      || !plain(before) || !before.isFile()) return null;
  let raw;
  try { raw = await readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!same(before, await info(file)) || !same(parent, await info(root)) || !same(repo, await info(repository))) return null;
  let state;
  try { state = JSON.parse(raw); } catch { return null; }
  return { root, repository, state, hash: createHash("sha256").update(raw).digest("hex"),
    unchanged: async () => {
      if (!same(before, await info(file)) || !same(parent, await info(root)) || !same(repo, await info(repository))) return false;
      return createHash("sha256").update(await readFile(file)).digest("hex") === createHash("sha256").update(raw).digest("hex");
    } };
}

export async function nativeReuseCandidates({ root, identity, context, readLegacyBinding = null }) {
  if (!context) return [];
  return measureTaskOperation("native:reuse-lookup", async () => {
    const parent = path.dirname(root), candidates = [], historical = [];
    for (const item of await readdir(parent, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f0-9]{24}$/u.test(item.name) || path.join(parent, item.name) === root) continue;
      const candidate = await snapshot(path.join(parent, item.name));
      if (!candidate) continue;
      const s = candidate.state;
      if (s.version !== 1 || s.identity?.policy !== identity.policy || s.identity?.workspaceId !== identity.workspaceId
          || s.identity?.baseCommit !== identity.baseCommit || !Array.isArray(s.identity.tasks)
          || s.next !== s.identity.tasks.length || !Array.isArray(s.merges) || s.merges.length !== s.next
          || s.merging || s.conflict || s.head !== (s.merges.at(-1)?.commit ?? identity.baseCommit)) continue;
      let count = 0;
      while (count < Math.min(identity.tasks.length, s.next)
          && taskGitIdentityHash(identity.tasks[count]) === taskGitIdentityHash(s.identity.tasks[count])) count++;
      if (s.reuseContext && taskGitIdentityHash(s.reuseContext) === taskGitIdentityHash(context)) candidates.push({ ...candidate, count });
      else historical.push({ ...candidate, count });
    }
    // One already prepared, hash-bound capture may predate this implementation.
    // Only its existing owning checkpoint reader can supply the missing scope;
    // never stamp/enrich an old journal or trust an arbitrary historical tree.
    if (!candidates.length && historical.length && typeof readLegacyBinding === "function") {
      const binding = await readLegacyBinding();
      const candidate = binding && historical.find(c => c.root === binding.root && c.hash === binding.journalHash
        && taskGitIdentityHash(c.state.identity) === binding.identityHash && c.state.head === binding.head
        && taskGitIdentityHash(c.state.merges) === binding.mergesHash);
      if (candidate && await binding.unchanged() && await candidate.unchanged()) {
        const unchanged = candidate.unchanged;
        candidates.push({ ...candidate, verifyInRepository: binding.verifyInRepository,
          unchanged: async () => await unchanged() && await binding.unchanged() });
      }
    }
    recordTaskOperationTiming("native:reuse-candidates", { count: candidates.length });
    return candidates.sort((a, b) => b.count - a.count || a.root.localeCompare(b.root));
  });
}

async function importCommit({ root, repository, candidate, commit, gitAt, beforeTransport }) {
  if (!await candidate.unchanged()) return false;
  if (candidate.verifyInRepository) commit = candidate.state.head;
  const bundle = path.join(root, `retained-${commit}.bundle`);
  return measureTaskOperation("native:reuse-transport", async () => {
    await beforeTransport({ sourceIdentityHash: taskGitIdentityHash(candidate.state.identity),
      sourceJournalHash: candidate.hash, commit });
    const existing = await info(bundle);
    if (existing) {
      if (!plain(existing) || !existing.isFile()) return false;
      try { await gitAt(repository, ["bundle", "verify", bundle]); }
      catch { return false; } // A partial hint is preserved, never overwritten.
    } else await createSelectedGitBundle({ root, sourceRoot: candidate.repository, bundle, inputs: [commit], gitAt });
    const heads = String(await gitAt(repository, ["bundle", "list-heads", bundle])).split(/\r?\n/u);
    if (!heads.some(row => row.split(" ")[0] === commit)) return false;
    await gitAt(repository, ["fetch", "--no-tags", bundle, commit]);
    if (candidate.verifyInRepository && !candidate.legacyVerified) {
      await candidate.verifyInRepository((args, options = {}) => gitAt(repository, args, options));
      candidate.legacyVerified = true;
    }
    return candidate.unchanged();
  });
}

export async function verifiedNativePrefix({ root, repository, candidates, tasks, baseCommit, gitAt, verify, beforeTransport }) {
  return measureTaskOperation("native:prefix-verify", async () => {
    let best = null;
    for (const candidate of candidates) {
      if (!candidate.count || candidate.count <= (best?.merges.length ?? 0)) break;
      if (!await importCommit({ root, repository, candidate, commit: candidate.state.merges[candidate.count - 1].commit, gitAt, beforeTransport })) continue;
      let before = baseCommit;
      const merges = [];
      for (let i = 0; i < candidate.count; i++) {
        const step = candidate.state.merges[i], task = tasks[i];
        if (step.taskId !== task.taskId || step.resultCommit !== task.resultCommit) break;
        try {
          // No review argument is supplied. Extra bytes/compatibility need a
          // fresh current binding and therefore cannot cross this boundary.
          if (await verify(before, task.resultCommit, step.commit)) break;
        } catch (error) {
          if (error.code?.startsWith("RELEASE_NATIVE_")) break;
          throw error;
        }
        merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: step.commit,
          ...(step.resolved ? { resolved: true } : {}), ...(step.contained ? { contained: true } : {}) });
        before = step.commit;
      }
      if (merges.length > (best?.merges.length ?? 0) && await candidate.unchanged()) {
        best = { head: before, tree: String(await gitAt(repository, ["rev-parse", `${before}^{tree}`])), merges,
          sourceIdentityHash: taskGitIdentityHash(candidate.state.identity), sourceJournalHash: candidate.hash };
      }
    }
    recordTaskOperationTiming("native:prefix-reused", { count: best?.merges.length ?? 0 });
    return best;
  });
}

function stageRecords(output) {
  const records = String(output).split("\0");
  const tree = records.shift(), stages = [];
  for (const row of records) {
    if (!row) break;
    const tab = row.indexOf("\t");
    if (tab < 0) return null;
    stages.push([row.slice(tab + 1), row.slice(0, tab)]);
  }
  return /^[a-f0-9]{40}$/u.test(tree) ? { tree, stages } : null;
}
async function treeEntries(git, tree, recursive = false) {
  return new Map(String(await git(["ls-tree", ...(recursive ? ["-r"] : []), "-z", tree], { rawOutput: true }))
    .split("\0").filter(Boolean).map(row => {
      const tab = row.indexOf("\t"); return [row.slice(tab + 1), row.slice(0, tab)];
    }));
}
async function replaceConflictEntries(git, tree, replacements) {
  const entries = await treeEntries(git, tree), folders = new Map();
  for (const [file, value] of replacements) {
    const slash = file.indexOf("/");
    if (slash < 0) entries.set(file, value);
    else {
      const name = file.slice(0, slash);
      if (!folders.has(name)) folders.set(name, new Map());
      folders.get(name).set(file.slice(slash + 1), value);
    }
  }
  for (const [name, changes] of folders) {
    const entry = entries.get(name);
    if (!entry?.startsWith("040000 tree ")) throw new Error("Native conflict tree shape changed");
    const child = await replaceConflictEntries(git, entry.split(" ")[2], changes);
    entries.set(name, `040000 tree ${child}`);
  }
  return String(await git(["mktree", "-z"], { input: [...entries].map(([name, entry]) => `${entry}\t${name}\0`).join("") }));
}

export async function retainedNativeConflict({ root, repository, candidates, state, task, identity, gitAt, verify, beforeTransport }) {
  return measureTaskOperation("native:conflict-reuse", async () => {
    const git = (args, options = {}) => gitAt(repository, args, options);
    const stages = state.conflict.stages.filter(([, entry]) => !entry.endsWith(" 0"));
    const current = stageRecords(await git(["merge-tree", "--write-tree", "-z", state.head, task.resultCommit],
      { rawOutput: true, acceptableExitCodes: [1] }));
    if (!current || taskGitIdentityHash(current.stages) !== taskGitIdentityHash(stages)) return null;
    for (const candidate of candidates) {
      for (const [i, step] of candidate.state.merges.entries()) {
        if (!step.resolved || step.taskId !== task.taskId || !await candidate.unchanged()) continue;
        const before = i ? candidate.state.merges[i - 1].commit : candidate.state.identity.baseCommit;
        if (!await importCommit({ root, repository, candidate, commit: step.commit, gitAt, beforeTransport })) continue;
        const old = stageRecords(await git(
          ["merge-tree", "--write-tree", "-z", before, step.resultCommit], { rawOutput: true, acceptableExitCodes: [1] }));
        if (!old || taskGitIdentityHash(old.stages) !== taskGitIdentityHash(stages)) continue;
        const selected = await treeEntries(git, `${step.commit}^{tree}`, true), replacements = new Map();
        for (const file of state.conflict.paths) {
          const entry = selected.get(file);
          if (!/^(100644|100755) blob [a-f0-9]{40}$/u.test(entry ?? "")) break;
          replacements.set(file, entry);
        }
        if (replacements.size !== state.conflict.paths.length) continue;
        const tree = await replaceConflictEntries(git, current.tree, replacements);
        const commit = String(await git(["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
          "commit-tree", tree, "-p", state.head, "-p", task.resultCommit, "-m", "Reuse exact retained native conflict context"]));
        try { if (await verify(state.head, task.resultCommit, commit)) continue; }
        catch (error) {
          if (error.code?.startsWith("RELEASE_NATIVE_")) continue;
          throw error;
        }
        if (!await candidate.unchanged()) continue;
        recordTaskOperationTiming("native:conflict-reused", { count: state.conflict.paths.length });
        return { identityHash: taskGitIdentityHash(identity), parents: [state.head, task.resultCommit], commit, tree,
          sourceJournalHash: candidate.hash, sourceCommit: step.commit,
          contextHash: taskGitIdentityHash(stages) };
      }
    }
    return null;
  });
}
