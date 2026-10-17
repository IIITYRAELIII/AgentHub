import path from "node:path";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { taskGitIdentityHash } from "../../domain/task-git-reference.mjs";
import { selectedCompositionFields, normalizedSelectedAbsorption, selectedAbsorptionHandoff }
  from "../../domain/task-selected-composition.mjs";

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
    if (await maybe(git, ["merge-base", "--is-ancestor", taskBase, baseCommit]) === null
        || await maybe(git, ["merge-base", "--is-ancestor", taskBase, task.resultCommit]) === null) {
      throw failure(`Task ${task.taskId} requires a main-based result or explicit historical migration`);
    }
    const rows = String(await git([
      "rev-list", "--first-parent", "--parents", "--max-count=513", task.resultCommit, ...bases.map(b => `^${b}`),
    ])).split(/\r?\n/u).filter(Boolean).map((row) => row.split(" "));
    if (rows.length > 512) throw failure(`Task ${task.taskId} history exceeds the native merge bound`);
    for (const [commit] of rows) owned.add(commit);
    histories.push({ task, rows });
    const adopted = (historyAuthority?.adoptions ?? []).filter(a => a.taskId === task.taskId
      && a.resultCommit === task.resultCommit);
    const metadataBases = [...new Set([taskBase, ...(historyAuthority?.metadataBases ?? []),
      ...adopted.map(a => a.adoptedCommit)])];
    const metadata = String(await git([
      "diff", "--name-only", "--no-renames", "-z", taskBase, task.resultCommit,
      "--", "CHANGELOG.md", ":(glob)**/CHANGELOG.md",
    ], { rawOutput: true }));
    for (const file of metadata.split("\0").filter(Boolean)) {
      const entry = await metadataEntry(git, task.resultCommit, file);
      const known = [];
      for (const b of metadataBases) known.push(await metadataEntry(git, b, file));
      if (entry === null || !known.includes(entry)) throw failure(`Task ${task.taskId} changes release-owned CHANGELOG metadata`);
    }
    const packages = String(await git(["diff", "--name-only", "--no-renames", "-z", taskBase, task.resultCommit,
      "--", "package.json", "package-lock.json", ":(glob)**/package.json", ":(glob)**/package-lock.json",
    ], { rawOutput: true })).split("\0").filter(Boolean);
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
      const sourceRows = String(await git(["rev-list", "--first-parent", "--parents", "--max-count=513",
        d.sourceCommit, `^${baseCommit}`])).split(/\r?\n/u).filter(Boolean).map(row => row.split(" "));
      if (sourceRows.length > 512 || sourceRows.some(row => row.length !== 2)
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

// Reopen must prove completed native steps from Git objects, rather than trusting
// a mutable journal's next/head counters. Git identifies the actual conflict
// boundary; additional compatibility bytes require an exact independent review.
async function verifyMergeStep(git, before, result, target, { identity, review = null, verifyReview = null,
  evidenceRoot = null, storedBinding = null } = {}) {
  const contained = await maybe(git, ["merge-base", "--is-ancestor", result, before]) !== null;
  if (contained) {
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
    return { review, binding, diffFile };
  }
  return null;
}

// Verify an already accepted native candidate without composing another one.
export async function assertNativePreparedComposition({ git, baseCommit, tasks, merges, head, tree,
  identity = { policy: NATIVE_RELEASE_POLICY, baseCommit, tasks }, verifyReview = null, historyAuthority = null }) {
  await assertNativeTaskHistories({ git, baseCommit, tasks, historyAuthority });
  if (!Array.isArray(merges) || merges.length !== tasks.length) throw failure("Prepared native selection changed");
  let prefix = baseCommit;
  for (const [index, step] of merges.entries()) {
    const task = tasks[index];
    if (step.taskId !== task.taskId || step.resultCommit !== task.resultCommit) {
      throw failure("Prepared native result evidence changed");
    }
    await verifyMergeStep(git, prefix, step.resultCommit, step.commit,
      { identity, review: step.reviewedResolution?.review, verifyReview,
        storedBinding: step.reviewedResolution?.binding });
    prefix = step.commit;
  }
  if (prefix !== head || String(await git(["rev-parse", `${head}^{tree}`])) !== tree) {
    throw failure("Prepared native head or tree changed");
  }
}

// Every accepted step is a real Git merge commit (or an already-contained
// result). A conflict leaves Git's MERGE_HEAD/index in this private checkout.
// An executor resolves it with ordinary git add/commit; continuation checks the
// exact ordered parents and preserves all previously automatic clean entries.
export async function mergeSelectedResults({
  root, sourceRoot, baseCommit, tasks, identity, gitAt, readJson, writeJson,
  resolutionReview = null, verifyReview = null,
  deliveredHead = null,
}) {
  const repository = path.join(root, "repository");
  const stateFile = path.join(root, "merge.json");
  await mkdir(root, { recursive: true });
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
    // Include its ancestry explicitly; stdin avoids a platform argv-size limit.
    await gitAt(sourceRoot, ["bundle", "create", bundle, "--all", "--stdin"], {
      input: `${inputs.join("\n")}\n`,
    });
    await gitAt(root, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", bundle, repository]);
    const git = (args) => gitAt(repository, args);
    for (const commit of inputs) {
      await git(["cat-file", "-e", `${commit}^{commit}`]);
    }
    await git(["checkout", "--detach", "--no-overwrite-ignore", baseCommit]);
    state = { version: 1, identity, next: 0, head: baseCommit, merges: [], conflict: null };
    await writeJson(stateFile, state);
  }
  const git = (args, options) => gitAt(repository, args, options);
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
      { identity, review: resolutionReview, verifyReview, evidenceRoot: root });
    if (!reviewedResolution) throw failure("Native merge amendment lacks exact review", "RELEASE_NATIVE_REVIEW_REQUIRED");
    state.merges[index] = { taskId: tasks[index].taskId, resultCommit: tasks[index].resultCommit,
      commit: currentHead, resolved: true, reviewedResolution };
    state.head = currentHead;
    await writeJson(stateFile, state);
  }
  let prefix = baseCommit;
  for (const [index, step] of state.merges.entries()) {
    if (step.taskId !== tasks[index].taskId || step.resultCommit !== tasks[index].resultCommit) {
      throw failure("Native merge journal selection changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
    }
    await verifyMergeStep(git, prefix, step.resultCommit, step.commit,
      { identity, review: step.reviewedResolution?.review, verifyReview, evidenceRoot: root,
        storedBinding: step.reviewedResolution?.binding });
    prefix = step.commit;
  }
  if (prefix !== state.head) throw failure("Native merge journal prefix changed", "RELEASE_NATIVE_CHECKOUT_CHANGED");
  while (state.next < tasks.length) {
    const task = tasks[state.next];
    if (state.merging && !state.conflict) {
      const head = String(await git(["rev-parse", "HEAD^{commit}"]));
      if (head !== state.head) {
        const parents = String(await git(["show", "-s", "--format=%P", head])).split(" ");
        const automatic = await maybe(git, ["merge-tree", "--write-tree", state.head, task.resultCommit]);
        if (parents.length !== 2 || parents[0] !== state.head || parents[1] !== task.resultCommit
            || !automatic || automatic.split(/\r?\n/u)[0] !== String(await git(["rev-parse", `${head}^{tree}`]))) {
          throw failure("Interrupted native merge has no exact automatic readback", "RELEASE_NATIVE_CHECKOUT_CHANGED");
        }
        await requireClean(git);
        state.merges.push({ taskId: task.taskId, resultCommit: task.resultCommit, commit: head });
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
      const head = String(await git(["rev-parse", "HEAD^{commit}"]));
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
        { identity, review: resolutionReview, verifyReview, evidenceRoot: root });
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
  return { root: repository, head: state.head,
    tree: String(await git(["rev-parse", "HEAD^{tree}"])), merges: state.merges };
}
