import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createSelectedGitBundle, hasExactGitCommitObjects } from "./selected-git-bundle.mjs";
import { createHash } from "node:crypto";
import { sourceBlobs } from "./local-source-baseline.mjs";
import { canonicalPath } from "./config.mjs";
import { TaskBoardStore } from "../persistence/task-board-store.mjs";
import { selectedCompositionFields, normalizedSelectedAbsorption, selectedAbsorptionHandoff, nativeAbsorptionInputs }
  from "../../domain/task-selected-composition.mjs";
import { normalizedTaskId, taskGitIdentityHash, taskRepositoryKey } from "../../domain/task-git-reference.mjs";
import { nativeReuseContext, nativeReuseCandidates, verifiedNativePrefix, retainedNativeConflict } from "./native-merge-reuse.mjs";
import { measureTaskOperation } from "../process/task-operation-timing.mjs";
import { normalizedNativeResolutionReview, nativeResolutionReviewDeclaration } from "../../domain/native-resolution-input.mjs";

// Internal Git sequencing of TaskIntegrationGitService. This has no Task,
// publication or ref-promotion authority. The application retains those leases.
export const NATIVE_RELEASE_POLICY = "main-selected-git-merge-v1";
const ROOT_CHANGELOG = "CHANGELOG.md";

function ownsTaskMerge(identity) {
  return identity?.policy === NATIVE_RELEASE_POLICY || identity?.policy === "native-dev-merge-v1";
}

async function rootChangelogChanged(git, before, after) {
  return Boolean(String(await git(["diff", "--name-only", "--no-renames", "-z", before, after, "--", ROOT_CHANGELOG])));
}

// Read-only evidence for the one existing manual post-delivery owner. This is
// not acceptance: only a genuine independent inter-Stream receipt can accept it.
export async function createManualDevResolutionBinding({ git, root, identity, commit, taskId, originalJournalSha256 }) {
  if (identity?.policy !== "manual-main-dev-sync-v1" || !taskId || !/^[a-f0-9]{64}$/u.test(originalJournalSha256 ?? "")) {
    throw failure("Manual compatibility requires its exact original context", "RELEASE_NATIVE_REVIEW_REQUIRED");
  }
  const parents = String(await git(["show", "-s", "--format=%P", commit])).split(" ");
  if (JSON.stringify(parents) !== JSON.stringify([identity.devCommit, identity.publishedRevision])) {
    throw failure("Manual compatibility parents changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  const bases = nativeMergeBaseFields(await git(["merge-base", "--all", ...parents]));
  if (JSON.stringify(bases) !== JSON.stringify(Object.hasOwn(identity, "mergeBases")
    ? { mergeBases: identity.mergeBases } : { mergeBase: identity.mergeBase })) throw failure("Manual compatibility bases changed");
  const output = String(await git(["merge-tree", "--write-tree", "-z", ...parents], { acceptableExitCodes: [1] })).split("\0");
  const automaticTree = output.shift(), stages = [], conflicts = new Set();
  for (const row of output) {
    if (!row) break;
    const match = /^(\d{6}) ([a-f0-9]{40}) ([123])\t([^]*)$/u.exec(row);
    if (!match) throw failure("Manual compatibility conflict inventory unavailable");
    conflicts.add(match[4]); stages.push([match[4], `${match[1]} ${match[2]} ${match[3]}`]);
  }
  const automatic = new Map(await entries(git, ["ls-tree", "-r", "-z", automaticTree]));
  const tree = String(await git(["rev-parse", `${commit}^{tree}`]));
  const resolved = new Map(await entries(git, ["ls-tree", "-r", "-z", tree]));
  const inventory = [...automatic].filter(([file]) => !conflicts.has(file)).map(([file, entry]) => [file, `${entry.split(" ")[0]} ${entry.split(" ").at(-1)} 0`]);
  inventory.push(...stages);
  inventory.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) || Number(a[1].at(-1)) - Number(b[1].at(-1)));
  const changes = [...new Set([...automatic.keys(), ...resolved.keys()])].sort().filter(file => automatic.get(file) !== resolved.get(file))
    .map(file => ({ path: file, before: automatic.get(file) ?? null, after: resolved.get(file) ?? null }));
  const patch = await git(["diff", "--binary", "--full-index", "--no-renames", automaticTree, tree], { rawOutput: true });
  return { kind: "manual-dev-resolution-v1", taskId, workspaceId: identity.workspaceId,
    operationId: identity.operationId, identityHash: taskGitIdentityHash(identity),
    delivery: { revision: identity.manualDelivery?.revision, releaseId: identity.manualDelivery?.releaseId,
      manifestSha256: identity.manualDelivery?.manifestSha256 },
    nativeRoot: path.resolve(root), originalJournalSha256, issuedStagesSha256: taskGitIdentityHash(inventory),
    parents, ...bases, commit, tree, automaticTree, automaticInventorySha256: taskGitIdentityHash([...automatic]),
    conflictPaths: [...conflicts].sort(), changes,
    diffSha256: createHash("sha256").update(patch).digest("hex") };
}

async function verifyManualCompatibility({ git, root, identity, head, proof, verifyReview }) {
  if (!proof) return null;
  if (typeof verifyReview !== "function") throw failure("Manual compatibility receipt owner is unavailable", "RELEASE_NATIVE_REVIEW_REQUIRED");
  const review = normalizedNativeResolutionReview(proof.review);
  const binding = await createManualDevResolutionBinding({ git, root, identity, commit: head,
    taskId: proof.binding?.taskId, originalJournalSha256: proof.binding?.originalJournalSha256 });
  if (taskGitIdentityHash(binding) !== taskGitIdentityHash(proof.binding)) throw failure("Manual compatibility binding changed", "RELEASE_NATIVE_REVIEW_REQUIRED");
  await verifyReview(review, binding);
  return binding;
}

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
  if (!["published-main-dev-sync-v1", "manual-main-dev-sync-v1"].includes(identity.policy) || tasks.length !== 1
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

// A history proof reads each immutable metadata entry once, while every
// promotion boundary runs its own complete proof against fresh authority.
async function readNativeMetadataEntries(git, commit, files) {
  const entries = new Map();
  let batch = [];
  let length = 0;
  const read = async () => {
    if (!batch.length) return;
    const wanted = new Set(batch);
    const output = String(await git(["--literal-pathspecs", "ls-tree", "--full-tree", "-z", commit, "--", ...batch],
      { rawOutput: true }));
    if (output && !output.endsWith("\0")) throw failure("Native metadata lookup is malformed or ambiguous");
    for (const record of output.split("\0").slice(0, -1)) {
      const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]*)$/u.exec(record);
      if (!match || !wanted.delete(match[4])) throw failure("Native metadata lookup is malformed or ambiguous");
      entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
    }
    batch = [];
    length = 0;
  };
  for (const file of files) {
    if (length + file.length + 4 > 12000) await read();
    batch.push(file);
    length += file.length + 4;
  }
  await read();
  return entries;
}

