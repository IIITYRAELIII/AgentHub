import {
  exactCrLfToLfNormalization,
  LF_NORMALIZATION_ALREADY_PRESENT,
  normalizedTaskSquashTransfer,
} from "../../domain/task-squash-transfer.mjs";

const PATHS = [".", ":(exclude,glob)**/CHANGELOG.md", ":(exclude)CHANGELOG.md"];
const MAX_ANCESTRY = 512;

function compareIntegrations(left, right) {
  return left.order - right.order || left.commit.localeCompare(right.commit);
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function exactEntry(value) {
  const match = /^(\d{6})\s+\w+\s+([0-9a-f]{40})\t/u.exec(String(value ?? "").replace(/\0$/u, ""));
  return match ? { mode: match[1], object: match[2] } : null;
}

function sameEntry(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function requiredSquashProjectionError(taskId, reason, cause = null) {
  const error = new Error(`PreRelease requires the exact squash projection for Task ${taskId}: ${reason}`);
  error.code = "TASK_SQUASH_PROJECTION_REQUIRED";
  if (cause) error.cause = cause;
  return error;
}

// Ordinary net projection is an optimization: failure to prove exclusive ownership
// retains effective dev replay. A selected squash transfer is different because its
// effective dev delta can omit absorbed source bytes; its exact projection is mandatory.
export async function releaseTaskNetProjections({ tasks, baseCommit, git }) {
  const proofs = new Map();
  const effectivePaths = new Map();
  const integrationPaths = new Map();
  const parents = new Map();
  const approved = new Map();
  const automatic = new Map();
  const integrationOwners = new Map();
  const treeEntry = async (treeish, name) => exactEntry(await git(["ls-tree", "-z", treeish, "--", name]));
  const blobBytes = async (entry) => {
    const value = await git(["cat-file", "blob", entry.object], { rawOutput: true });
    return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  };
  const changedPaths = async (left, right) => (await git([
    "diff", "--no-renames", "--name-only", "-z", left, right, "--", ...PATHS,
  ])).split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right));
  const getParents = async (commit) => {
    if (!parents.has(commit)) parents.set(commit, (await git(["show", "-s", "--format=%P", commit])).split(" ").filter(Boolean));
    return parents.get(commit);
  };
  const isApproved = async (commit) => {
    if (!approved.has(commit)) {
      try { await git(["merge-base", "--is-ancestor", commit, baseCommit]); approved.set(commit, true); }
      catch { approved.set(commit, false); }
    }
    return approved.get(commit);
  };
  const isAutomatic = async (commit) => {
    if (!automatic.has(commit)) {
      const values = await getParents(commit);
      let matches = false;
      if (values.length === 2) {
        try {
          const tree = (await git(["merge-tree", "--write-tree", ...values])).split(/\r?\n/u)[0];
          matches = tree === await git(["rev-parse", `${commit}^{tree}`]);
        } catch { /* Conflicts and unavailable merge-tree cannot prove ownership. */ }
      }
      automatic.set(commit, matches);
    }
    return automatic.get(commit);
  };

  for (const task of tasks) {
    const changed = new Set();
    for (const integration of task.integrations) {
      const owners = integrationOwners.get(integration.commit) ?? new Set();
      owners.add(task.taskId);
      integrationOwners.set(integration.commit, owners);
      if ((await getParents(integration.commit))[0] !== integration.parent) {
        throw new Error(`PreRelease integration parent changed for Task ${task.taskId}`);
      }
      const integrationChanged = new Set((await git([
        "diff", "--no-renames", "--name-only", "-z", integration.parent, integration.commit, "--", ...PATHS,
      ])).split("\0").filter(Boolean));
      integrationPaths.set(integration, integrationChanged);
      for (const name of integrationChanged) changed.add(name);
    }
    effectivePaths.set(task.taskId, changed);
  }

  for (const task of tasks) {
    if (!task.integrations.length) {
      if (task.squashTransfer && !await isApproved(task.resultCommit)) {
        throw requiredSquashProjectionError(task.taskId, "the selected result is absent from the approved base and has no pending integration");
      }
      continue;
    }
    try {
      if (task.squashTransfer) {
        const proof = normalizedTaskSquashTransfer(task.squashTransfer);
        const integration = task.integrations.find((item) => item.commit === proof.integrationCommit);
        const values = integration ? await getParents(integration.commit) : [];
        const tree = integration ? await git(["rev-parse", `${integration.commit}^{tree}`]) : null;
        await git(["merge-base", "--is-ancestor", proof.baselineResultCommit, proof.survivor.resultCommit]);
        if (proof.survivor.taskId !== task.taskId
            || !integration || values.length !== 2
            || values[0] !== proof.devBeforeCommit || values[1] !== proof.survivor.resultCommit
            || tree !== proof.devAfterTree
            || integrationOwners.get(integration.commit)?.size !== 1) {
          throw new Error("integration identity or unique ownership does not match the transfer");
        }
        const lineage = (await git([
          "rev-list", `--max-count=${MAX_ANCESTRY + 1}`, "--first-parent",
          task.resultCommit, `^${proof.survivor.resultCommit}^`,
        ])).split(/\r?\n/u).filter(Boolean);
        if (lineage.length > MAX_ANCESTRY || !lineage.includes(proof.survivor.resultCommit)) {
          throw new Error("selected result does not continue the exact squash first-parent lineage");
        }
        const subsequentIntegrations = task.integrations
          .filter((item) => compareIntegrations(integration, item) < 0).sort(compareIntegrations);
        const ordered = [integration, ...subsequentIntegrations];
        if (new Set(ordered.map((item) => item.commit)).size !== ordered.length
            || new Set(ordered.map((item) => item.order)).size !== ordered.length) {
          throw new Error("squash continuation integrations are duplicated or ambiguously ordered");
        }
        let prior = integration;
        for (const next of subsequentIntegrations) {
          const nextParents = await getParents(next.commit);
          if (integrationOwners.get(next.commit)?.size !== 1 || nextParents.length !== 2
              || !lineage.includes(nextParents[1]) || !await isAutomatic(next.commit)) {
            throw new Error("squash continuation lacks an exact automatic uniquely owned integration");
          }
          await git(["merge-base", "--is-ancestor", prior.commit, next.parent]);
          prior = next;
        }
        if ((await getParents(prior.commit))[1] !== task.resultCommit) {
          throw new Error("latest squash descendant is not covered by its exact integration");
        }
        const continuationHistory = (await git([
          "rev-list", `--max-count=${MAX_ANCESTRY + 1}`, "--first-parent",
          prior.commit, `^${integration.commit}`,
        ])).split(/\r?\n/u).filter(Boolean);
        if (continuationHistory.length > MAX_ANCESTRY) {
          throw new Error("squash continuation exceeds the integration proof bound");
        }
        const declared = new Set(subsequentIntegrations.map((item) => item.commit));
        for (const commit of continuationHistory) {
          const commitParents = await getParents(commit);
          if (commitParents.slice(1).some((parent) => lineage.includes(parent)) && !declared.has(commit)) {
            throw new Error("squash continuation omits an owned integration");
          }
        }
        const pendingContinuations = [];
        for (const next of subsequentIntegrations) {
          if (!await isApproved((await getParents(next.commit))[1])) pendingContinuations.push(next);
        }
        const sourcePaths = await changedPaths(proof.source.baseCommit, proof.source.resultCommit);
        const ownerPaths = await changedPaths(proof.baselineResultCommit, proof.survivor.resultCommit);
        if (JSON.stringify(sourcePaths) !== JSON.stringify(proof.sourceWitnesses.map((item) => item.path))
            || JSON.stringify(ownerPaths) !== JSON.stringify(proof.ownerWitnesses.map((item) => item.path))) {
          throw new Error("witness paths do not match the exact source and survivor deltas");
        }
        let exact = true;
        for (const witness of proof.sourceWitnesses) {
          if (!sameEntry(witness.source, await treeEntry(proof.source.resultCommit, witness.path))
              || !sameEntry(witness.survivor, await treeEntry(proof.survivor.resultCommit, witness.path))) {
            exact = false; break;
          }
        }
        for (const witness of proof.ownerWitnesses) {
          if (!sameEntry(witness.baseline, await treeEntry(proof.baselineResultCommit, witness.path))
              || !sameEntry(witness.beforeDev, await treeEntry(proof.devBeforeCommit, witness.path))
              || !sameEntry(witness.newResult, await treeEntry(proof.survivor.resultCommit, witness.path))
              || !sameEntry(witness.afterDev, await treeEntry(proof.devAfterTree, witness.path))) {
            exact = false; break;
          }
          if (witness.disposition === LF_NORMALIZATION_ALREADY_PRESENT
              && !exactCrLfToLfNormalization({
                baseline: await blobBytes(witness.baseline),
                newResult: await blobBytes(witness.newResult),
                dev: await blobBytes(witness.beforeDev),
              })) {
            exact = false; break;
          }
        }
        if (!exact) throw new Error("witness Git entries do not match the bound commits and trees");
        const devPaths = await changedPaths(proof.devBeforeCommit, proof.devAfterTree);
        if (devPaths.some((name) => !ownerPaths.includes(name))) {
          throw new Error("rolling dev contains changes outside the exact squash owner delta");
        }
        const bases = (await git(["merge-base", "--all", baseCommit, proof.survivor.resultCommit]))
          .split(/\r?\n/u).filter(Boolean);
        if (bases.length !== 1) throw new Error("approved base has no unique merge boundary with the squash result");
        const paths = await changedPaths(bases[0], proof.survivor.resultCommit);
        proofs.set(task.taskId, {
          parent: bases[0], commit: proof.survivor.resultCommit, paths,
          subsequentIntegrations: pendingContinuations,
          directResultMerge: true,
          orderPreserving: true, squashTransferHash: proof.transferHash,
        });
        continue;
      }
      const taskBaseCommit = String(task.baseCommit ?? "").trim();
      if (!/^[0-9a-f]{40}$/u.test(taskBaseCommit)
          || await git(["rev-parse", "--verify", `${taskBaseCommit}^{commit}`]) !== taskBaseCommit) continue;
      await git(["merge-base", "--is-ancestor", taskBaseCommit, baseCommit]);
      const taskBaseBoundaries = (await git([
        "merge-base", "--all", taskBaseCommit, task.resultCommit,
      ])).split(/\r?\n/u).filter(Boolean);
      if (taskBaseBoundaries.length !== 1) continue;
      const taskBaseBoundary = taskBaseBoundaries[0];
      const boundaryParents = await getParents(taskBaseBoundary);
      const taskFirstParent = (await git([
        "rev-list", `--max-count=${MAX_ANCESTRY + 1}`, "--first-parent", task.resultCommit,
        ...boundaryParents.map((parent) => `^${parent}`),
      ])).split(/\r?\n/u).filter(Boolean);
      if (taskFirstParent.length > MAX_ANCESTRY || !taskFirstParent.includes(taskBaseBoundary)) continue;
      const bases = (await git(["merge-base", "--all", baseCommit, task.resultCommit])).split(/\r?\n/u);
      if (bases.length !== 1) continue;
      const paths = (await git([
        "diff", "--no-renames", "--name-only", "-z", bases[0], task.resultCommit, "--", ...PATHS,
      ])).split("\0").filter(Boolean);
      const ancestry = (await git(["rev-list", `--max-count=${MAX_ANCESTRY + 1}`, task.resultCommit, `^${baseCommit}`])).split(/\r?\n/u).filter(Boolean);
      if (ancestry.length > MAX_ANCESTRY) continue;
      const orderedIntegrations = [...task.integrations].sort(compareIntegrations);
      if (new Set(orderedIntegrations.map(({ commit }) => commit)).size !== orderedIntegrations.length
          || new Set(orderedIntegrations.map(({ order }) => order)).size !== orderedIntegrations.length) continue;
      const earliest = orderedIntegrations[0];
      const latest = orderedIntegrations.at(-1);
      const own = new Set((await git([
        "rev-list", "--first-parent", task.resultCommit, `^${baseCommit}`, `^${earliest.parent}`,
      ])).split(/\r?\n/u).filter(Boolean));
      const integrations = new Set(task.integrations.map((item) => item.commit));
      let proven = true;
      for (const integration of task.integrations) {
        const values = await getParents(integration.commit);
        if (values.length !== 2 || (!own.has(values[1]) && !await isApproved(values[1]))
            || !await isAutomatic(integration.commit)) { proven = false; break; }
      }
      if (!proven) continue;
      for (const commit of ancestry) {
        if (own.has(commit)) continue;
        const values = await getParents(commit);
        if (values.length !== 2 || (!integrations.has(commit) && !await isApproved(values[1]))
            || !await isAutomatic(commit)) { proven = false; break; }
      }
      if (!proven
          || (await getParents(latest.commit))[1] !== task.resultCommit
          || !orderedIntegrations.every((integration) => integrationOwners.get(integration.commit)?.size === 1)) continue;
      let orderPreserving = true;
      if (orderedIntegrations.length > 1) {
        const ownPaths = effectivePaths.get(task.taskId);
        orderPreserving = !tasks.some((other) => other.taskId !== task.taskId
          && other.integrations.some((integration) => compareIntegrations(earliest, integration) < 0
            && compareIntegrations(integration, latest) < 0
            && intersects(ownPaths, integrationPaths.get(integration))));
      }
      if (!orderPreserving) continue;
      proofs.set(task.taskId, {
        parent: bases[0], commit: task.resultCommit, paths, orderPreserving,
      });
    } catch (error) {
      if (task.squashTransfer) {
        if (error?.code === "TASK_SQUASH_PROJECTION_REQUIRED") throw error;
        throw requiredSquashProjectionError(task.taskId, error?.message ?? "Git proof is unavailable", error);
      }
      // A failed or unsupported ordinary proof falls back to the existing fenced replay.
    }
  }
  return proofs;
}
