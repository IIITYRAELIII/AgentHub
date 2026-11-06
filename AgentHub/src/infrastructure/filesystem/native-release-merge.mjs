import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createSelectedGitBundle } from "./selected-git-bundle.mjs";
import { createHash } from "node:crypto";
import { taskGitIdentityHash } from "../../domain/task-git-reference.mjs";
import { selectedCompositionFields, normalizedSelectedAbsorption, selectedAbsorptionHandoff }
  from "../../domain/task-selected-composition.mjs";
import { nativeReuseContext, nativeReuseCandidates, verifiedNativePrefix, retainedNativeConflict } from "./native-merge-reuse.mjs";
import { measureTaskOperation } from "../process/task-operation-timing.mjs";

// Internal Git sequencing of ReleaseGitWorkspaceService. This has no Task,
// publication or ref-promotion authority. The application retains those leases.
export const NATIVE_RELEASE_POLICY = "main-selected-git-merge-v1";

// Preserve the exact scalar field for historical single-base captures. Git's
// --all order is not authority; a multiple-base capture binds the complete set.
export function nativeMergeBaseFields(output) {
  const bases = String(output).split(/\r?\n/u);
  if (!bases.length || bases.some(base => !/^[a-f0-9]{40}$/u.test(base))
      || new Set(bases).size !== bases.length) throw failure("Native merge bases must be distinct full Git commit ids");
  return bases.length === 1 ? { mergeBase: bases[0] } : { mergeBases: bases.sort() };
}