function matchesMetadata(file, names) {
  // Literal root pathspecs cover descendants of a directory with that name.
  return names.some(name => file.startsWith(`${name}/`) || path.posix.basename(file) === name);
}

export function nativeIntegrationRecordFile(dataDir, taskId, repoRoot, operationId) {
  const operation = String(operationId ?? "").trim();
  if (!operation) throw new Error("Native Test requires its original lifecycle operation id");
  return path.join(dataDir, "task-native-integrations", normalizedTaskId(taskId),
    taskRepositoryKey(repoRoot), `${createHash("sha256").update(operation).digest("hex")}.json`);
}

async function returnedTestPublishedParent({ git, dataDir, prior, side, published, evidence }) {
  if (!dataDir || !/^[a-f0-9]{40}$/u.test(side)) return false;
  const file = nativeIntegrationRecordFile(dataDir, prior.taskId, prior.projectRoot, prior.testOperationId);
  const bytes = await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const record = bytes && JSON.parse(bytes);
  const metadata = record?.nativeHistoryAuthority?.publishedMetadata;
  if (record?.version !== 1 || record.kind !== "native-task-integration-v1" || record.phase === "failed"
      || record.operationId !== prior.testOperationId || record.snapshot?.taskId !== prior.taskId
      || record.snapshot?.headCommit !== prior.resultCommit
      || canonicalPath(record.snapshot?.repositoryRoot ?? "") !== canonicalPath(prior.projectRoot)
      || metadata?.commit !== side || !metadata.generation || !/^[a-f0-9]{64}$/u.test(metadata.recordHash ?? "")
      || canonicalPath(metadata.repositoryRoot ?? "") !== canonicalPath(prior.projectRoot)
      || await git(["rev-parse", `${side}^{tree}`]) !== metadata.tree) return false;
  if (await maybe(git, ["merge-base", "--is-ancestor", side, published]) === null) return false;
  const matchesReceipt = () => {
    const store = new TaskBoardStore({ databaseFile: path.join(dataDir, "journal.sqlite"), readOnly: true });
    try { return record.target === store.absorptionPriorTestDevCommit(prior); }
    finally { store.close(); }
  };
  if (!matchesReceipt()) return false;
  evidence?.push(async () => {
    if (await readFile(file, "utf8") !== bytes || !matchesReceipt()) {
      throw failure("Original absorbed Test evidence changed");
    }
  });
  return true;
}

// Historical Test receipts can authorize inherited release metadata. Ordinary
// merge parents have no such receipt and stay on the exact-commit path.
async function legacyPublishedMetadataBases({ git, task, taskBase, baseCommit, authority, contains, evidence }) {
  const published = authority?.publishedHistoryBase;
  if (!published || !authority.dataDir || !(task.selectedComposition || task.nativeAbsorptionInput || task.nativeAbsorptionHistory)) {
    return [];
  }
  const descriptor = selectedCompositionFields(task).selectedComposition ?? {
    absorptionInput: task.nativeAbsorptionInput, absorptionHistory: task.nativeAbsorptionHistory,
  };
  const commits = [];
  for (const absorbed of nativeAbsorptionInputs(descriptor)) {
    const binding = normalizedSelectedAbsorption(absorbed);
    const { declaration: source } = selectedAbsorptionHandoff({ requestId: binding.requestId, text: binding.text });
    const prior = binding.priorResults?.find(result => result.taskId === source.sourceTaskId);
    if (!prior || source.survivorTaskId !== task.taskId || source.baseCommit !== taskBase
        || !await contains(source.absorptionCommit, task.resultCommit)
        || String(await git(["show", "-s", "--format=%P", source.absorptionCommit]))
          !== source.survivorParentCommit + " " + source.sourceCommit) continue;
    const boundary = published === baseCommit ? [] : ["^" + published];
    const parents = String(await git(["rev-list", "--first-parent", "--parents",
      source.sourceCommit, "^" + baseCommit, ...boundary])).split(/\r?\n/u)
      .map(row => row.split(" ")).find(row => row.length === 3 && row[0] === prior.resultCommit);
    const side = parents?.[2];
    if (side && side !== published
        && await returnedTestPublishedParent({ git, dataDir: authority.dataDir, prior, side, published, evidence })) {
      commits.push(side);
    }
  }
  return commits;
}

