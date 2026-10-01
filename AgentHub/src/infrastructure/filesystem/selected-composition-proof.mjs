import { createHash } from "node:crypto";
import { selectedCompositionFilePlan } from "./selected-composition-materializer.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_CONFLICTS = 16;

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

// The caller owns live Task/ref/publication/remote fences and runs this on an
// isolated object store. No review artifact is authority merely because it is
// importable: every parent, tree, conflict stage and non-conflict entry is
// recomputed from immutable objects here.
export async function verifySelectedCompositionObjects({
  git, taskId, repositoryKey, taskBaseCommit, acceptedLocalMainCommit,
  taskCommit, devCommit, proofCommit, publishedCommit, publicationGeneration,
  remoteCommit, bundleSha256,
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
  if (localPublishedCommonBase === identity.acceptedLocalMainCommit
      || localPublishedCommonBase === identity.publishedCommit) {
    throw new Error("Selected composition is not the divergent published-main case");
  }
  const firstParentMerges = await gitLines(git, [
    "log", "--first-parent", "--merges", "--format=%H %P",
    identity.taskCommit, `^${identity.taskBaseCommit}`,
  ]);
  if (firstParentMerges.length !== 1) {
    throw new Error("Selected composition requires one exact published-side Task merge");
  }
  const [taskMergeCommit, taskFirstParent, publishedSide, ...extraParents] = firstParentMerges[0].split(" ");
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
  const releaseParent = await onlyMergeBase(git, identity.publishedCommit, identity.taskCommit,
    "published result/Task result");
  if (releaseParent !== publishedSide) {
    throw new Error("Selected composition release boundary is not its exact published Task side");
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
  const selectedReleaseMerge = await mergeTree(git, identity.publishedCommit, identity.taskCommit);
  if ([...selectedReleaseMerge.conflicts.keys()].some((name) => !/(^|\/)CHANGELOG\.md$/u.test(name))) {
    throw new Error("Selected composition release projection conflicts outside CHANGELOG");
  }
  const proof = {
    ...identity, taskTree, devTree, proofTree, baselineTree,
    taskMergeCommit, taskMergeParents: [taskFirstParent, publishedSide],
    localPublishedCommonBase, releaseParent, selectedReleaseTree: selectedReleaseMerge.tree,
    conflictWitnesses: resolved, worktreePlan,
  };
  return { ...proof, proofHash: createHash("sha256").update(JSON.stringify(proof)).digest("hex") };
}