async function publishedVirtualReplay({ git, identity, baseCommit, tasks }) {
  if (!Object.hasOwn(identity, "mergeBases") && !tasks.some(task => Object.hasOwn(task, "mergeBases"))) return false;
  const task = tasks[0];
  if (identity.policy !== "published-main-dev-sync-v1" || tasks.length !== 1
      || identity.devCommit !== baseCommit || task.taskId !== `published:${identity.operationId}`
      || task.resultCommit !== identity.publishedRevision || Object.hasOwn(identity, "mergeBase")
      || Object.hasOwn(task, "baseCommit") || !Array.isArray(identity.mergeBases)
      || identity.mergeBases.length < 2 || !Array.isArray(task.mergeBases)
      || JSON.stringify(task.mergeBases) !== JSON.stringify(identity.mergeBases)) {
    throw failure("Published native merge-base binding changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  const actual = nativeMergeBaseFields(await git(["merge-base", "--all", baseCommit, task.resultCommit]));
  if (JSON.stringify(actual.mergeBases) !== JSON.stringify(identity.mergeBases)) {
    throw failure("Published native merge-base set changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  return true;
}

async function maybe(git, args, options) {
  try { return await git(args, options); } catch { return null; }
}

function failure(message, code = "RELEASE_NATIVE_HISTORY_REQUIRED", details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

async function metadataEntry(git, commit, file) {
  const output = String(await git(["--literal-pathspecs", "ls-tree", "--full-tree", "-z", commit, "--", file],
    { rawOutput: true }));
  if (!output) return null;
  const records = output.split("\0");
  const match = /^(\d{6}) blob ([a-f0-9]{40})\t([\s\S]*)$/u.exec(records[0]);
  if (records.length !== 2 || records[1] !== "" || !match || match[3] !== file) {
    throw failure("Native metadata lookup is malformed or ambiguous");
  }
  return `${match[1]} ${match[2]}`;
}

export async function assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority = null }) {
  // Internal context, verified by the owning caller at every effect boundary.
  // Only Test may include its already managed dev ancestry here.
  const bases = [...new Set([baseCommit, ...(historyAuthority?.bases ?? [])])];
  const owned = new Set();
  const histories = [];
  for (const task of tasks) {
    const taskBase = task.baseCommit || baseCommit;
    // The result ancestry check below still proves both commit objects exist,
    // including an empty result. Equal base OIDs need no additional self-query.
    if (taskBase !== baseCommit && await maybe(git, ["merge-base", "--is-ancestor", taskBase, baseCommit]) === null
        || await maybe(git, ["merge-base", "--is-ancestor", taskBase, task.resultCommit]) === null) {
      throw failure(`Task ${task.taskId} requires a main-based result or explicit historical migration`);
    }
    const rows = String(await git([
      "rev-list", "--first-parent", "--parents", task.resultCommit, ...bases.map(b => `^${b}`),
    ])).split(/\r?\n/u).filter(Boolean).map((row) => row.split(" "));
    for (const [commit] of rows) owned.add(commit);
    histories.push({ task, rows });
    const adopted = (historyAuthority?.adoptions ?? []).filter(a => a.taskId === task.taskId
      && a.resultCommit === task.resultCommit);
    const metadataBases = [...new Set([taskBase, ...(historyAuthority?.metadataBases ?? []),
      ...adopted.map(a => a.adoptedCommit)])];
    // One immutable tree diff supplies both metadata classes. Keep all existing
    // per-file mode/blob/version checks and re-read at every owning boundary.
    const changedMetadata = String(await git([
      "diff", "--name-only", "--no-renames", "-z", taskBase, task.resultCommit,
      "--", "CHANGELOG.md", ":(glob)**/CHANGELOG.md", "package.json", "package-lock.json",
      ":(glob)**/package.json", ":(glob)**/package-lock.json",
    ], { rawOutput: true })).split("\0").filter(Boolean);
    // Literal root pathspecs also cover descendants of a directory with that
    // name. Preserve that existing ownership check, not just basename matches.
    const matchesMetadata = (file, names) => names.some(name => file.startsWith(`${name}/`)
      || path.posix.basename(file) === name);
    for (const file of changedMetadata.filter(file => matchesMetadata(file, ["CHANGELOG.md"]))) {
      const entry = await metadataEntry(git, task.resultCommit, file);
      const known = [];
      for (const b of metadataBases) known.push(await metadataEntry(git, b, file));
      const historical = file === "CHANGELOG.md" && (historyAuthority?.changelogEntries ?? []).some(bound =>
        bound.taskId === task.taskId && bound.resultCommit === task.resultCommit && bound.path === file
          && bound.mode === "100644" && entry === `${bound.mode} ${bound.blob}`);
      if (entry === null || !known.includes(entry) && !historical) throw failure(`Task ${task.taskId} changes release-owned CHANGELOG metadata`);
    }
    const packages = changedMetadata.filter(file => matchesMetadata(file, ["package.json", "package-lock.json"]));
    for (const file of packages) {
      const priors = [];
      for (const b of metadataBases) priors.push(await maybe(git, ["show", `${b}:${file}`]));
      if (priors.every(bytes => bytes === null)) continue; // New packages are Task content.
      const nextBytes = await maybe(git, ["show", `${task.resultCommit}:${file}`]);
      const next = nextBytes === null ? null : JSON.parse(nextBytes);
      if (!priors.filter(bytes => bytes !== null).map(bytes => JSON.parse(bytes)).some(prior =>
        (prior.version === undefined || prior.version === next?.version)
          && (prior.packages?.[""]?.version === undefined
            || prior.packages[""].version === next?.packages?.[""]?.version))) {
        throw failure(`Task ${task.taskId} changes release-owned package-version metadata: ${file}`);
      }
    }
  }
  for (const { task, rows } of histories) {
    const selected = selectedCompositionFields(task);
    // Fresh admission is supplied only by TaskLifecycle under both Task leases.
    // Release preparation uses the sealed descriptor from the committed Test.
    const absorbed = selected.selectedComposition?.absorptionInput ?? task.nativeAbsorptionInput;
    let authorizedSide = null;
    if (absorbed) {
      const binding = normalizedSelectedAbsorption(absorbed);
      const d = selectedAbsorptionHandoff({ requestId: binding.requestId, text: binding.text }).declaration;
      for (const prior of binding.priorResults ?? []) {
        const parent = prior.taskId === d.sourceTaskId ? d.sourceCommit : d.survivorParentCommit;
        if (await maybe(git, ["merge-base", "--is-ancestor", d.baseCommit, prior.resultCommit]) === null
            || await maybe(git, ["merge-base", "--is-ancestor", prior.resultCommit, parent]) === null) {
          throw failure(`Task ${task.taskId} absorbed prior result is not retained by its exact parent`);
        }
      }
      if (d.survivorTaskId !== task.taskId
          || d.baseCommit !== (task.baseCommit || baseCommit)
          || await maybe(git, ["merge-base", "--is-ancestor", d.absorptionCommit, task.resultCommit]) === null
          || String(await git(["show", "-s", "--format=%P", d.absorptionCommit]))
            !== `${d.survivorParentCommit} ${d.sourceCommit}`
          || String(await git(["rev-parse", `${d.sourceCommit}^{tree}`])) !== d.sourceTree) {
        throw failure(`Task ${task.taskId} absorbed history differs from its accepted durable proof`);
      }
      const sourceRows = String(await git(["rev-list", "--first-parent", "--parents",
        d.sourceCommit, `^${baseCommit}`])).split(/\r?\n/u).filter(Boolean).map(row => row.split(" "));
      if (sourceRows.some(row => row.length !== 2)
          || await maybe(git, ["merge-base", "--is-ancestor", d.baseCommit, d.sourceCommit]) === null) {
        throw failure(`Task ${task.taskId} absorbed source requires explicit historical migration`);
      }
      authorizedSide = { commit: d.absorptionCommit, source: d.sourceCommit };
    }
    for (const [commit, ...parents] of rows) {
      if (parents.length > 2 || !parents.length) throw failure(`Task ${task.taskId} has unsupported result history`);
      for (const side of parents.slice(1)) {
        const trustedBases = [...bases, ...(historyAuthority?.adoptions ?? [])
          .filter(a => a.taskId === task.taskId && a.resultCommit === task.resultCommit).map(a => a.adoptedCommit)];
        let contained = false;
        for (const b of trustedBases) {
          if (await maybe(git, ["merge-base", "--is-ancestor", side, b]) !== null) { contained = true; break; }
        }
        if (!owned.has(side) && !(authorizedSide?.commit === commit && authorizedSide.source === side)
            && !contained) {
          throw failure(`Task ${task.taskId} contains an unselected merge side; migrate it explicitly`,
            "RELEASE_NATIVE_HISTORY_REQUIRED", { taskId: task.taskId, sideCommit: side });
        }
      }
    }
  }
}

async function entries(git, args) {
  return String(await git(args)).split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Invalid native Git index record");
    return [entry.slice(separator + 1), entry.slice(0, separator)];
  });
}

async function requireClean(git) {
  if (String(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]))) {
    throw failure("Native merge checkout has unsaved or foreign files", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
}

async function requireUntouchedConflict(git, before, result, conflict) {
  if (JSON.stringify(await entries(git, ["ls-files", "--stage", "-z"])) !== JSON.stringify(conflict.stages)
      || String(await git(["ls-files", "--others", "--exclude-standard", "-z"], { rawOutput: true }))) {
    throw failure("Native conflict contains unsaved executor work", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  const modified = String(await git(["diff-files", "--name-only", "-z"], { rawOutput: true })).split("\0").filter(Boolean);
  if (modified.some(file => !conflict.paths.includes(file))) {
    throw failure("Native automatic worktree bytes changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  const output = String(await git(["merge-tree", "--write-tree", "--name-only", "-z", before, result],
    { acceptableExitCodes: [1] })).split("\0");
  const automaticTree = output[0];
  for (const file of conflict.paths) {
    // Git's ordinary text conflict uses HEAD in the checkout and the exact
    // first-parent OID in merge-tree. Refuse other driver/marker shapes rather
    // than replacing an executor's uncommitted resolution.
    const body = String(await git(["show", `${automaticTree}:${file}`], { rawOutput: true }));
    const marker = `<<<<<<< ${before}\n`;
    if (!body.includes(marker)) throw failure("Native conflict requires explicit owned resolution", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    const expected = Buffer.from(body.replaceAll(marker, "<<<<<<< HEAD\n"));
    const blob = createHash("sha1").update(`blob ${expected.length}\0`).update(expected).digest("hex");
    if (String(await git(["hash-object", `--path=${file}`, file])) !== blob) {
      throw failure("Native conflict contains unsaved executor resolution", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
  }
}

// A conflict belongs to its marker ranges, not to every byte of its file.
// In particular, replacing that whole file with one parent may discard clean
// changes made by another selected Task outside the actual conflict.
async function changesCleanConflictContext(git, automaticTree, target, file, before, result) {
  let body;
  try { body = String(await git(["show", `${automaticTree}:${file}`], { rawOutput: true })); }
  catch { return true; }
  const lines = body.split("\n");
  const start = `<<<<<<< ${before}`, end = `>>>>>>> ${result}`;
  if (!lines.includes(start)) {
    // Binary/type/delete conflicts have no text marker ranges. Existing exact
    // parent choices remain ordinary resolution; other bytes need review.
    const entry = async ref => new Map(await entries(git,
      ["--literal-pathspecs", "ls-tree", "--full-tree", "-z", ref, "--", file])).get(file);
    const chosen = await entry(target);
    return chosen !== await entry(before) && chosen !== await entry(result);
  }
  const ranges = [];
  let opened = null, separator = false;
  for (const [index, line] of lines.entries()) {
    if (line === start) {
      if (opened !== null) return true;
      opened = index + 1; separator = false;
    } else if (opened !== null && line === "=======") {
      if (separator) return true;
      separator = true;
    } else if (line === end) {
      if (opened === null || !separator) return true;
      ranges.push([opened, index + 1]); opened = null;
    }
  }
  if (opened !== null || !ranges.length) return true;
  const patch = String(await git(["--literal-pathspecs", "-c", "diff.algorithm=myers", "diff", "--no-ext-diff", "--no-textconv",
    "--no-renames", "--no-color", "--no-indent-heuristic", "--unified=0", "--inter-hunk-context=0",
    automaticTree, target, "--", file], { rawOutput: true }));
  let hunks = 0;
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gmu)) {
    hunks += 1;
    const first = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) {
      if (!ranges.some(([a, b]) => first >= a - 1 && first <= b)) return true;
    } else {
      let next = first;
      for (const [a, b] of ranges) {
        if (next >= a && next <= b) next = Math.min(first + count, b + 1);
        if (next === first + count) break;
      }
      if (next !== first + count) return true;
    }
  }
  return hunks === 0;
}

// A recorded owned resolution covers its real conflict files, including
// compatibility edits outside marker ranges. Keep structural loss checks:
// choosing an entire parent, deleting clean code, or restoring the other
// parent's clean context is not evidence that selected code was preserved.
async function retainsConflictCleanContext(git, automaticTree, target, file, before, result, baseCommit) {
  const body = String(await git(["show", `${automaticTree}:${file}`], { rawOutput: true }));
  const resolved = String(await git(["show", `${target}:${file}`], { rawOutput: true }));
  const parents = await Promise.all([before, result].map(async commit => {
    const value = await maybe(git, ["show", `${commit}:${file}`], { rawOutput: true });
    return value === null ? null : String(value);
  }));
  const baselineValue = baseCommit ? await maybe(git, ["show", `${baseCommit}:${file}`], { rawOutput: true }) : null;
  const baseline = baselineValue === null ? null : String(baselineValue);
  if (parents.includes(resolved)) return false;
  const ranges = [];
  let opened = null;
  for (const [index, line] of body.split("\n").entries()) {
    if (line === `<<<<<<< ${before}`) opened = index + 1;
    if (line === `>>>>>>> ${result}` && opened !== null) {
      ranges.push([opened, index + 1]); opened = null;
    }
  }
  if (opened !== null || !ranges.length) return false;
  const patch = String(await git(["--literal-pathspecs", "-c", "diff.algorithm=myers", "diff", "--no-ext-diff", "--no-textconv",
    "--no-renames", "--no-color", "--no-indent-heuristic", "--unified=0", "--inter-hunk-context=0",
    automaticTree, target, "--", file], { rawOutput: true }));
  if (/^(?:old mode|new mode|deleted file|new file|Binary files)/mu.test(patch)) return false;
  const words = value => value.match(/[A-Za-z0-9_$]+|[^\s]/gu) ?? [];
  const counts = value => {
    const result = new Map();
    for (const word of words(value)) result.set(word, (result.get(word) ?? 0) + 1);
    return result;
  };
  const losesWords = (oldText, newText) => {
    const retained = counts(newText);
    return [...counts(oldText)].some(([word, count]) => count > (retained.get(word) ?? 0));
  };
  const inlineEdit = (oldText, newText) => {
    const oldWords = words(oldText), newWords = words(newText);
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(oldWords.length, newWords.length) && oldWords[prefix] === newWords[prefix]) prefix++;
    while (suffix < Math.min(oldWords.length, newWords.length) - prefix
        && oldWords[oldWords.length - suffix - 1] === newWords[newWords.length - suffix - 1]) suffix++;
    // An inline compatibility edit retains both of its local boundaries. A
    // whole-line deletion, or the same words removed elsewhere in the file,
    // cannot provide evidence for losing this selected line.
    if (!prefix || !suffix) return null;
    const removed = oldWords.slice(prefix, oldWords.length - suffix);
    const added = newWords.slice(prefix, newWords.length - suffix);
    // A parameter removed from the middle of a declaration can be the last
    // shorthand argument at a caller. Its adjacent comma changes sides; the
    // ordered removed tokens, not a file-wide word count, carry that edit.
    if (removed[0] === ",") removed.shift();
    if (removed.at(-1) === ",") removed.pop();
    return !added.length && removed.length ? removed : null;
  };
  let incomingEdits = null;
  const selectedInlineEdits = async () => {
    if (incomingEdits) return incomingEdits;
    incomingEdits = [];
    // Use Git's actual stage-1 blob, including its virtual merge base. Do not
    // treat the current parent's unique additions as incoming removals.
    const stages = String(await git(["merge-tree", "--write-tree", "-z", before, result],
      { acceptableExitCodes: [1] })).split("\0");
    const stage = stages.find(row => row.slice(row.indexOf("\t") + 1) === file
      && row.slice(0, row.indexOf("\t")).split(" ")[2] === "1");
    if (!stage) return incomingEdits;
    const baseBlob = stage.split(" ")[1];
    const resultBlob = String(await git(["rev-parse", `${result}:${file}`]));
    const delta = String(await git(["-c", "diff.algorithm=myers", "diff", "--no-ext-diff", "--no-textconv", "--no-color",
      "--no-indent-heuristic", "--unified=0", "--inter-hunk-context=0", baseBlob, resultBlob], { rawOutput: true }));
    let inHunk = false;
    let oldLines = [], newLines = [];
    const retainEdits = () => {
      if (oldLines.length !== newLines.length) return;
      for (let index = 0; index < oldLines.length; index++) {
        const edit = inlineEdit(oldLines[index], newLines[index]);
        if (edit) incomingEdits.push(edit);
      }
    };
    for (const line of delta.split("\n")) {
      if (line.startsWith("@@ ")) {
        retainEdits(); inHunk = true; oldLines = []; newLines = [];
      } else if (inHunk && line.startsWith("-")) oldLines.push(line.slice(1));
      else if (inHunk && line.startsWith("+")) newLines.push(line.slice(1));
      else if (inHunk && line.startsWith("\\")) {
        // An unterminated boundary cannot supply a complete inline edit.
        oldLines = []; newLines = []; inHunk = false;
      }
    }
    retainEdits();
    return incomingEdits;
  };
  let sourceLine = 0, removed = [], added = [], markerEdit = false;
  const preserved = async () => {
    if (!removed.some(line => line.trim())) return true;
    const oldBlock = removed.join("\n") + "\n", newBlock = added.join("\n") + "\n";
    // Common to both selected parents is not sufficient: both may have added
    // this same unique code after the composition baseline.
    if (baseline !== null && baseline.includes(oldBlock)) return true;
    // Mixed marker/clean hunks cannot lend their conflict additions to erased
    // unique clean code. Ordinary marker-only edits need no such projection.
    if (markerEdit) return false;
    if (!losesWords(oldBlock, newBlock)) return true;
    if (removed.length !== added.length) return false;
    const available = await selectedInlineEdits();
    for (let index = 0; index < removed.length; index++) {
      if (!losesWords(removed[index], added[index])) continue;
      const edit = inlineEdit(removed[index], added[index]);
      // A shorthand use may omit the declaration's default value, but its
      // removed tokens must still be one contiguous part of that same inline
      // deletion. Never combine unrelated removals or permute their words.
      if (!edit || !available.some(incoming => incoming.some((_, start) =>
        edit.every((word, offset) => incoming[start + offset] === word)))) return false;
    }
    return true;
  };
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      if (!await preserved()) return false;
      sourceLine = Number(hunk[1]); removed = []; added = []; markerEdit = false;
    } else if (sourceLine && line.startsWith("-")) {
      if (!ranges.some(([a, b]) => sourceLine >= a && sourceLine <= b)) removed.push(line.slice(1));
      else markerEdit = true;
      sourceLine++;
    } else if (sourceLine && line.startsWith("+")) added.push(line.slice(1));
    else if (sourceLine && line.startsWith(" ")) sourceLine++;
  }
  return preserved();
}