export async function assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority = null, onVerified = null }) {
  const evidence = onVerified ? [] : null;
  const histories = [];
  const ancestry = new Map();
  const contains = async (ancestor, descendant) => {
    const key = JSON.stringify([ancestor, descendant]);
    if (!ancestry.has(key)) ancestry.set(key,
      await maybe(git, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null);
    return ancestry.get(key);
  };
  const requests = new Map();
  for (const task of tasks) {
    const taskBase = task.baseCommit || baseCommit;
    // Even an empty result needs its exact Git commit.
    if (taskBase !== baseCommit && !await contains(taskBase, baseCommit)
        || !await contains(taskBase, task.resultCommit)) {
      throw failure(`Task ${task.taskId} requires a main-based result or explicit historical migration`);
    }
    // Test and PreRelease integrate the entire selected commit. Task-to-Task
    // merges use regular Git parents and carry no separate workflow receipt.
    const adopted = (historyAuthority?.adoptions ?? []).filter(a => a.taskId === task.taskId
      && a.resultCommit === task.resultCommit);
    const changedMetadata = String(await git([
      "diff", "--name-only", "--no-renames", "-z", taskBase, task.resultCommit,
      "--", "CHANGELOG.md", ":(glob)**/CHANGELOG.md", "package.json", "package-lock.json",
      ":(glob)**/package.json", ":(glob)**/package-lock.json",
    ], { rawOutput: true })).split("\0").filter(Boolean);
    const notes = changedMetadata.filter(file => file !== ROOT_CHANGELOG && matchesMetadata(file, ["CHANGELOG.md"]));
    const packages = changedMetadata.filter(file => matchesMetadata(file, ["package.json", "package-lock.json"]));
    const legacyBases = notes.length || packages.length
      ? await legacyPublishedMetadataBases({ git, task, taskBase, baseCommit, authority: historyAuthority, contains, evidence })
      : [];
    const metadataBases = [...new Set([taskBase, ...(historyAuthority?.metadataBases ?? []),
      ...adopted.map(a => a.adoptedCommit), ...legacyBases])];
    histories.push({ task, metadataBases, notes, packages });
    if (notes.length || packages.length) {
      for (const commit of [task.resultCommit, ...metadataBases]) {
        if (!requests.has(commit)) requests.set(commit, new Set());
        for (const file of [...notes, ...packages]) requests.get(commit).add(file);
      }
    }
  }
  const metadata = new Map();
  for (const [commit, files] of requests) metadata.set(commit, await readNativeMetadataEntries(git, commit, files));
  const packageObjects = new Map();
  for (const { task, metadataBases, packages } of histories) {
    for (const commit of [task.resultCommit, ...metadataBases]) {
      for (const file of packages) {
        const entry = metadata.get(commit)?.get(file);
        if (entry?.type === "blob") packageObjects.set(entry.oid, entry);
      }
    }
  }
  const packageBytes = new Map();
  const requestedObjects = [...packageObjects.keys()];
  for (let offset = 0; offset < requestedObjects.length; offset += 32) {
    const batch = requestedObjects.slice(offset, offset + 32);
    for (const [oid, bytes] of await sourceBlobs(git, packageObjects, batch)) packageBytes.set(oid, bytes.toString("utf8").trim());
  }
  const packageAt = async (commit, file) => {
    const entry = metadata.get(commit)?.get(file);
    if (!entry) return null;
    if (entry.type !== "blob") return maybe(git, ["show", `${commit}:${file}`]);
    return packageBytes.get(entry.oid);
  };
  const changelogAt = (commit, file) => {
    const entry = metadata.get(commit)?.get(file);
    if (!entry) return null;
    if (entry.type !== "blob") throw failure("Native metadata lookup is malformed or ambiguous");
    return `${entry.mode} ${entry.oid}`;
  };
  for (const { task, metadataBases, notes, packages } of histories) {
    for (const file of notes) {
      const entry = changelogAt(task.resultCommit, file);
      const known = metadataBases.map(commit => changelogAt(commit, file));
      if (entry === null || !known.includes(entry)) throw failure(`Task ${task.taskId} changes release-owned CHANGELOG metadata`);
    }
    for (const file of packages) {
      const priors = [];
      for (const commit of metadataBases) priors.push(await packageAt(commit, file));
      if (priors.every(bytes => bytes === null)) continue; // New packages are Task content.
      const nextBytes = await packageAt(task.resultCommit, file);
      const next = nextBytes === null ? null : JSON.parse(nextBytes);
      if (!priors.filter(bytes => bytes !== null).map(bytes => JSON.parse(bytes)).some(prior =>
        (prior.version === undefined || prior.version === next?.version)
          && (prior.packages?.[""]?.version === undefined
            || prior.packages[""].version === next?.packages?.[""]?.version))) {
        throw failure(`Task ${task.taskId} changes release-owned package-version metadata: ${file}`);
      }
    }
  }
  if (evidence?.length) onVerified(async () => {
    for (const recheck of evidence) await recheck();
  });
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
    // An inline compatibility edit retains context on the same line. A
    // whole-line deletion, or the same words removed elsewhere in the file,
    // cannot provide evidence for losing this selected line.
    // An argument at a wrapped line's first/last position has only one such
    // boundary. It must still leave that line, rather than remove it entirely.
    if (!prefix && !suffix) return null;
    const retained = [...oldWords.slice(0, prefix), ...oldWords.slice(oldWords.length - suffix)];
    // Delimiters alone are not retained code: uniqueCall(); -> ; loses the
    // complete selected call even when another inline edit removed that call.
    if (!retained.some(word => /^[A-Za-z0-9_$]+$/u.test(word))) return null;
    const removed = oldWords.slice(prefix, oldWords.length - suffix);
    const added = newWords.slice(prefix, newWords.length - suffix);
    // A retained keyword such as return is no evidence for deleting its whole
    // call. A removed call expression must remain inside a retained outer
    // parenthesized expression (for example an optional nested argument).
    const enclosing = oldWords.slice(0, prefix).reduce((depth, word) =>
      depth + (word === "(" ? 1 : word === ")" ? -1 : 0), 0);
    if (removed.includes("(") && enclosing <= 0) return null;
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
  if (!publication) return { publishedBase: null, publication, commonBases: [] };
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
  // A repeated Test can already contain the exact selected result. Its unique
  // base is then that result, but only the same sealed publication inside it
  // supplies the replay boundary; the full own delta still has to survive.
  // Other histories, including multiple bases, keep their existing policy.
  const mergeBase = String(await git(["merge-base", "--all", baseCommit, task.resultCommit]));
  const commonBases = mergeBase.split(/\r?\n/u);
  if (mergeBase !== publication.commit && (mergeBase !== task.resultCommit
      || await maybe(git, ["merge-base", "--is-ancestor", publication.commit, task.resultCommit]) === null)) {
    return { publishedBase: null, publication, commonBases };
  }
  if (await maybe(git, ["merge-base", "--is-ancestor", task.baseCommit || baseCommit, publication.commit]) === null) {
    throw failure("Native Test published content base is outside its agreed history", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  return { publishedBase: publication.commit, publication, commonBases };
}

// A replay can reinsert a complete block already present in the composition.
// Treat only byte-identical additions as idempotent; deletion, replacement,
// binary and mode changes still need their actual native merge evidence.
async function repeatsRetainedContent(git, head, replayTree, file) {
  const patch = String(await git(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
    "--no-renames", "--no-color", "--unified=0", head, replayTree, "--", file], { rawOutput: true }));
  if (/^(?:old mode|new mode|deleted file|new file|Binary files)/mu.test(patch)) return false;
  const rawBody = await git(["show", `${head}:${file}`], { rawOutput: true });
  const body = String(rawBody);
  let block = null, additions = 0, removed = false;
  const retained = () => block !== null && block.length > 0 && body.includes(block.join("\n") + "\n");
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      if (block !== null && !retained()) return false;
      block = []; additions += 1;
    } else if (block !== null) {
      if (line.startsWith("+")) block.push(line.slice(1));
      else if (line.startsWith("-")) {
        removed = true;
        if (line.slice(1).trim() !== "") return false;
      } else if (line.startsWith("\\")) return false;
    }
  }
  if (additions > 0 && retained()) return true;
  if (additions !== 1 || removed) return false;
  // Git can slide an insertion across an identical method header. Prove one
  // literal insertion against the complete bytes, rather than its hunk layout.
  const current = Buffer.from(rawBody);
  const replay = Buffer.from(await git(["show", `${replayTree}:${file}`], { rawOutput: true }));
  if (replay.length <= current.length || current.includes(0) || replay.includes(0)
      || !Buffer.from(body).equals(current) || !Buffer.from(String(replay)).equals(replay)) return false;
  const currentEntry = await metadataEntry(git, head, file);
  const replayEntry = await metadataEntry(git, replayTree, file);
  if (!/^100(?:644|755) [a-f0-9]{40}$/u.test(currentEntry ?? "")
      || currentEntry.split(" ")[0] !== replayEntry?.split(" ")[0]) return false;
  let suffix = 0;
  while (suffix < current.length && current[current.length - 1 - suffix] === replay[replay.length - 1 - suffix]) suffix++;
  const offset = current.length - suffix;
  const insertion = replay.subarray(offset, offset + replay.length - current.length);
  return current.includes(insertion)
    && Buffer.concat([current.subarray(0, offset), insertion, current.subarray(offset)]).equals(replay);
}

