const PATHS = [".", ":(exclude,glob)**/CHANGELOG.md", ":(exclude)CHANGELOG.md"];
const MAX_ANCESTRY = 512;

function compareIntegrations(left, right) {
  return left.order - right.order || left.commit.localeCompare(right.commit);
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

// An optimization only: failure to prove exclusive ownership retains effective dev replay.
export async function releaseTaskNetProjections({ tasks, baseCommit, git }) {
  const proofs = new Map();
  const effectivePaths = new Map();
  const integrationPaths = new Map();
  const parents = new Map();
  const approved = new Map();
  const automatic = new Map();
  const integrationOwners = new Map();
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
    if (!task.integrations.length) continue;
    try {
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
    } catch { /* A failed or unsupported proof falls back to the existing fenced replay. */ }
  }
  return proofs;
}