async function publishedTaskReplayBase({ git, baseCommit, tasks, identity }) {
  // TaskGit seals this repository publication in the original Test intent and
  // revalidates it through its existing source/origin/CAS fences. It is not a
  // new Task base or authority inferred from dev, a remote ref or merge output.
  const publication = identity.policy === "native-dev-merge-v1"
    ? identity.nativeHistoryAuthority?.publishedMetadata : null;
  if (!publication) return null;
  const task = tasks[0];
  if (tasks.length !== 1 || identity.taskId !== task.taskId || identity.resultCommit !== task.resultCommit
      || identity.before !== baseCommit || !publication.generation || !publication.repositoryRoot
      || !/^[a-f0-9]{64}$/u.test(publication.recordHash)
      || !/^[a-f0-9]{40}$/u.test(publication.commit) || !/^[a-f0-9]{40}$/u.test(publication.tree)
      || identity.nativeHistoryAuthority.baseline
      || identity.nativeHistoryAuthority.sourcePublication
        && identity.nativeHistoryAuthority.sourcePublication.revision !== publication.commit
      || String(await git(["rev-parse", `${publication.commit}^{tree}`])) !== publication.tree) {
    throw failure("Native Test published content authority changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  // Credit only this exact, single published parent boundary. Other histories,
  // including virtual multiple bases, retain their existing replay policy.
  if (String(await git(["merge-base", "--all", baseCommit, task.resultCommit])) !== publication.commit) return null;
  if (await maybe(git, ["merge-base", "--is-ancestor", task.baseCommit || baseCommit, publication.commit]) === null) {
    throw failure("Native Test published content base is outside its agreed history", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  return publication.commit;
}

// A replay can reinsert a complete block already present in the composition.
// Treat only byte-identical additions as idempotent; deletion, replacement,
// binary and mode changes still need their actual native merge evidence.
async function repeatsRetainedContent(git, head, replayTree, file) {
  const patch = String(await git(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
    "--no-renames", "--no-color", "--unified=0", head, replayTree, "--", file], { rawOutput: true }));
  if (/^(?:old mode|new mode|deleted file|new file|Binary files)/mu.test(patch)) return false;
  const body = String(await git(["show", `${head}:${file}`], { rawOutput: true }));
  let block = null, additions = 0;
  const retained = () => block !== null && block.length > 0 && body.includes(block.join("\n") + "\n");
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      if (block !== null && !retained()) return false;
      block = []; additions += 1;
    } else if (block !== null) {
      if (line.startsWith("+")) block.push(line.slice(1));
      else if (line.startsWith("-") && line.slice(1).trim() !== "" || line.startsWith("\\")) return false;
    }
  }
  return additions > 0 && retained();
}

// Reachability alone does not prove content. Reproduce each selected delta, but
// retain the actual automatic context and verified conflict resolutions instead
// of requiring a message to authorize that same Git evidence.
async function assertSelectedContent({ git, baseCommit, tasks, head, resolutions, identity, merges }) {
  const virtualReplay = await publishedVirtualReplay({ git, identity, baseCommit, tasks });
  const publishedBase = await publishedTaskReplayBase({ git, baseCommit, tasks, identity });
  const target = new Map(await entries(git, ["ls-tree", "-r", "-z", head]));
  const resolvedPaths = new Set();
  for (const { binding, conflictPaths } of resolutions) {
    const resolved = new Map(await entries(git, ["ls-tree", "-r", "-z", binding.tree]));
    for (const file of conflictPaths) {
      if (target.get(file) === resolved.get(file)) resolvedPaths.add(file);
    }
  }
  for (const [index, task] of tasks.entries()) {
    const prefix = index === 0 ? baseCommit : merges[index - 1].commit;
    const merged = await maybe(git, ["merge-base", "--is-ancestor", task.resultCommit, prefix]) === null;
    const actual = merged ? new Map(await entries(git, ["ls-tree", "-r", "-z",
      (String(await git(["merge-tree", "--write-tree", "--name-only", "-z", prefix, task.resultCommit],
        { acceptableExitCodes: [1] })).split("\0"))[0]])) : new Map();
    const replayBefore = virtualReplay ? baseCommit : head;
    const replay = String(await git(["merge-tree", "--write-tree", "--name-only", "-z",
      ...(virtualReplay ? [] : [`--merge-base=${publishedBase || task.baseCommit || baseCommit}`]),
      replayBefore, task.resultCommit], { acceptableExitCodes: [1] })).split("\0");
    const replayTree = replay.shift();
    if (!/^[a-f0-9]{40}$/u.test(replayTree)) throw failure("Selected Task content replay is unavailable");
    const conflicts = new Set();
    for (const file of replay) { if (!file) break; conflicts.add(file); }
    const expected = new Map(await entries(git, ["ls-tree", "-r", "-z", replayTree]));
    const missing = [];
    for (const file of new Set([...expected.keys(), ...target.keys()])) {
      if (expected.get(file) === target.get(file) || resolvedPaths.has(file)
          || actual.get(file) === target.get(file) && actual.has(file)) continue;
      if ((!conflicts.has(file) || await changesCleanConflictContext(git, replayTree, head, file, replayBefore, task.resultCommit))
          && !await repeatsRetainedContent(git, head, replayTree, file)) missing.push(file);
    }
    if (missing.length) throw failure(`Selected Task ${task.taskId} changes are missing from the candidate`,
      "RELEASE_SELECTED_CONTENT_MISSING", { taskId: task.taskId, resultCommit: task.resultCommit,
        candidateCommit: head, missingPaths: missing.sort() });
  }
}

// Recompute Git evidence on every reopen. Historical reviewedResolution is only
// an old spelling of this immutable Git binding; its message/receipt is ignored.
async function verifyMergeStep(git, before, result, target, { storedBinding = null, ownedResolution = false, baseCommit = null } = {}) {
  if (await maybe(git, ["merge-base", "--is-ancestor", result, before]) !== null) {
    if (target !== before) throw failure("Contained native result changed the prefix");
    return null;
  }
  if (String(await git(["show", "-s", "--format=%P", target])) !== `${before} ${result}`) {
    throw failure("Completed native merge parents changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  const output = String(await git(["merge-tree", "--write-tree", "--name-only", "-z", before, result],
    { acceptableExitCodes: [1] })).split("\0");
  const automaticTree = output.shift();
  if (!/^[a-f0-9]{40}$/u.test(automaticTree)) throw failure("Native automatic tree unavailable");
  const conflicts = new Set();
  for (const file of output) { if (!file) break; conflicts.add(file); }
  const automatic = new Map(await entries(git, ["ls-tree", "-r", "-z", automaticTree]));
  const tree = String(await git(["rev-parse", `${target}^{tree}`]));
  const resolved = new Map(await entries(git, ["ls-tree", "-r", "-z", tree]));
  const extraPaths = [];
  for (const file of new Set([...automatic.keys(), ...resolved.keys()])) {
    if (automatic.get(file) === resolved.get(file)) continue;
    if (!conflicts.has(file)
        || await changesCleanConflictContext(git, automaticTree, target, file, before, result)) extraPaths.push(file);
  }
  const diff = await git(["diff", "--binary", "--full-index", "--no-renames", automaticTree, tree], { rawOutput: true });
  const binding = { parents: [before, result], commit: target, tree, automaticTree,
    diffSha256: createHash("sha256").update(diff).digest("hex") };
  if (storedBinding && Object.keys(binding).some(key =>
    JSON.stringify(storedBinding[key]) !== JSON.stringify(binding[key]))) {
    throw failure("Recorded native resolution binding changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  if (extraPaths.length && !ownedResolution && !storedBinding) {
    throw failure("Completed automatic native prefix contains unexpected changes", "RELEASE_SELECTED_CONTENT_MISSING",
      { candidateCommit: target, missingPaths: extraPaths.sort() });
  }
  const conflictPaths = [];
  for (const file of conflicts) {
    if (extraPaths.includes(file) && (ownedResolution || storedBinding)
        && !await retainsConflictCleanContext(git, automaticTree, target, file, before, result, baseCommit)) {
      throw failure("Owned conflict resolution discards selected clean context", "RELEASE_SELECTED_CONTENT_MISSING",
        { candidateCommit: target, missingPaths: [file] });
    }
    conflictPaths.push(file);
  }
  return { before, commit: target, binding, conflictPaths };
}

// Verify an already accepted native candidate without composing another one.
export async function assertNativePreparedComposition({ git, baseCommit, tasks, merges, head, tree,
  identity = { policy: NATIVE_RELEASE_POLICY, baseCommit, tasks }, historyAuthority = null }) {
  await assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority });
  return assertNativeMergedResults({ git, baseCommit, tasks, merges, head, tree, identity });
}