// A later selected automatic edit can change a file whose earlier owned
// resolution already proved its combined content. Re-prove that content at
// every subsequent native step; an ancestor or an old path stamp is not proof.
async function retainsOrderedResolution({ git, baseCommit, merges, resolutions, head, file }) {
  const prior = resolutions.findLast(item => item.conflictPaths.includes(file));
  if (!prior) return false;
  const index = merges.findIndex(step => step.commit === prior.commit
    && step.resultCommit === prior.binding.parents[1]);
  if (index < 0 || index === merges.length - 1) return false;
  const entry = async revision => new Map(await entries(git,
    ["--literal-pathspecs", "ls-tree", "--full-tree", "-z", revision, "--", file])).get(file);
  let retained = prior.commit;
  let before = await entry(retained);
  for (const step of merges.slice(index + 1)) {
    const after = await entry(step.commit);
    if (after !== before) {
      // New credit is confined to the exact clean automatic text entry. A
      // changed mode/type, binary payload or unbound resolution keeps refusal.
      if (!/^100(?:644|755) blob [a-f0-9]{40}$/u.test(before ?? "")
          || before.split(" ")[0] !== after?.split(" ")[0]) return false;
      const actual = resolutions.find(item => item.commit === step.commit
        && item.binding.parents[0] === retained && item.binding.parents[1] === step.resultCommit);
      if (!actual || actual.conflictPaths.includes(file)
          || await entry(actual.binding.automaticTree) !== after) return false;
      const delta = String(await git(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
        "--numstat", retained, step.commit, "--", file], { rawOutput: true }));
      if (/^-\t-\t/mu.test(delta)) return false;
      const replay = String(await git(["merge-tree", "--write-tree", "--name-only", "-z",
        `--merge-base=${baseCommit}`, step.commit, retained], { acceptableExitCodes: [1] })).split("\0");
      const replayTree = replay.shift();
      if (!/^[a-f0-9]{40}$/u.test(replayTree)) return false;
      const boundary = replay.indexOf("");
      if (replay.slice(0, boundary < 0 ? replay.length : boundary).includes(file)) return false;
      if (await entry(replayTree) !== after
          && !await repeatsRetainedContent(git, step.commit, replayTree, file)) return false;
    }
    retained = step.commit;
    before = after;
  }
  return retained === head;
}

