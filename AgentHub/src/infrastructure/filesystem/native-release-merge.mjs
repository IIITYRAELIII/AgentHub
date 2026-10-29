import path from "node:path";
import { copyFile, mkdir, lstat, open, readFile, writeFile } from "node:fs/promises";
import { createSelectedGitBundle } from "./selected-git-bundle.mjs";
import { createHash } from "node:crypto";
import { taskGitIdentityHash } from "../../domain/task-git-reference.mjs";
import { normalizedNativeResolution } from "../../domain/native-resolution-input.mjs";
import { selectedCompositionFields, normalizedSelectedAbsorption, selectedAbsorptionHandoff }
  from "../../domain/task-selected-composition.mjs";
import { nativeReuseContext, nativeReuseCandidates, verifiedNativePrefix, retainedNativeConflict } from "./native-merge-reuse.mjs";
import { measureTaskOperation } from "../process/task-operation-timing.mjs";

// Internal Git sequencing of ReleaseGitWorkspaceService. This has no Task,
// publication or ref-promotion authority. The application retains those leases.
export const NATIVE_RELEASE_POLICY = "main-selected-git-merge-v1";

async function maybe(git, args) {
  try { return await git(args); } catch { return null; }
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

// Commit reachability proves history, not the continued presence of a Task's
// changes. Replaying its delta in Git objects is a check only: it never checks
// out, applies a patch, updates refs or changes the chosen candidate.
function contentCompatibilityReview(review) {
  if (!review) return null;
  let envelope;
  try { envelope = JSON.parse(/<native-merge-review>\s*([^]*?)\s*<\/native-merge-review>/u.exec(review.text)?.[1]); }
  catch { throw failure("Native compatibility review is malformed", "RELEASE_NATIVE_REVIEW_REQUIRED"); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw failure("Native compatibility review is malformed", "RELEASE_NATIVE_REVIEW_REQUIRED");
  }
  return Object.hasOwn(envelope, "selectedContentCompatibility") ? review : null;
}

async function assertSelectedContent({ git, baseCommit, tasks, head, resolutions, identity, merges }) {
  const targetTree = String(await git(["rev-parse", `${head}^{tree}`]));
  const target = new Map(await entries(git, ["ls-tree", "-r", "-z", targetTree]));
  const overrides = new Map();
  for (const { binding } of resolutions) {
    const automatic = new Map(await entries(git, ["ls-tree", "-r", "-z", binding.automaticTree]));
    const reviewed = new Map(await entries(git, ["ls-tree", "-r", "-z", binding.tree]));
    for (const file of new Set([...automatic.keys(), ...reviewed.keys()])) {
      if (automatic.get(file) !== reviewed.get(file) && target.get(file) === reviewed.get(file)) overrides.set(file, true);
    }
  }
  const obligations = [];
  for (const [index, task] of tasks.entries()) {
    if (String(await git(["rev-parse", `${task.resultCommit}^{tree}`])) === targetTree) continue;
    const replay = String(await git(["merge-tree", "--write-tree", "--name-only", "-z",
      `--merge-base=${task.baseCommit || baseCommit}`, head, task.resultCommit], { acceptableExitCodes: [1] })).split("\0");
    const replayTree = replay.shift();
    if (!/^[a-f0-9]{40}$/u.test(replayTree)) throw failure("Selected Task content replay is unavailable");
    const conflicts = new Set();
    for (const file of replay) { if (!file) break; conflicts.add(file); }
    const expected = new Map(await entries(git, ["ls-tree", "-r", "-z", replayTree]));
    const missing = [];
    for (const file of new Set([...expected.keys(), ...target.keys()])) {
      if (expected.get(file) === target.get(file) || overrides.has(file)) continue;
      if (!conflicts.has(file) || await changesCleanConflictContext(git, replayTree, head, file, head, task.resultCommit)) missing.push(file);
    }
    if (!missing.length) continue;
    const prefixCommit = index === 0 ? baseCommit : merges[index - 1].commit;
    const automaticTree = String(await git(["merge-tree", "--write-tree", "--name-only", "-z",
      prefixCommit, task.resultCommit], { acceptableExitCodes: [1] })).split("\0")[0];
    if (!/^[a-f0-9]{40}$/u.test(automaticTree)) throw failure("Native automatic context is unavailable");
    const automatic = new Map(await entries(git, ["ls-tree", "-r", "-z", automaticTree]));
    for (const file of missing.sort()) obligations.push({taskId:task.taskId,baseCommit:task.baseCommit || baseCommit,
      resultCommit:task.resultCommit,replayTree,path:file,expectedEntry:expected.get(file) ?? null,
      retainedEntry:target.get(file) ?? null,prefixCommit,automaticTree,automaticEntry:automatic.get(file) ?? null});
  }
  const binding = {kind:"selected-content-compatibility-v1",identityHash:taskGitIdentityHash(identity),
    selectedTasks:tasks.map(task=>({taskId:task.taskId,baseCommit:task.baseCommit || baseCommit,resultCommit:task.resultCommit})),
    candidateCommit:head,candidateTree:targetTree,obligations};
  const capabilities = resolutions.filter(resolution=>resolution.compatibilityReview);
  const accepted = new Set();
  if (capabilities.length) {
    if (capabilities.length !== 1) throw failure("Ambiguous selected-content compatibility authority", "RELEASE_NATIVE_REVIEW_REQUIRED");
    const capability = JSON.parse(/<native-merge-review>\s*([^]*?)\s*<\/native-merge-review>/u
      .exec(capabilities[0].compatibilityReview.text)[1]).selectedContentCompatibility;
    if (!capability || typeof capability !== "object" || Array.isArray(capability)
        || Object.keys(capability).sort().join(",") !== "acceptedObligations,binding"
        || !capability.binding || typeof capability.binding !== "object" || Array.isArray(capability.binding)
        || taskGitIdentityHash(capability.binding) !== taskGitIdentityHash(binding)
        || !Array.isArray(capability.acceptedObligations) || !capability.acceptedObligations.length) {
      throw failure("Selected-content compatibility binding changed", "RELEASE_NATIVE_REVIEW_REQUIRED");
    }
    for (const index of capability.acceptedObligations) {
      const obligation = obligations[index];
      if (!Number.isSafeInteger(index) || index < 0 || !obligation || accepted.has(index)
          || obligation.retainedEntry !== obligation.automaticEntry) {
        throw failure("Selected-content compatibility does not retain the exact automatic entry", "RELEASE_NATIVE_REVIEW_REQUIRED");
      }
      accepted.add(index);
    }
  }
  const remaining = obligations.filter((_,index)=>!accepted.has(index));
  if (remaining.length) {
    const first = remaining[0];
    throw failure(`Selected Task ${first.taskId} changes are missing from the candidate`, "RELEASE_SELECTED_CONTENT_MISSING",
      {taskId:first.taskId,resultCommit:first.resultCommit,candidateCommit:head,
        missingPaths:remaining.filter(row=>row.taskId===first.taskId).map(row=>row.path).sort(),
        selectedContentCompatibilityBinding:binding});
  }
}

// Reopen must prove completed native steps from Git objects, rather than trusting
// a mutable journal's next/head counters. Git identifies the actual conflict
// boundary; additional compatibility bytes require an exact independent review.
async function verifyMergeStep(git, before, result, target, { identity, review = null, verifyReview = null,
  evidenceRoot = null, storedBinding = null, compatibilityReview = null } = {}) {
  compatibilityReview ??= contentCompatibilityReview(review);
  review ??= compatibilityReview;
  const contained = await maybe(git, ["merge-base", "--is-ancestor", result, before]) !== null;
  if (contained) {
    if (compatibilityReview) throw failure("Contained merge has no compatibility review boundary", "RELEASE_NATIVE_REVIEW_REQUIRED");
    if (target !== before) throw failure("Contained native result changed the prefix");
    return;
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
  const resolved = new Map(await entries(git, ["ls-tree", "-r", "-z", `${target}^{tree}`]));
  const extraPaths = [];
  for (const file of new Set([...automatic.keys(), ...resolved.keys()])) {
    if (!conflicts.has(file) && automatic.get(file) !== resolved.get(file)) {
      extraPaths.push(file);
    }
  }
  for (const file of conflicts) {
    if (automatic.get(file) !== resolved.get(file)
        && await changesCleanConflictContext(git, automaticTree, target, file, before, result)) extraPaths.push(file);
  }
  if (extraPaths.length || review) {
    const tree = String(await git(["rev-parse", `${target}^{tree}`]));
    const diff = await git(["diff", "--binary", "--full-index", "--no-renames", automaticTree, tree], { rawOutput: true });
    const binding = { identityHash: taskGitIdentityHash(identity), parents: [before, result],
      commit: target, tree, automaticTree,
      diffSha256: createHash("sha256").update(diff).digest("hex") };
    if (storedBinding && taskGitIdentityHash(storedBinding) !== taskGitIdentityHash(binding)) {
      throw failure("Recorded native review binding changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    const diffFile = `resolution-diff-${binding.diffSha256}.patch`;
    const diffPath = evidenceRoot ? path.join(evidenceRoot, diffFile) : null;
    if (diffPath) {
      if (!storedBinding) {
        try { await writeFile(diffPath, diff, { flag: "wx" }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      const info = await lstat(diffPath);
      if (!info.isFile() || info.isSymbolicLink()
          || !Buffer.from(await readFile(diffPath)).equals(Buffer.from(diff))) {
        throw failure("Recorded native resolution diff changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
      }
    }
    if (!review || typeof verifyReview !== "function") {
      throw failure("Native compatibility correction requires exact independent review", "RELEASE_NATIVE_REVIEW_REQUIRED",
        { binding, diffPath, extraPaths: extraPaths.sort() });
    }
    await verifyReview(review, binding, identity);
    if (compatibilityReview && (compatibilityReview.requestId !== review.requestId || compatibilityReview.text !== review.text)) {
      await verifyReview(compatibilityReview, binding, identity);
    }
    return { review, binding, diffFile, ...(compatibilityReview ? {compatibilityReview} : {}) };
  }
  return null;
}

// Verify an already accepted native candidate without composing another one.
export async function assertNativePreparedComposition({ git, baseCommit, tasks, merges, head, tree,
  identity = { policy: NATIVE_RELEASE_POLICY, baseCommit, tasks }, verifyReview = null, historyAuthority = null }) {
  await assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority });
  if (!Array.isArray(merges) || merges.length !== tasks.length) throw failure("Prepared native selection changed");
  let prefix = baseCommit;
  const resolutions = [];
  for (const [index, step] of merges.entries()) {
    const task = tasks[index];
    if (step.taskId !== task.taskId || step.resultCommit !== task.resultCommit) {
      throw failure("Prepared native result evidence changed");
    }
    const resolution = await verifyMergeStep(git, prefix, step.resultCommit, step.commit,
      { identity, review: step.reviewedResolution?.review, verifyReview,
        storedBinding: step.reviewedResolution?.binding, compatibilityReview: step.reviewedResolution?.compatibilityReview });
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
  resolutionReview = null, verifyReview = null,
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
  let verifiedPrefix = null, verifiedPrefixCount = 0;
  if (reuse && state.reuseContext && taskGitIdentityHash(state.reuseContext) === taskGitIdentityHash(reuse)
      && state.next === 0 && !state.merging && !state.conflict && !state.reuseIntent) {
    const prefix = await verifiedNativePrefix({ root, repository, candidates, tasks, baseCommit, gitAt, beforeTransport,
      verify: (before, result, target) => verifyMergeStep(git, before, result, target, { identity }) });
    if (prefix) {
      verifiedPrefix = prefix;
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
      if (step.taskId !== tasks[i].taskId || step.resultCommit !== tasks[i].resultCommit
          || verifiedPrefix !== state.reuseIntent && await verifyMergeStep(git, before, step.resultCommit, step.commit, { identity })) {
        throw failure("Native prefix reuse no longer has ordinary authority", "RELEASE_NATIVE_CHECKOUT_CHANGED");
      }
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
    verifiedPrefixCount = state.next;
    delete state.reuseIntent;
    await writeJson(stateFile, state);
  }
  const input = resolutionReview == null ? null : normalizedNativeResolution(resolutionReview);
  const choices = [];
  if (input?.reviews) {
    // Authenticate before importing any supplied object. A bundle imports no
    // source configuration/hooks and cannot move the primary or selected refs.
    for (const review of input.reviews) {
      let binding;
      try { binding = JSON.parse(/<native-merge-review>\s*([^]*?)\s*<\/native-merge-review>/u.exec(review.text)?.[1]).binding; }
      catch { throw failure("Native resolution review is malformed", "RELEASE_NATIVE_REVIEW_REQUIRED"); }
      if (binding?.identityHash !== taskGitIdentityHash(identity)
          || !Array.isArray(binding.parents) || binding.parents.length !== 2
          || !tasks.some(task => task.resultCommit === binding.parents[1])
          || ![binding.commit, binding.tree, binding.automaticTree, ...binding.parents].every(c => /^[a-f0-9]{40}$/u.test(c))
          || !/^[a-f0-9]{64}$/u.test(binding.diffSha256)
          || choices.some(choice => choice.binding.parents[0] === binding.parents[0]
            && choice.binding.parents[1] === binding.parents[1]) || typeof verifyReview !== "function") {
        throw failure("Native resolution differs from the selected identity", "RELEASE_NATIVE_REVIEW_REQUIRED");
      }
      await verifyReview(review, binding, identity);
      choices.push({ review, binding });
    }
    const info = await lstat(input.bundlePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw failure("Native resolution bundle is not a regular file");
    }
    const same = (a, b) => a.isFile() && !a.isSymbolicLink()
      && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
    const verifyBundle = async (file, entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== info.size) {
        throw failure("Retained native resolution bundle changed");
      }
      const handle = await open(file, "r");
      try {
        if (!same(await handle.stat(), entry)) throw failure("Retained native resolution bundle changed");
        const hash = createHash("sha256");
        let length = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
          hash.update(chunk); length += chunk.length;
        }
        if (length !== entry.size || !same(await handle.stat(), entry) || !same(await lstat(file), entry)
            || hash.digest("hex") !== input.bundleSha256) {
          throw failure("Native resolution bundle digest changed");
        }
      } finally { await handle.close(); }
    };
    await verifyBundle(input.bundlePath, info);
    const bundle = path.join(root, `reviewed-${input.bundleSha256}.bundle`);
    try { await copyFile(input.bundlePath, bundle, 1); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await verifyBundle(bundle, await lstat(bundle));
    if (!same(await lstat(input.bundlePath), info)) throw failure("Native resolution bundle changed");
    await git(["fetch", "--no-tags", bundle, ...choices.map(choice => choice.binding.commit)]);
  }
  const reviewFor = (before, result, target) => input?.reviews
    ? choices.find(choice => choice.binding.parents[0] === before && choice.binding.parents[1] === result
      && (!target || choice.binding.commit === target))?.review ?? null : input;
  if (state.version !== 1 || !Number.isInteger(state.next) || state.next < 0
      || state.next > tasks.length || state.merges?.length !== state.next) {
    throw failure("Native merge journal progress changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  // A private completed automatic merge can be amended for compatibility before
  // delivery. Only the exact independently reviewed replacement of its last
  // step is admitted; all earlier ordered inputs remain immutable.
  const currentHead = String(await git(["rev-parse", "HEAD^{commit}"]));
  if (!state.merging && !state.conflict && state.next > 0 && currentHead !== state.head) {
    if (deliveredHead === state.head) {
      throw failure("Delivered native merge cannot be amended in its historical capture", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    const index = state.next - 1;
    const previous = index === 0 ? baseCommit : state.merges[index - 1].commit;
    await requireClean(git);
    const reviewedResolution = await verifyMergeStep(git, previous, tasks[index].resultCommit, currentHead,
      { identity, review: reviewFor(previous, tasks[index].resultCommit, currentHead), verifyReview, evidenceRoot: root });
    if (!reviewedResolution) throw failure("Native merge amendment lacks exact review", "RELEASE_NATIVE_REVIEW_REQUIRED");
    state.merges[index] = { taskId: tasks[index].taskId, resultCommit: tasks[index].resultCommit,
      commit: currentHead, resolved: true, reviewedResolution };
    state.head = currentHead;
    await writeJson(stateFile, state);
  }
  let prefix = baseCommit;
  const resolutions = [];
  const compatibilityUpdates = [];
  for (const [index, step] of state.merges.entries()) {
    if (step.taskId !== tasks[index].taskId || step.resultCommit !== tasks[index].resultCommit) {
      throw failure("Native merge journal selection changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    const incomingCompatibility = index === tasks.length - 1
      ? contentCompatibilityReview(reviewFor(prefix, step.resultCommit, step.commit)) : null;
    const storedCompatibility = step.reviewedResolution?.compatibilityReview
      ?? contentCompatibilityReview(step.reviewedResolution?.review);
    const changedCompatibility = incomingCompatibility
      && (!storedCompatibility || taskGitIdentityHash(incomingCompatibility) !== taskGitIdentityHash(storedCompatibility));
    if (changedCompatibility && deliveredHead) throw failure("Delivered native compatibility authority cannot change",
      "RELEASE_NATIVE_CHECKOUT_CHANGED");
    const compatibilityReview = incomingCompatibility ?? storedCompatibility;
    const resolution = index < verifiedPrefixCount && !compatibilityReview ? null : await verifyMergeStep(git, prefix, step.resultCommit, step.commit,
      { identity, review: step.reviewedResolution?.review ?? compatibilityReview, verifyReview, evidenceRoot: root,
        storedBinding: step.reviewedResolution?.binding, compatibilityReview });
    if (resolution) resolutions.push(resolution);
    if (changedCompatibility) compatibilityUpdates.push({index,resolution});
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
        const reviewedResolution = await verifyMergeStep(git, state.head, task.resultCommit, head,
          { identity, review: reviewFor(state.head, task.resultCommit, head), verifyReview, evidenceRoot: root });
        if (reviewedResolution) resolutions.push(reviewedResolution);
        state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head,
          ...(reviewedResolution ? { resolved: true, reviewedResolution } : {}) });
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
      let choice = choices.find(item => item.binding.parents[0] === state.head
        && item.binding.parents[1] === task.resultCommit);
      if (!choice && reuse && head === state.head) {
        let retained = state.conflict.retainedResolution;
        if (!retained && await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]) === task.resultCommit) {
          await requireUntouchedConflict(git, state.head, task.resultCommit, state.conflict);
          retained = await retainedNativeConflict({ root, repository, candidates, state, task, identity, gitAt, beforeTransport,
            verify: (before, result, target) => verifyMergeStep(git, before, result, target, { identity }) });
        }
        if (retained) {
          assertCurrentInputs();
          if (retained.identityHash !== identityHash || JSON.stringify(retained.parents) !== JSON.stringify([state.head, task.resultCommit])
              || retained.contextHash !== taskGitIdentityHash(state.conflict.stages.filter(([, entry]) => !entry.endsWith(" 0")))
              || String(await git(["rev-parse", `${retained.commit}^{tree}`])) !== retained.tree
              || await verifyMergeStep(git, state.head, task.resultCommit, retained.commit, { identity })) {
            throw failure("Retained native conflict intent changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
          }
          state.conflict.retainedResolution = retained;
          await writeJson(stateFile, state);
          choice = { binding: retained, review: null, retained: true };
        }
      }
      if (head === state.head && choice) {
        assertCurrentInputs();
        const mergeHead = await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]);
        if (mergeHead === task.resultCommit) await requireUntouchedConflict(git, state.head, task.resultCommit, state.conflict);
        else if (mergeHead || !state.conflict.reviewedResolution && !choice.retained) {
          throw failure("Native conflict operation changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
        } else await requireClean(git);
        const accepted = await verifyMergeStep(git, state.head, task.resultCommit, choice.binding.commit,
          { identity, review: choice.review, verifyReview, evidenceRoot: root });
        // Retain the accepted boundary BEFORE abort/checkout, so either side of
        // a lost local response is read back through this same journal.
        state.conflict.reviewedResolution = accepted;
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
      const reviewedResolution = await verifyMergeStep(git, state.head, task.resultCommit, head,
        { identity, review: reviewFor(state.head, task.resultCommit, head), verifyReview, evidenceRoot: root });
      if (reviewedResolution) resolutions.push(reviewedResolution);
      state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head, resolved: true,
        ...(reviewedResolution ? { reviewedResolution } : {}) });
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
    const choice = choices.find(item => item.binding.parents[0] === state.head
      && item.binding.parents[1] === task.resultCommit);
    if (choice) {
      const reviewedResolution = await verifyMergeStep(git, state.head, task.resultCommit, choice.binding.commit,
        { identity, review: choice.review, verifyReview, evidenceRoot: root });
      if (reviewedResolution) resolutions.push(reviewedResolution);
      // The existing intent/readback handles a lost checkout or journal reply.
      // Checkout retains Git's ignored/untracked collision protection.
      state.merging = true;
      await writeJson(stateFile, state);
      await git(["checkout", "--detach", "--no-overwrite-ignore", choice.binding.commit]);
      await requireClean(git);
      state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit,
        commit: choice.binding.commit, resolved: true, reviewedResolution });
      state.head = choice.binding.commit;
      state.next += 1;
      state.merging = false;
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
  // Preserve the original v1 review and add the separately authenticated exact
  // compatibility decision only after full replay validation, before delivery.
  if (compatibilityUpdates.length) {
    for (const {index,resolution} of compatibilityUpdates) state.merges[index].reviewedResolution = resolution;
    await writeJson(stateFile,state);
  }
  if (state.reuseTransportIntent) { delete state.reuseTransportIntent; await writeJson(stateFile, state); }
  return { root: repository, head: state.head,
    tree: String(await git(["rev-parse", "HEAD^{tree}"])), merges: state.merges };
}