// History authority remains with the owning caller. This shared object-only
// verifier also checks a retained composition without acquiring new authority.
export async function assertNativeMergedResults({ git, baseCommit, tasks, merges, head, tree, identity }) {
  if (!Array.isArray(merges) || merges.length !== tasks.length) throw failure("Prepared native selection changed");
  let prefix = baseCommit;
  const resolutions = [];
  for (const [index, step] of merges.entries()) {
    const task = tasks[index];
    if (step.taskId !== task.taskId || step.resultCommit !== task.resultCommit) {
      throw failure("Prepared native result evidence changed");
    }
    const resolution = await verifyMergeStep(git, prefix, step.resultCommit, step.commit,
      { storedBinding: step.resolution?.binding ?? step.reviewedResolution?.binding, baseCommit });
    if (resolution) resolutions.push(resolution);
    prefix = step.commit;
  }
  if (prefix !== head || String(await git(["rev-parse", `${head}^{tree}`])) !== tree) {
    throw failure("Prepared native head or tree changed");
  }
  await assertSelectedContent({ git, baseCommit, tasks, head, resolutions, identity, merges });
}

// Every accepted step is a real Git merge commit (or an already-contained
// result). A conflict leaves Git's MERGE_HEAD/index in this private checkout.
// An executor resolves it with ordinary git add/commit; continuation checks the
// exact ordered parents and preserves all previously automatic clean entries.
export async function mergeSelectedResults({
  root, sourceRoot, baseCommit, tasks, identity, gitAt, readJson, writeJson,
  deliveredHead = null,
  reuseContext = null,
  readLegacyReuseBinding = null,
}) {
  const repository = path.join(root, "repository");
  const stateFile = path.join(root, "merge.json");
  await mkdir(root, { recursive: true });
  const reuse = await nativeReuseContext(reuseContext);
  const identityHash = taskGitIdentityHash(identity);
  const tasksHash = taskGitIdentityHash(tasks), contextHash = reuseContext == null ? null : taskGitIdentityHash(reuseContext);
  const assertCurrentInputs = () => {
    if (taskGitIdentityHash(identity) !== identityHash || taskGitIdentityHash(tasks) !== tasksHash
        || (reuseContext == null ? null : taskGitIdentityHash(reuseContext)) !== contextHash
        || reuse && (identity.baseCommit !== baseCommit || taskGitIdentityHash(identity.tasks) !== tasksHash)) {
      throw failure("Native current selection or provenance changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
  };
  assertCurrentInputs();
  await publishedVirtualReplay({ git: (args, options) => gitAt(sourceRoot, args, options), identity, baseCommit, tasks });
  const candidates = await nativeReuseCandidates({ root, identity, context: reuse, readLegacyBinding: readLegacyReuseBinding });
  let state = await readJson(stateFile);
  if (state && JSON.stringify(state.identity) !== JSON.stringify(identity)) {
    throw failure("Native merge staging identity changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  if (!state) {
    // Transport only Git objects/refs. Direct upload-pack from a repository with
    // mandatory local hooks is refused by Git clone protection; keep that
    // protection enabled and never import or execute the source configuration.
    const bundle = path.join(root, "source.bundle");
    const inputs = [...new Set([baseCommit, ...tasks.map(task => task.resultCommit)])];
    // The existing owner may have fetched an exact result with no local ref.
    // Private exact refs include that ancestry without a growing revision argv.
    await measureTaskOperation("native:bundle", () => createSelectedGitBundle({ root, sourceRoot, bundle, inputs, gitAt }));
    await measureTaskOperation("native:clone", () => gitAt(root, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", bundle, repository]));
    const git = (args) => gitAt(repository, args);
    for (const commit of inputs) {
      await git(["cat-file", "-e", `${commit}^{commit}`]);
    }
    await git(["checkout", "--detach", "--no-overwrite-ignore", baseCommit]);
    state = { version: 1, identity, next: 0, head: baseCommit, merges: [], conflict: null,
      ...(reuse ? { reuseContext: reuse } : {}) };
    await writeJson(stateFile, state);
  }
  const git = (args, options) => gitAt(repository, args, options);
  const beforeTransport = async binding => {
    assertCurrentInputs();
    state.reuseTransportIntent = { identityHash, ...binding };
    await writeJson(stateFile, state);
    assertCurrentInputs();
  };
  
  if (reuse && state.reuseContext && taskGitIdentityHash(state.reuseContext) === taskGitIdentityHash(reuse)
      && state.next === 0 && !state.merging && !state.conflict && !state.reuseIntent) {
    const prefix = await verifiedNativePrefix({ root, repository, candidates, tasks, baseCommit, gitAt, beforeTransport,
      verify: (before, result, target, step) => verifyMergeStep(git, before, result, target, { storedBinding: step?.resolution?.binding ?? step?.reviewedResolution?.binding, baseCommit }) });
    if (prefix) {
      state.reuseIntent = prefix;
      await writeJson(stateFile, state);
    }
  }
  if (state.reuseIntent) {
    assertCurrentInputs();
    if (!reuse || taskGitIdentityHash(state.reuseContext) !== taskGitIdentityHash(reuse)
        || taskGitIdentityHash(identity) !== identityHash || state.next !== 0 || state.head !== baseCommit
        || !state.reuseIntent.merges?.length || state.reuseIntent.merges.length > tasks.length) {
      throw failure("Native prefix reuse intent changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    let before = baseCommit;
    for (const [i, step] of state.reuseIntent.merges.entries()) {
      if (step.taskId !== tasks[i].taskId || step.resultCommit !== tasks[i].resultCommit) {
        throw failure("Native prefix reuse no longer has ordinary authority", "RELEASE_NATIVE_CHECKOUT_CHANGED");
      }
      await verifyMergeStep(git, before, step.resultCommit, step.commit, { storedBinding: step.resolution?.binding ?? step.reviewedResolution?.binding, baseCommit });
      before = step.commit;
    }
    if (before !== state.reuseIntent.head || String(await git(["rev-parse", `${before}^{tree}`])) !== state.reuseIntent.tree) {
      throw failure("Native reused prefix tree changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    await requireClean(git);
    const observed = String(await git(["rev-parse", "HEAD^{commit}"]));
    if (![baseCommit, before].includes(observed)) throw failure("Native reused prefix checkout changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    if (observed !== before) await git(["checkout", "--detach", "--no-overwrite-ignore", before]);
    state.merges = state.reuseIntent.merges; state.next = state.merges.length; state.head = before;
    delete state.reuseIntent;
    await writeJson(stateFile, state);
  }
  if (state.version !== 1 || !Number.isInteger(state.next) || state.next < 0
      || state.next > tasks.length || state.merges?.length !== state.next) {
    throw failure("Native merge journal progress changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  // A private completed automatic merge can be amended for compatibility before
  // delivery. The issued checkout remains the owner input; earlier ordered
  // steps and delivered history are immutable. No review token is needed.
  const currentHead = String(await git(["rev-parse", "HEAD^{commit}"]));
  if (!state.merging && !state.conflict && state.next > 0 && currentHead !== state.head) {
    if (deliveredHead === state.head) {
      throw failure("Delivered native merge cannot be amended in its historical capture", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    const index = state.next - 1;
    const previous = index === 0 ? baseCommit : state.merges[index - 1].commit;
    await requireClean(git);
    const resolution = await verifyMergeStep(git, previous, tasks[index].resultCommit, currentHead, { ownedResolution: true, baseCommit });
    state.merges[index] = { taskId: tasks[index].taskId, resultCommit: tasks[index].resultCommit,
      commit: currentHead, resolved: true, resolution };
    state.head = currentHead;
    await writeJson(stateFile, state);
  }
  let prefix = baseCommit;
  const resolutions = [];
  for (const [index, step] of state.merges.entries()) {
    if (step.taskId !== tasks[index].taskId || step.resultCommit !== tasks[index].resultCommit) {
      throw failure("Native merge journal selection changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    const resolution = await verifyMergeStep(git, prefix, step.resultCommit, step.commit,
      { storedBinding: step.resolution?.binding ?? step.reviewedResolution?.binding, baseCommit });
    if (resolution) resolutions.push(resolution);
    prefix = step.commit;
  }
  if (prefix !== state.head) throw failure("Native merge journal prefix changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  while (state.next < tasks.length) {
    const task = tasks[state.next];
    if (state.merging && !state.conflict) {
      const head = String(await git(["rev-parse", "HEAD^{commit}"]));
      if (head !== state.head) {
        const parents = String(await git(["show", "-s", "--format=%P", head])).split(" ");
        if (parents.length !== 2 || parents[0] !== state.head || parents[1] !== task.resultCommit
            || await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]) !== null) {
          throw failure("Interrupted native merge has no exact automatic readback", "RELEASE_NATIVE_CHECKOUT_CHANGED");
        }
        await requireClean(git);
        const resolution = await verifyMergeStep(git, state.head, task.resultCommit, head, { baseCommit });
        if (resolution) resolutions.push(resolution);
        state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head,
          ...(resolution ? { resolved: true, resolution } : {}) });
        state.head = head;
        state.next += 1;
        state.merging = false;
        await writeJson(stateFile, state);
        continue;
      }
      const mergeHead = await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]);
      if (mergeHead) {
        if (mergeHead !== task.resultCommit) throw failure("Interrupted native merge side changed");
        const stages = await entries(git, ["ls-files", "--stage", "-z"]);
        const paths = [...new Set(stages.filter(([, entry]) => !entry.endsWith(" 0")).map(([file]) => file))];
        if (!paths.length) throw failure("Interrupted native merge lacks conflict stages");
        state.conflict = { paths, stages, automatic: stages.filter(([, entry]) => entry.endsWith(" 0")) };
        await writeJson(stateFile, state);
      }
    }
    if (state.conflict) {
      let head = String(await git(["rev-parse", "HEAD^{commit}"]));
      let choice = null;
      if (!choice && reuse && head === state.head) {
        let retained = state.conflict.retainedResolution;
        if (!retained && await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]) === task.resultCommit) {
          await requireUntouchedConflict(git, state.head, task.resultCommit, state.conflict);
          retained = await retainedNativeConflict({ root, repository, candidates, state, task, identity, gitAt, beforeTransport,
            verify: (before, result, target, step) => verifyMergeStep(git, before, result, target, { storedBinding: step?.resolution?.binding ?? step?.reviewedResolution?.binding, ownedResolution: true, baseCommit }) });
        }
        if (retained) {
          assertCurrentInputs();
          if (retained.identityHash !== identityHash || JSON.stringify(retained.parents) !== JSON.stringify([state.head, task.resultCommit])
              || retained.contextHash !== taskGitIdentityHash(state.conflict.stages.filter(([, entry]) => !entry.endsWith(" 0")))
              || String(await git(["rev-parse", `${retained.commit}^{tree}`])) !== retained.tree) {
            throw failure("Retained native conflict intent changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
          }
          await verifyMergeStep(git, state.head, task.resultCommit, retained.commit, { ownedResolution: true, baseCommit });
          state.conflict.retainedResolution = retained;
          await writeJson(stateFile, state);
          choice = { binding: retained, retained: true };
        }
      }
      if (head === state.head && choice) {
        assertCurrentInputs();
        const mergeHead = await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]);
        if (mergeHead === task.resultCommit) await requireUntouchedConflict(git, state.head, task.resultCommit, state.conflict);
        else if (mergeHead || !state.conflict.resolution && !state.conflict.reviewedResolution && !choice.retained) {
          throw failure("Native conflict operation changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
        } else await requireClean(git);
        const accepted = await verifyMergeStep(git, state.head, task.resultCommit, choice.binding.commit, { ownedResolution: true, baseCommit });
        // Retain the accepted boundary BEFORE abort/checkout, so either side of
        // a lost local response is read back through this same journal.
        state.conflict.resolution = accepted;
        await writeJson(stateFile, state);
        if (mergeHead) await git(["merge", "--abort"]);
        await requireClean(git);
        await git(["checkout", "--detach", "--no-overwrite-ignore", choice.binding.commit]);
        head = String(await git(["rev-parse", "HEAD^{commit}"]));
      }
      const parents = String(await git(["show", "-s", "--format=%P", head])).split(" ");
      if (head === state.head || await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]) !== null) {
        throw failure(`Resolve the native Git merge for Task ${task.taskId} in ${repository}`,
          "RELEASE_NATIVE_MERGE_CONFLICT", { conflictRoot: repository, conflicts: state.conflict.paths });
      }
      if (parents.length !== 2 || parents[0] !== state.head || parents[1] !== task.resultCommit) {
        throw failure("Native resolution has different merge parents", "RELEASE_NATIVE_CHECKOUT_CHANGED");
      }
      await requireClean(git);
      const resolution = await verifyMergeStep(git, state.head, task.resultCommit, head, { ownedResolution: true, baseCommit });
      if (resolution) resolutions.push(resolution);
      state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head, resolved: true,
        ...(resolution ? { resolution } : {}) });
      state.head = head;
      state.conflict = null;
      state.merging = false;
      state.next += 1;
      await writeJson(stateFile, state);
      continue;
    }
    await requireClean(git);
    if (String(await git(["rev-parse", "HEAD^{commit}"])) !== state.head) {
      throw failure("Native merge prefix changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    if (await maybe(git, ["merge-base", "--is-ancestor", task.resultCommit, state.head]) !== null) {
      state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: state.head, contained: true });
      state.next += 1;
      await writeJson(stateFile, state);
      continue;
    }
    try {
      state.merging = true;
      await writeJson(stateFile, state);
      await git(["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
        "-c", "core.hooksPath=", "-c", "rerere.enabled=false",
        "merge", "--no-ff", "--no-edit", "--no-overwrite-ignore", task.resultCommit]);
    } catch (error) {
      const stages = await entries(git, ["ls-files", "--stage", "-z"]);
      const paths = [...new Set(stages.filter(([, entry]) => !entry.endsWith(" 0")).map(([file]) => file))];
      if (!paths.length) throw error;
      state.conflict = { paths, stages, automatic: stages.filter(([, entry]) => entry.endsWith(" 0")) };
      await writeJson(stateFile, state);
      if (reuse && candidates.length) continue;
      throw failure(`Resolve the native Git merge for Task ${task.taskId} in ${repository}`,
        "RELEASE_NATIVE_MERGE_CONFLICT", { conflictRoot: repository, conflicts: paths });
    }
    const head = String(await git(["rev-parse", "HEAD^{commit}"]));
    const parents = String(await git(["show", "-s", "--format=%P", head])).split(" ");
    if (parents.length !== 2 || parents[0] !== state.head || parents[1] !== task.resultCommit) {
      throw failure("Native Git merge did not retain the exact selected parents");
    }
    await requireClean(git);
    state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head });
    state.head = head;
    state.merging = false;
    state.next += 1;
    await writeJson(stateFile, state);
  }
  await requireClean(git);
  if (String(await git(["rev-parse", "HEAD^{commit}"])) !== state.head) throw failure("Native final merge head changed");
  assertCurrentInputs();
  await measureTaskOperation("native:selected-content", () => assertSelectedContent({ git, baseCommit, tasks, head: state.head, resolutions, identity, merges:state.merges }));
  return { root: repository, head: state.head,
    tree: String(await git(["rev-parse", "HEAD^{tree}"])), merges: state.merges };
}
