import { createHash } from "node:crypto";
import path from "node:path";
import { selectedCompositionFilePlan } from "./selected-composition-materializer.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_CONFLICTS = 16;
const MAX_OWN_COMMITS = 256;
const PUBLISHED_BINDINGS = ["taskId", "repositoryKey", "taskBaseCommit", "acceptedLocalMainCommit",
  "taskCommit", "devCommit", "proofCommit", "publishedCommit", "publicationGeneration", "remoteCommit", "bundleSha256"];

export function normalizePublishedResolution(value) {
  if (value == null) return null;
  const keys = ["version", "kind", ...PUBLISHED_BINDINGS, "resolutionCommit",
    "resolutionBundlePath", "resolutionBundleSha256", "resolutions"];
  if (typeof value !== "object" || Array.isArray(value) || value.version !== 1
      || value.kind !== "ordinary-published-resolution-v1"
      || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Selected published resolution has an unsupported identity");
  }
  const input = { version: 1, kind: value.kind };
  for (const key of PUBLISHED_BINDINGS) {
    input[key] = String(value[key] ?? "").trim();
    if (!input[key]) throw new Error(`Selected published resolution is missing ${key}`);
  }
  input.resolutionCommit = exact(value.resolutionCommit, "published resolution commit");
  const bundle = String(value.resolutionBundlePath ?? "").trim();
  input.resolutionBundlePath = bundle ? path.resolve(bundle) : "";
  input.resolutionBundleSha256 = String(value.resolutionBundleSha256 ?? "").trim().toLowerCase();
  if (!bundle || !/^[0-9a-f]{64}$/u.test(input.resolutionBundleSha256)
      || !Array.isArray(value.resolutions) || !value.resolutions.length
      || value.resolutions.length > MAX_CONFLICTS) {
    throw new Error("Selected published resolution bundle or conflict identity is incomplete");
  }
  input.resolutions = value.resolutions.map((entry) => {
    if (!entry || Object.keys(entry).some((key) => !["path", "mode", "blob"].includes(key))
        || typeof entry.path !== "string" || !entry.path || entry.path.includes("\0")
        || entry.mode !== "100644") {
      throw new Error("Selected published resolution conflict entry is unsupported");
    }
    return { path: entry.path, mode: entry.mode, blob: exact(entry.blob, "published resolution blob") };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(input.resolutions.map((entry) => entry.path)).size !== input.resolutions.length) {
    throw new Error("Selected published resolution has duplicate conflicts");
  }
  return input;
}

function exact(value, label) {
  const result = String(value ?? "").trim().toLowerCase();
  if (!SHA.test(result)) throw new Error(`Selected composition ${label} is not an exact Git identity`);
  return result;
}

function lines(value) {
  return String(value ?? "").split(/\r?\n/u).filter(Boolean);
}

async function gitLines(git, args) {
  return lines(await git(args));
}

async function onlyMergeBase(git, left, right, label) {
  const bases = await gitLines(git, ["merge-base", "--all", left, right]);
  if (bases.length !== 1 || !SHA.test(bases[0])) {
    throw new Error(`Selected composition ${label} has no unique common ancestor`);
  }
  return bases[0];
}

async function ancestor(git, left, right, label) {
  if (await onlyMergeBase(git, left, right, label) !== left) {
    throw new Error(`Selected composition ${label} ancestry changed`);
  }
}

async function mergeTree(git, left, right) {
  const output = String(await git(["merge-tree", "--write-tree", left, right], {
    acceptableExitCodes: [1],
  }));
  const [header = "", stageText = ""] = output.split(/\r?\n\r?\n/u, 2);
  const [tree, ...stageLines] = lines(header);
  if (!SHA.test(tree)) throw new Error("Selected composition merge-tree did not produce a tree");
  const conflicts = new Map();
  for (const line of stageLines) {
    const match = /^(\d{6}) ([0-9a-f]{40}) ([123])\t(.+)$/u.exec(line);
    if (!match) throw new Error("Selected composition has malformed conflict witnesses");
    const [, mode, blob, stage, name] = match;
    if (!name || mode !== "100644" || name.includes("\0") || conflicts.size > MAX_CONFLICTS) {
      throw new Error("Selected composition conflict shape is unsupported");
    }
    const entries = conflicts.get(name) ?? {};
    if (entries[stage]) throw new Error("Selected composition has duplicate conflict witnesses");
    entries[stage] = { mode, blob };
    conflicts.set(name, entries);
  }
  if (conflicts.size > MAX_CONFLICTS) throw new Error("Selected composition conflict bound exceeded");
  for (const entries of conflicts.values()) {
    if (!entries[1] || !entries[2] || !entries[3]) {
      throw new Error("Selected composition has incomplete conflict witnesses");
    }
  }
  return { tree, conflicts };
}

async function treeEntry(git, tree, name) {
  const output = String(await git(["ls-tree", "-z", tree, "--", name]));
  const match = /^(\d{6}) blob ([0-9a-f]{40})\t([^\0]+)\0$/u.exec(output);
  if (!match || match[3] !== name || match[1] !== "100644") {
    throw new Error(`Selected composition resolved entry is not a regular file: ${name}`);
  }
  return { mode: match[1], blob: match[2] };
}

async function rawPlan(git, left, right) {
  return selectedCompositionFilePlan(await git([
    "diff-tree", "--raw", "-r", "-z", "--no-renames", left, right,
  ]));
}

async function ordinaryOwnPlan(git, identity) {
  if (identity.taskBaseCommit !== identity.acceptedLocalMainCommit) {
    throw new Error("Ordinary selected composition requires its unchanged local main Task base");
  }
  const history = await gitLines(git, [
    "rev-list", `--max-count=${MAX_OWN_COMMITS + 1}`, "--parents",
    identity.taskCommit, `^${identity.taskBaseCommit}`,
  ]);
  if (!history.length || history.length > MAX_OWN_COMMITS) {
    throw new Error("Ordinary selected composition own history is empty or exceeds its bound");
  }
  for (let index = 0; index < history.length; index += 1) {
    const [commit, parent, ...other] = history[index].split(" ");
    const expectedParent = index + 1 < history.length
      ? history[index + 1].split(" ")[0] : identity.taskBaseCommit;
    if (!SHA.test(commit) || !SHA.test(parent) || other.length || parent !== expectedParent) {
      throw new Error("Ordinary selected composition contains a foreign or merged Task history");
    }
  }
  if (await onlyMergeBase(git, identity.devCommit, identity.taskCommit, "ordinary dev/Task")
      !== identity.taskBaseCommit) {
    throw new Error("Ordinary selected composition has partial or ambiguous Task integration");
  }
  const plan = await rawPlan(git, identity.taskBaseCommit, identity.taskCommit);
  if (!plan.length || plan.some((file) => /(^|\/)CHANGELOG\.md$/u.test(file.path))) {
    throw new Error("Ordinary selected composition has no own delta or changes release history");
  }
  return plan;
}

async function completeEntries(git, tree) {
  const rows = String(await git(["ls-tree", "-r", "-z", "--full-tree", tree])).split("\0").filter(Boolean);
  const result = new Map();
  for (const row of rows) {
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/u.exec(row);
    if (!match || result.has(match[4])) throw new Error("Selected published resolution has malformed tree entries");
    result.set(match[4], { mode: match[1], type: match[2], blob: match[3] });
  }
  return result;
}

async function verifyPublishedResolution(git, identity, ownPlan, merge, input) {
  for (const key of PUBLISHED_BINDINGS) {
    if (input[key] !== identity[key]) throw new Error(`Selected published resolution bound ${key} changed`);
  }
  const conflicts = [...merge.conflicts.keys()].filter((name) => !/(^|\/)CHANGELOG\.md$/u.test(name)).sort();
  if (!conflicts.length || JSON.stringify(conflicts) !== JSON.stringify(input.resolutions.map((entry) => entry.path))) {
    throw new Error("Selected published resolution does not name the exact actual conflicts");
  }
  await git(["cat-file", "-e", `${input.resolutionCommit}^{commit}`]);
  const parents = (await gitLines(git, ["rev-list", "--parents", "-n", "1", input.resolutionCommit]))[0]?.split(" ");
  if (parents?.length !== 2 || parents[0] !== input.resolutionCommit || parents[1] !== identity.publishedCommit) {
    throw new Error("Selected published resolution parents changed");
  }
  const resolutionTree = exact(await git(["rev-parse", `${input.resolutionCommit}^{tree}`]), "published resolution tree");
  const [published, automatic, resolved] = await Promise.all([
    completeEntries(git, identity.publishedCommit), completeEntries(git, merge.tree), completeEntries(git, resolutionTree),
  ]);
  const witnesses = [];
  for (const entry of input.resolutions) {
    const stages = merge.conflicts.get(entry.path);
    if (!ownPlan.some((file) => file.path === entry.path && file.kind === "M" && file.newBlob === stages[3].blob)) {
      throw new Error("Selected published resolution conflict is outside the exact own edit");
    }
    const actual = resolved.get(entry.path);
    if (actual?.type !== "blob" || actual.mode !== entry.mode || actual.blob !== entry.blob) {
      throw new Error("Selected published resolution blob differs from its reviewed conflict");
    }
    witnesses.push({ path: entry.path, stages, result: { mode: actual.mode, blob: actual.blob } });
  }
  const own = new Set(ownPlan.map((file) => file.path));
  const conflictNames = new Set(conflicts);
  for (const name of new Set([...published.keys(), ...automatic.keys(), ...resolved.keys()])) {
    if (conflictNames.has(name)) continue;
    const expected = own.has(name) ? automatic.get(name) : published.get(name);
    if (own.has(name) && (expected?.mode !== "100644" || expected.type !== "blob")) {
      throw new Error("Selected published resolution owning entry is not a regular file");
    }
    if (JSON.stringify(resolved.get(name) ?? null) !== JSON.stringify(expected ?? null)) {
      throw new Error(`Selected published resolution changes an unreviewed non-conflict or outside-own entry: ${name}`);
    }
  }
  const delta = await rawPlan(git, identity.publishedCommit, resolutionTree);
  if (delta.some((file) => !own.has(file.path))) throw new Error("Selected published resolution changes outside OWN");
  return { resolutionCommit: input.resolutionCommit, resolutionTree, publishedBaselineTree: merge.tree,
    conflictWitnesses: witnesses };
}

// The caller owns live Task/ref/publication/remote fences and runs this on an
// isolated object store. No review artifact is authority merely because it is
// importable: every parent, tree, conflict stage and non-conflict entry is
// recomputed from immutable objects here.
export async function verifySelectedCompositionObjects({
  git, taskId, repositoryKey, taskBaseCommit, acceptedLocalMainCommit,
  taskCommit, devCommit, proofCommit, publishedCommit, publicationGeneration,
  remoteCommit, bundleSha256, publishedResolutionInput = null,
} = {}) {
  if (typeof git !== "function") throw new Error("Selected composition Git reader is unavailable");
  const identity = {
    kind: "selected-task-composition-v1",
    taskId: String(taskId ?? "").trim(),
    repositoryKey: String(repositoryKey ?? "").trim(),
    taskBaseCommit: exact(taskBaseCommit, "Task base"),
    acceptedLocalMainCommit: exact(acceptedLocalMainCommit, "accepted local main"),
    taskCommit: exact(taskCommit, "Task result"),
    devCommit: exact(devCommit, "managed dev"),
    proofCommit: exact(proofCommit, "reviewed composition"),
    publishedCommit: exact(publishedCommit, "publication"),
    publicationGeneration: String(publicationGeneration ?? "").trim(),
    remoteCommit: exact(remoteCommit, "remote main"),
    bundleSha256: String(bundleSha256 ?? "").trim().toLowerCase(),
  };
  if (!identity.taskId || !identity.repositoryKey || !identity.publicationGeneration
      || !/^[0-9a-f]{64}$/u.test(identity.bundleSha256)
      || identity.remoteCommit !== identity.publishedCommit) {
    throw new Error("Selected composition publication, bundle or Task identity is incomplete");
  }
  for (const value of [identity.taskBaseCommit, identity.acceptedLocalMainCommit,
    identity.taskCommit, identity.devCommit, identity.proofCommit, identity.publishedCommit]) {
    await git(["cat-file", "-e", `${value}^{commit}`]);
  }
  await ancestor(git, identity.taskBaseCommit, identity.acceptedLocalMainCommit, "Task base/local main");
  await ancestor(git, identity.acceptedLocalMainCommit, identity.taskCommit, "local main/Task result");
  await ancestor(git, identity.acceptedLocalMainCommit, identity.devCommit, "local main/dev");
  const localPublishedCommonBase = await onlyMergeBase(
    git, identity.acceptedLocalMainCommit, identity.publishedCommit, "accepted main/publication",
  );
  const firstParentMerges = await gitLines(git, [
    "log", "--first-parent", "--merges", "--format=%H %P",
    identity.taskCommit, `^${identity.taskBaseCommit}`,
  ]);
  const ordinary = firstParentMerges.length === 0;
  const publishedInput = normalizePublishedResolution(publishedResolutionInput);
  if (publishedInput && !ordinary) throw new Error("Selected published resolution requires the ordinary own route");
  const ownPlan = ordinary ? await ordinaryOwnPlan(git, identity) : null;
  let taskMergeCommit = null;
  let taskMergeParents = [];
  let releaseParent = identity.taskBaseCommit;
  if (!ordinary) {
    if (localPublishedCommonBase === identity.acceptedLocalMainCommit
        || localPublishedCommonBase === identity.publishedCommit) {
      throw new Error("Selected composition is not the divergent published-main case");
    }
    if (firstParentMerges.length !== 1) {
      throw new Error("Selected composition requires one exact published-side Task merge");
    }
    const [mergeCommit, taskFirstParent, publishedSide, ...extraParents] = firstParentMerges[0].split(" ");
    taskMergeCommit = mergeCommit;
    taskMergeParents = [taskFirstParent, publishedSide];
    if (!SHA.test(taskMergeCommit) || !SHA.test(taskFirstParent) || !SHA.test(publishedSide)
        || extraParents.length) {
      throw new Error("Selected composition Task merge parent shape changed");
    }
    await ancestor(git, identity.taskBaseCommit, taskFirstParent, "Task first parent");
    await ancestor(git, publishedSide, identity.publishedCommit, "published merge side");
    if (await onlyMergeBase(git, publishedSide, identity.acceptedLocalMainCommit,
      "published side/local main") === publishedSide) {
      throw new Error("Selected composition published side is ordinary local ancestry");
    }
    releaseParent = await onlyMergeBase(git, identity.publishedCommit, identity.taskCommit,
      "published result/Task result");
    if (releaseParent !== publishedSide) {
      throw new Error("Selected composition release boundary is not its exact published Task side");
    }
  }
  const parents = (await gitLines(git, ["rev-list", "--parents", "-n", "1", identity.proofCommit]))[0]
    ?.split(" ") ?? [];
  if (parents.length !== 3 || parents[0] !== identity.proofCommit
      || parents[1] !== identity.devCommit || parents[2] !== identity.taskCommit) {
    throw new Error("Selected composition reviewed commit parents changed");
  }
  const proofTree = exact(await git(["rev-parse", `${identity.proofCommit}^{tree}`]), "reviewed tree");
  const devTree = exact(await git(["rev-parse", `${identity.devCommit}^{tree}`]), "dev tree");
  const taskTree = exact(await git(["rev-parse", `${identity.taskCommit}^{tree}`]), "Task tree");
  const { tree: baselineTree, conflicts } = await mergeTree(git, identity.devCommit, identity.taskCommit);
  if (!conflicts.size) throw new Error("Selected composition has no reviewed conflict to resolve");
  const resolved = [];
  for (const name of [...conflicts.keys()].sort()) {
    if (ordinary && !ownPlan.some((file) => file.path === name
        && file.kind === "M" && file.newBlob === conflicts.get(name)[3].blob)) {
      throw new Error("Ordinary selected composition conflict is outside the exact own edit");
    }
    resolved.push({ path: name, stages: conflicts.get(name), result: await treeEntry(git, proofTree, name) });
  }
  const changedFromBaseline = await rawPlan(git, baselineTree, proofTree);
  if (JSON.stringify(changedFromBaseline.map((file) => file.path).sort())
      !== JSON.stringify(resolved.map((item) => item.path))) {
    throw new Error("Selected composition changes an unreviewed non-conflict path");
  }
  for (const file of changedFromBaseline) {
    const entry = resolved.find((item) => item.path === file.path);
    if (file.kind !== "M" || file.newBlob !== entry.result.blob) {
      throw new Error("Selected composition resolved blob does not match its conflict witness");
    }
  }
  const worktreePlan = await rawPlan(git, devTree, proofTree);
  if (ordinary && worktreePlan.some((file) => !ownPlan.some((own) => own.path === file.path))) {
    throw new Error("Ordinary selected composition changes a path outside its own delta");
  }
  const selectedReleaseMerge = await mergeTree(git, identity.publishedCommit, identity.taskCommit);
  const releaseConflictPaths = [...selectedReleaseMerge.conflicts.keys()]
    .filter((name) => !/(^|\/)CHANGELOG\.md$/u.test(name)).sort();
  if (!ordinary && releaseConflictPaths.length) {
    throw new Error("Selected composition release projection conflicts outside CHANGELOG");
  }
  const publishedResolution = publishedInput
    ? await verifyPublishedResolution(git, identity, ownPlan, selectedReleaseMerge, publishedInput) : null;
  const proof = {
    ...identity, taskTree, devTree, proofTree, baselineTree,
    taskMergeCommit, taskMergeParents,
    localPublishedCommonBase, releaseParent,
    selectedReleaseTree: publishedResolution?.resolutionTree
      ?? (ordinary && releaseConflictPaths.length ? null : selectedReleaseMerge.tree),
    ...(publishedInput ? { publishedResolutionInput: publishedInput, publishedResolution } : {}),
    ...(ordinary ? { proofRoute: "ordinary-own-conflict-v1", ownPlan, releaseConflictPaths } : {}),
    conflictWitnesses: resolved, worktreePlan,
  };
  return { ...proof, proofHash: createHash("sha256").update(JSON.stringify(proof)).digest("hex") };
}
