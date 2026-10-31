import path from "node:path";
import { mergeSelectedResults } from "./native-release-merge.mjs";

function unknown(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: "PUBLISHED_DEV_SYNC_UNKNOWN" });
}

// The existing native merge journal is also the delivery intent. No Task result,
// publication receipt or second approval ledger is created by this owner.
export async function synchronizePublishedDev({ root, sourceRoot, devRoot, devBranch, identity,
  gitAt, readJson, writeJson, fence, resolutionReview, verifyReview, beforeDelivery, afterDelivery }) {
  const git = (args, options) => gitAt(devRoot, args, options);
  const file = path.join(root, "merge.json");
  const previous = await readJson(file);
  const delivery = previous?.delivery;
  const inspect = async (target = null) => {
    const head = await git(["rev-parse", "HEAD^{commit}"]);
    const ref = await git(["rev-parse", `refs/heads/${devBranch}^{commit}`]);
    const branch = await git(["symbolic-ref", "-q", "HEAD"], { acceptableExitCodes: [1] });
    if (![identity.devCommit, target].filter(Boolean).includes(head)
        || ![identity.devCommit, target].filter(Boolean).includes(ref)
        || (branch !== `refs/heads/${devBranch}` && !(branch === "" && target && head === target))
        || (ref === target && head !== target)
        || await git(["write-tree"]) !== await git(["rev-parse", `${head}^{tree}`])
        || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
      throw unknown("Published dev synchronization has changed head, branch, index or worktree; foreign state retained");
    }
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      const found = await git(["rev-parse", "-q", "--verify", name], { acceptableExitCodes: [1] });
      if (found) throw unknown("Published dev synchronization preserves an unfinished Git operation");
    }
    return { head, ref, branch };
  };
  await fence();
  await inspect(delivery?.commit);
  const composition = await mergeSelectedResults({ root, sourceRoot, baseCommit: identity.devCommit,
    tasks: [{ taskId: `published:${identity.operationId}`, baseCommit: identity.mergeBase,
      resultCommit: identity.publishedRevision }], identity, gitAt, readJson, writeJson,
    requireConflictReview: true, resolutionReview, verifyReview,
    deliveredHead: delivery?.commit ?? null });
  if (delivery && (delivery.commit !== composition.head || delivery.tree !== composition.tree)) {
    throw unknown("Published dev synchronization delivered binding changed");
  }
  await fence();
  await inspect(delivery?.commit);
  if (!delivery) {
    const state = await readJson(file);
    state.delivery = { commit: composition.head, tree: composition.tree };
    await writeJson(file, state); // BEFORE import, checkout or ref CAS
  }
  await beforeDelivery();
  await git(["fetch", "--no-tags", "--no-write-fetch-head", composition.root, composition.head]);
  await fence();
  let state = await inspect(composition.head);
  try {
    if (state.head !== composition.head) {
      await git(["checkout", "--detach", "--no-overwrite-ignore", composition.head]);
    }
    await fence();
    state = await inspect(composition.head);
    if (state.ref !== composition.head) {
      await git(["update-ref", `refs/heads/${devBranch}`, composition.head, identity.devCommit]);
    }
    await fence();
    await git(["symbolic-ref", "HEAD", `refs/heads/${devBranch}`]);
    await fence();
    state = await inspect(composition.head);
    if (state.head !== composition.head || state.ref !== composition.head
        || state.branch !== `refs/heads/${devBranch}`) throw new Error("Published dev synchronization readback differs");
  } catch (cause) {
    // No abort/reset after a possibly applied effect. Same original journal
    // reads back either complete owned checkpoint; partial/foreign stays UNKNOWN.
    throw unknown("Published dev synchronization requires original effect readback", cause);
  }
  await afterDelivery();
  return { status: delivery ? "already_synchronized" : "synchronized", integrated: true,
    repositoryRoot: sourceRoot, projectRoot: devRoot, branch: devBranch,
    devHeadBefore: identity.devCommit, mainCommit: identity.publishedRevision,
    headCommit: composition.head, tree: composition.tree, nativeRoot: composition.root };
}