// Reachability alone does not prove content. Reproduce each selected delta, but
// retain the actual automatic context and verified conflict resolutions instead
// of requiring a message to authorize that same Git evidence.
async function assertSelectedContent({ git, baseCommit, tasks, head, tree, resolutions, identity, merges,
  manualCompatibilityReview = null, verifyManualReview = null, root = null }) {
  const compatibility = await verifyManualCompatibility({ git, root, identity, head,
    proof: manualCompatibilityReview, verifyReview: verifyManualReview });
  const virtualReplay = await publishedVirtualReplay({ git, identity, baseCommit, tasks });
  // Read the same immutable base set once within this fresh content proof.
  const { publishedBase, publication, commonBases } = await publishedTaskReplayBase({ git, baseCommit, tasks, identity });
  let inheritedPublication = commonBases.includes(publication?.commit);
  if (publication && !inheritedPublication && commonBases.length) {
    // Dependency tips can replace the publication itself as the real common
    // bases. Only all of those exact tips containing the same sealed publication
    // extend the existing automatic-absence proof, never the replay boundary.
    inheritedPublication = true;
    for (const commonBase of commonBases) {
      if (await maybe(git, ["merge-base", "--is-ancestor", publication.commit, commonBase]) === null) {
        inheritedPublication = false;
        break;
      }
    }
  }
  const inherited = publication
    && inheritedPublication
    && (publishedBase !== null
      || await maybe(git, ["merge-base", "--is-ancestor", tasks[0].baseCommit || baseCommit, publication.commit]) !== null)
    ? new Map(await entries(git, ["ls-tree", "-r", "-z", publication.commit])) : new Map();
  const capturedComposition = identity.policy === NATIVE_RELEASE_POLICY && identity.baseCommit === baseCommit
    && Array.isArray(identity.tasks) && taskGitIdentityHash(identity.tasks) === taskGitIdentityHash(tasks);
  const treeEntries = new Map();
  const inventory = async tree => {
    if (!treeEntries.has(tree)) treeEntries.set(tree, new Map(await entries(git, ["ls-tree", "-r", "-z", tree])));
    return treeEntries.get(tree);
  };
  const target = await inventory(tree);
  const resolvedPaths = new Set();
  for (const { binding, conflictPaths } of resolutions) {
    const resolved = await inventory(binding.tree);
    for (const file of conflictPaths) {
      if (target.get(file) === resolved.get(file)) resolvedPaths.add(file);
    }
  }
  for (const [index, task] of tasks.entries()) {
    let replayBase = publishedBase || task.baseCommit || baseCommit;
    // The captured composition already owns its complete baseline tree. If
    // that exact baseline lies inside this selected history, replay only the
    // remaining delta rather than reinserting inherited code at an old site.
    // No remote/ref lookup or path exemption supplies this ancestry evidence;
    // ordinary Test's separately bound published base keeps its own policy.
    if (capturedComposition && !publishedBase && replayBase !== baseCommit
        && await maybe(git, ["merge-base", "--is-ancestor", replayBase, baseCommit]) !== null
        && await maybe(git, ["merge-base", "--is-ancestor", baseCommit, task.resultCommit]) !== null) {
      replayBase = baseCommit;
    }
    const replayBefore = virtualReplay ? baseCommit : head;
    const replay = String(await git(["merge-tree", "--write-tree", "--name-only", "-z",
      ...(virtualReplay ? [] : [`--merge-base=${replayBase}`]),
      replayBefore, task.resultCommit], { acceptableExitCodes: [1] })).split("\0");
    const replayTree = replay.shift();
    if (!/^[a-f0-9]{40}$/u.test(replayTree)) throw failure("Selected Task content replay is unavailable");
    // An exact complete tree proves the whole replay directly. The automatic
    // inventories and conflict context are needed only to explain differences.
    if (replayTree === tree) continue;
    const prefix = index === 0 ? baseCommit : merges[index - 1].commit;
    const merged = await maybe(git, ["merge-base", "--is-ancestor", task.resultCommit, prefix]) === null;
    // A resolution verified within this same invocation already carries the
    // independently computed automatic tree of these exact parents.
    const verified = resolutions.find(item => item.commit === merges[index]?.commit
      && item.binding.parents[0] === prefix && item.binding.parents[1] === task.resultCommit);
    const actualTree = !merged ? null : verified?.binding.automaticTree
      ?? (String(await git(["merge-tree", "--write-tree", "--name-only", "-z", prefix, task.resultCommit],
        { acceptableExitCodes: [1] })).split("\0"))[0];
    const actual = actualTree === null ? new Map() : await inventory(actualTree);
    const source = inherited.size
      ? new Map(await entries(git, ["ls-tree", "-r", "-z", task.resultCommit])) : new Map();
    const conflicts = new Set();
    for (const file of replay) { if (!file) break; conflicts.add(file); }
    const expected = await inventory(replayTree);
    const missing = [];
    for (const file of new Set([...expected.keys(), ...target.keys()])) {
      if (file === ROOT_CHANGELOG && ownsTaskMerge(identity)) continue;
      if (expected.get(file) === target.get(file) || resolvedPaths.has(file)
          || actual.get(file) === target.get(file) && actual.has(file)) continue;
      // Only the complete independently authenticated candidate can account for
      // its exact reviewed before/after delta. No path-name exemption survives a
      // different tree, identity, receipt or additional unreviewed change.
      if (compatibility && compatibility.changes.some(change => change.path === file
          && change.before === (expected.get(file) ?? null) && change.after === (target.get(file) ?? null))) continue;
      // Absence is automatic evidence only for a whole unchanged published
      // entry. Own earlier/new edits and an already-contained result cannot
      // acquire deletion credit from an empty or unrelated automatic map.
      if (merged && !actual.has(file) && !target.has(file)
          && inherited.has(file) && source.get(file) === inherited.get(file)) continue;
      if (capturedComposition && await retainsOrderedResolution({ git, baseCommit, merges, resolutions, head, file })) {
        resolvedPaths.add(file);
        continue;
      }
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
async function verifyMergeStep(git, before, result, target, {
  storedBinding = null, ownedResolution = false, baseCommit = null, keepChangelog = false,
} = {}) {
  if (await maybe(git, ["merge-base", "--is-ancestor", result, before]) !== null) {
    if (target !== before) throw failure("Contained native result changed the prefix");
    return null;
  }
  if (String(await git(["show", "-s", "--format=%P", target])) !== `${before} ${result}`) {
    throw failure("Completed native merge parents changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  if (keepChangelog && await rootChangelogChanged(git, before, target)) {
    throw failure("Task merge changed the destination CHANGELOG", "RELEASE_SELECTED_CONTENT_MISSING",
      { candidateCommit: target, missingPaths: [ROOT_CHANGELOG] });
  }
  const output = String(await git(["merge-tree", "--write-tree", "--name-only", "-z", before, result],
    { acceptableExitCodes: [1] })).split("\0");
  const automaticTree = output.shift();
  if (!/^[a-f0-9]{40}$/u.test(automaticTree)) throw failure("Native automatic tree unavailable");
  const conflicts = new Set();
  for (const file of output) { if (!file) break; conflicts.add(file); }
  if (keepChangelog) conflicts.delete(ROOT_CHANGELOG);
  const tree = String(await git(["rev-parse", `${target}^{tree}`]));
  const extraPaths = [];
  let diff = Buffer.alloc(0);
  if (automaticTree !== tree) {
    const automatic = new Map(await entries(git, ["ls-tree", "-r", "-z", automaticTree]));
    const resolved = new Map(await entries(git, ["ls-tree", "-r", "-z", tree]));
    for (const file of new Set([...automatic.keys(), ...resolved.keys()])) {
      if (keepChangelog && file === ROOT_CHANGELOG) continue;
      if (automatic.get(file) === resolved.get(file)) continue;
      if (!conflicts.has(file)
          || await changesCleanConflictContext(git, automaticTree, target, file, before, result)) extraPaths.push(file);
    }
    diff = await git(["diff", "--binary", "--full-index", "--no-renames", automaticTree, tree], { rawOutput: true });
  }
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

// Shared native graph proof. Storage preservation uses this proof;
// current result and historical Task certification add selected content below.
export async function assertNativeMergeGraph({ git, baseCommit, tasks, merges, head, tree,
  identity }) {
  if (!Array.isArray(merges) || merges.length !== tasks.length) throw failure("Prepared native selection changed");
  let prefix = baseCommit;
  const resolutions = [];
  for (const [index, step] of merges.entries()) {
    const task = tasks[index];
    if (step.taskId !== task.taskId || step.resultCommit !== task.resultCommit) {
      throw failure("Prepared native result evidence changed");
    }
    const resolution = await verifyMergeStep(git, prefix, step.resultCommit, step.commit,
      { storedBinding: step.resolution?.binding ?? step.reviewedResolution?.binding, baseCommit,
        keepChangelog: ownsTaskMerge(identity) && step.keptChangelog === true });
    if (resolution) resolutions.push(resolution);
    prefix = step.commit;
  }
  if (prefix !== head || String(await git(["rev-parse", `${head}^{tree}`])) !== tree) {
    throw failure("Prepared native head or tree changed");
  }
  return resolutions;
}

export async function assertNativeMergedResults({ git, baseCommit, tasks, merges, head, tree,
  identity, manualCompatibilityReview = null, verifyManualReview = null, root = null }) {
  const resolutions = await assertNativeMergeGraph({ git, baseCommit, tasks, merges, head, tree, identity });
  await assertSelectedContent({ git, baseCommit, tasks, head, tree, resolutions, identity, merges,
    manualCompatibilityReview, verifyManualReview, root });
}

const nativeCommitConfig = ["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
  "-c", "core.hooksPath=", "-c", "rerere.enabled=false"];

async function pendingMergeConflict(git, result, { keepChangelog = false, mergeError = null } = {}) {
  const mergeHead = await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]);
  if (!mergeHead) {
    if (mergeError) throw mergeError;
    return null;
  }
  if (mergeHead !== result) throw failure("Interrupted native merge side changed");
  let ignoredConflict = false;
  if (keepChangelog) {
    const changes = String(await git(["diff", "--cached", "--name-only", "--no-renames", "-z", "--", ROOT_CHANGELOG]));
    if (changes.split("\0").includes(ROOT_CHANGELOG)) {
      if (mergeError) ignoredConflict = Boolean(String(await git(["ls-files", "--unmerged", "--", ROOT_CHANGELOG])));
      await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ROOT_CHANGELOG]);
    }
  }
  const stages = await entries(git, ["ls-files", "--stage", "-z"]);
  const paths = [...new Set(stages.filter(([, entry]) => !entry.endsWith(" 0")).map(([file]) => file))];
  if (paths.length) return { paths, stages, automatic: stages.filter(([, entry]) => entry.endsWith(" 0")) };
  if (mergeError && !ignoredConflict) throw mergeError;
  if (!keepChangelog) throw failure("Interrupted native merge lacks conflict stages");
  await git([...nativeCommitConfig, "commit", "--no-edit"]);
  return null;
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
  readAcceptedPrefix = null,
  deferEmptyPrefixDiscovery = false,
  provisionNativeObjects = null, verifyNativeObjects = null,
  nativeResolutionReview = null, verifyManualReview = null,
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
  let candidates;
  const readCandidates = async () => candidates ??= await nativeReuseCandidates({ root, identity,
    context: reuse, readLegacyBinding: readLegacyReuseBinding });
  if (!deferEmptyPrefixDiscovery && !readAcceptedPrefix) await readCandidates();
  let state = await readJson(stateFile);
  if (nativeResolutionReview && (!state || identity.policy !== "manual-main-dev-sync-v1")) {
    throw failure("Native compatibility requires an issued manual capture", "RELEASE_NATIVE_REVIEW_REQUIRED");
  }
  if (state && JSON.stringify(state.identity) !== JSON.stringify(identity)) {
    throw failure("Native merge staging identity changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  }
  if (provisionNativeObjects !== null) {
    const devStorage = identity.policy === "native-dev-merge-v1"
      && identity.objectStorage?.kind === "owned-immutable-git-objects-v1";
    const releaseStorage = identity.policy === NATIVE_RELEASE_POLICY && !identity.objectStorage;
    if ((!devStorage && !releaseStorage) || typeof provisionNativeObjects !== "function") {
      throw failure("Native object storage authority differs from capture");
    }
    if (!state) {
      state = { version: 1, identity, next: 0, head: baseCommit, merges: [], conflict: null, provisioningObjects: true,
        ...(ownsTaskMerge(identity) ? { keepTaskChangelog: true } : {}),
        ...(reuse ? { reuseContext: reuse } : {}) };
      await writeJson(stateFile, state); // Original intake BEFORE pool/consumer effects.
    }
    if (state.provisioningObjects) {
      assertCurrentInputs();
      state.objectStorage = await provisionNativeObjects({ repository, sourceRoot,
        inputs: [...new Set([baseCommit, ...tasks.map(task => task.resultCommit)])], identityHash });
      assertCurrentInputs();
      const inputs = [...new Set([baseCommit, ...tasks.map(task => task.resultCommit)])];
      if (!await hasExactGitCommitObjects((args, options) => gitAt(repository, args, options), inputs)) {
        throw failure("Native Git consumer is missing an exact input commit");
      }
      await gitAt(repository, ["checkout", "--detach", "--no-overwrite-ignore", baseCommit]);
      delete state.provisioningObjects;
      await writeJson(stateFile, state);
    }
  } else if (identity.objectStorage || state?.provisioningObjects) {
    throw failure("Native object storage capture requires its original provisioner");
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
    const git = (args, options) => gitAt(repository, args, options);
    if (!await hasExactGitCommitObjects(git, inputs)) {
      throw failure("Native Git checkout is missing an exact input commit");
    }
    await git(["checkout", "--detach", "--no-overwrite-ignore", baseCommit]);
    state = { version: 1, identity, next: 0, head: baseCommit, merges: [], conflict: null,
      ...(ownsTaskMerge(identity) ? { keepTaskChangelog: true } : {}),
      ...(reuse ? { reuseContext: reuse } : {}) };
    await writeJson(stateFile, state);
  }
  if (state.objectStorage && typeof verifyNativeObjects === "function") {
    await verifyNativeObjects({ repository, identityHash, storage: state.objectStorage,
      inputs: [...new Set([baseCommit, ...tasks.map(task => task.resultCommit)])] });
  }
  const git = (args, options) => gitAt(repository, args, options);
  const keepChangelog = state.keepTaskChangelog === true && ownsTaskMerge(identity);
  const verifyStep = (before, result, target, options = {}) => verifyMergeStep(git, before, result, target,
    { baseCommit, keepChangelog, ...options });
  // Proof is input to this existing journal, never to its immutable business
  // identity. Reopen must carry and reauthenticate it even when no new argument
  // is supplied. A caller cannot erase a stored review by omitting the field.
  if (nativeResolutionReview || state.manualCompatibilityReview) {
    const incoming = nativeResolutionReview && normalizedNativeResolutionReview(nativeResolutionReview);
    const prior = state.manualCompatibilityReview;
    if (prior && incoming && taskGitIdentityHash(prior.review) !== taskGitIdentityHash(incoming)) {
      throw failure("Stored manual compatibility review changed", "RELEASE_NATIVE_REVIEW_REQUIRED");
    }
    const review = incoming ?? prior.review;
    const declared = nativeResolutionReviewDeclaration(review).binding;
    const proof = prior ?? { review, binding: declared };
    if (!prior) {
      const issued = state.next === 0 && state.conflict && state.merging;
      const prepared = state.next === 1 && state.merges?.length === 1 && !state.conflict && !state.merging
        && state.merges[0].resolved === true && state.merges[0].commit === state.head;
      if (deliveredHead || state.delivery || !issued && !prepared
          || createHash("sha256").update(await readFile(stateFile)).digest("hex") !== declared.originalJournalSha256
          || issued && taskGitIdentityHash(state.conflict.stages) !== declared.issuedStagesSha256) {
        throw failure("Manual compatibility original capture changed", "RELEASE_NATIVE_REVIEW_REQUIRED");
      }
    }
    const head = String(await git(["rev-parse", "HEAD^{commit}"]));
    await verifyManualCompatibility({ git, root, identity, head, proof, verifyReview: verifyManualReview });
    if (!prior) { state.manualCompatibilityReview = proof; await writeJson(stateFile, state); }
  }
  const beforeTransport = async binding => {
    assertCurrentInputs();
    state.reuseTransportIntent = { identityHash, ...binding };
    await writeJson(stateFile, state);
    assertCurrentInputs();
  };

  let currentPrefixProof = null;
  let adoptedPrefixProof = null;
  if ((!deferEmptyPrefixDiscovery || deliveredHead) && reuse && state.reuseContext && taskGitIdentityHash(state.reuseContext) === taskGitIdentityHash(reuse)
      && state.next === 0 && !state.merging && !state.conflict && !state.reuseIntent) {
    const accepted = await readAcceptedPrefix?.();
    if (accepted) {
      await beforeTransport({ sourceIdentityHash: accepted.sourceIdentityHash,
        sourceJournalHash: accepted.sourceJournalHash, commit: accepted.head });
      const ownedInputs = [...new Set([baseCommit, ...accepted.merges.map(step => step.resultCommit)])];
      // Fresh staging is detached and has no refs advertising these objects.
      // Tell Git exactly which already-provisioned inputs it can omit.
      await git(["-c", "fetch.unpackLimit=1", "fetch", "--no-tags", "--no-write-fetch-head",
        ...ownedInputs.map(input => `--negotiation-tip=${input}`), sourceRoot, accepted.head]);
    }
    const prefix = accepted ?? await verifiedNativePrefix({ root, repository, candidates: await readCandidates(), tasks, baseCommit, gitAt, beforeTransport,
      verify: (before, result, target, step) => verifyStep(before, result, target,
        { storedBinding: step?.resolution?.binding ?? step?.reviewedResolution?.binding }) });
    if (prefix) {
      currentPrefixProof = { hash: taskGitIdentityHash(prefix), resolutions: prefix.merges.map(step => step.resolution ?? null) };
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
    const fresh = currentPrefixProof?.hash === taskGitIdentityHash(state.reuseIntent) ? currentPrefixProof : null;
    const { before, resolutions } = await measureTaskOperation("native:prefix-recheck", async () => {
      let before = baseCommit;
      const resolutions = [];
      for (const [i, step] of state.reuseIntent.merges.entries()) {
        if (step.taskId !== tasks[i].taskId || step.resultCommit !== tasks[i].resultCommit) {
          throw failure("Native prefix reuse no longer has ordinary authority", "RELEASE_NATIVE_CHECKOUT_CHANGED");
        }
        // Only the live verifier just above can supply this proof. Reopening
        // a persisted intent recomputes all its Git evidence before checkout.
        resolutions.push(fresh ? fresh.resolutions[i] : await verifyStep(before, step.resultCommit, step.commit,
          { storedBinding: step.resolution?.binding ?? step.reviewedResolution?.binding }));
        before = step.commit;
      }
      return { before, resolutions };
    });
    if (before !== state.reuseIntent.head || String(await git(["rev-parse", `${before}^{tree}`])) !== state.reuseIntent.tree) {
      throw failure("Native reused prefix tree changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    await requireClean(git);
    const observed = String(await git(["rev-parse", "HEAD^{commit}"]));
    if (![baseCommit, before].includes(observed)) throw failure("Native reused prefix checkout changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    if (observed !== before) await git(["checkout", "--detach", "--no-overwrite-ignore", before]);
    state.merges = keepChangelog
      ? state.reuseIntent.merges.map(step => ({ ...step, keptChangelog: true }))
      : state.reuseIntent.merges;
    state.next = state.merges.length; state.head = before;
    adoptedPrefixProof = { mergesHash: taskGitIdentityHash(state.merges), resolutions };
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
    const resolution = await verifyStep(previous, tasks[index].resultCommit, currentHead, { ownedResolution: true });
    state.merges[index] = { taskId: tasks[index].taskId, resultCommit: tasks[index].resultCommit,
      commit: currentHead, resolved: true, resolution, ...(keepChangelog ? { keptChangelog: true } : {}) };
    state.head = currentHead;
    await writeJson(stateFile, state);
  }
  let prefix = baseCommit;
  const resolutions = [];
  const adopted = adoptedPrefixProof?.mergesHash === taskGitIdentityHash(state.merges) ? adoptedPrefixProof : null;
  for (const [index, step] of state.merges.entries()) {
    if (step.taskId !== tasks[index].taskId || step.resultCommit !== tasks[index].resultCommit) {
      throw failure("Native merge journal selection changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    const resolution = adopted ? adopted.resolutions[index] : await verifyStep(prefix, step.resultCommit, step.commit,
      { storedBinding: step.resolution?.binding ?? step.reviewedResolution?.binding,
        keepChangelog: keepChangelog || ownsTaskMerge(identity) && step.keptChangelog === true });
    if (resolution) resolutions.push(resolution);
    prefix = step.commit;
  }
  if (prefix !== state.head) throw failure("Native merge journal prefix changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  while (state.next < tasks.length) {
    const task = tasks[state.next];
    if (state.merging && !state.conflict) {
      let head = String(await git(["rev-parse", "HEAD^{commit}"]));
      if (head === state.head) {
        state.conflict = await pendingMergeConflict(git, task.resultCommit, { keepChangelog });
        if (state.conflict) await writeJson(stateFile, state);
        else head = String(await git(["rev-parse", "HEAD^{commit}"]));
      }
      if (head !== state.head) {
        const parents = String(await git(["show", "-s", "--format=%P", head])).split(" ");
        if (parents.length !== 2 || parents[0] !== state.head || parents[1] !== task.resultCommit
            || await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]) !== null) {
          throw failure("Interrupted native merge has no exact automatic readback", "RELEASE_NATIVE_CHECKOUT_CHANGED");
        }
        await requireClean(git);
        const resolution = await verifyStep(state.head, task.resultCommit, head);
        if (resolution) resolutions.push(resolution);
        state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head,
          ...(resolution ? { resolved: true, resolution } : {}), ...(keepChangelog ? { keptChangelog: true } : {}) });
        state.head = head;
        state.next += 1;
        state.merging = false;
        await writeJson(stateFile, state);
        continue;
      }
    }
    if (state.conflict) {
      let head = String(await git(["rev-parse", "HEAD^{commit}"]));
      let choice = null;
      if (!choice && reuse && head === state.head) {
        let retained = state.conflict.retainedResolution;
        if (!retained && await maybe(git, ["rev-parse", "--verify", "MERGE_HEAD"]) === task.resultCommit) {
          await requireUntouchedConflict(git, state.head, task.resultCommit, state.conflict);
          retained = await retainedNativeConflict({ root, repository, candidates: await readCandidates(), state, task, identity, gitAt, beforeTransport,
            preservedRootPath: keepChangelog ? ROOT_CHANGELOG : null,
            verify: (before, result, target, step) => verifyStep(before, result, target,
              { storedBinding: step?.resolution?.binding ?? step?.reviewedResolution?.binding, ownedResolution: true }) });
        }
        if (retained) {
          assertCurrentInputs();
          if (retained.identityHash !== identityHash || JSON.stringify(retained.parents) !== JSON.stringify([state.head, task.resultCommit])
              || retained.contextHash !== taskGitIdentityHash(state.conflict.stages.filter(([, entry]) => !entry.endsWith(" 0")))
              || String(await git(["rev-parse", `${retained.commit}^{tree}`])) !== retained.tree) {
            throw failure("Retained native conflict intent changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
          }
          await verifyStep(state.head, task.resultCommit, retained.commit, { ownedResolution: true });
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
        const accepted = await verifyStep(state.head, task.resultCommit, choice.binding.commit, { ownedResolution: true });
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
      const resolution = await verifyStep(state.head, task.resultCommit, head, { ownedResolution: true });
      if (resolution) resolutions.push(resolution);
      state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head, resolved: true,
        ...(resolution ? { resolution } : {}), ...(keepChangelog ? { keptChangelog: true } : {}) });
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
    state.merging = true;
    await writeJson(stateFile, state);
    const conflict = await measureTaskOperation("native:merge", async () => {
      const stopBeforeCommit = keepChangelog && await rootChangelogChanged(git, state.head, task.resultCommit);
      try {
        await git([...nativeCommitConfig, "merge", "--no-ff", "--no-edit", "--no-overwrite-ignore",
          ...(stopBeforeCommit ? ["--no-commit"] : []), task.resultCommit]);
      } catch (error) {
        if (error.processTreeStopped === false) throw error;
        return pendingMergeConflict(git, task.resultCommit, { keepChangelog, mergeError: error });
      }
      return stopBeforeCommit ? pendingMergeConflict(git, task.resultCommit, { keepChangelog }) : null;
    });
    if (conflict) {
      state.conflict = conflict;
      await writeJson(stateFile, state);
      if (reuse && (await readCandidates()).length) continue;
      throw failure(`Resolve the native Git merge for Task ${task.taskId} in ${repository}`,
        "RELEASE_NATIVE_MERGE_CONFLICT", { conflictRoot: repository, conflicts: conflict.paths });
    }
    const head = String(await git(["rev-parse", "HEAD^{commit}"]));
    const parents = String(await git(["show", "-s", "--format=%P", head])).split(" ");
    if (parents.length !== 2 || parents[0] !== state.head || parents[1] !== task.resultCommit) {
      throw failure("Native Git merge did not retain the exact selected parents");
    }
    await requireClean(git);
    state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head,
      ...(keepChangelog ? { keptChangelog: true } : {}) });
    state.head = head;
    state.merging = false;
    state.next += 1;
    await writeJson(stateFile, state);
  }
  await requireClean(git);
  if (String(await git(["rev-parse", "HEAD^{commit}"])) !== state.head) throw failure("Native final merge head changed");
  assertCurrentInputs();
  const tree = String(await git(["rev-parse", `${state.head}^{tree}`]));
  await measureTaskOperation("native:selected-content", () => assertSelectedContent({ git, baseCommit, tasks,
    head: state.head, tree, resolutions, identity, merges: state.merges,
    manualCompatibilityReview: state.manualCompatibilityReview ?? null, verifyManualReview, root }));
  return { root: repository, head: state.head, tree, merges: state.merges };
}
