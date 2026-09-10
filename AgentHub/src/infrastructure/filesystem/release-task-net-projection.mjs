const PATHS = [".", ":(exclude,glob)**/CHANGELOG.md", ":(exclude)CHANGELOG.md"];
const MAX_ANCESTRY = 512;

// An optimization only: failure to prove exclusive ownership retains effective dev replay.
export async function releaseTaskNetProjections({ tasks, baseCommit, git }) {
  const proofs = new Map();
  const effectivePaths = new Map();
  const parents = new Map();
  const approved = new Map();
  const automatic = new Map();
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
      if ((await getParents(integration.commit))[0] !== integration.parent) {
        throw new Error(`PreRelease integration parent changed for Task ${task.taskId}`);
      }
      for (const name of (await git([
        "diff", "--name-only", "-z", integration.parent, integration.commit, "--", ...PATHS,
      ])).split("\0").filter(Boolean)) changed.add(name);
    }
    effectivePaths.set(task.taskId, changed);
  }

  for (const task of tasks) {
    if (task.integrations.length < 2) continue;
    try {
      const bases = (await git(["merge-base", "--all", baseCommit, task.resultCommit])).split(/\r?\n/u);
      if (bases.length !== 1) continue;
      const paths = (await git(["diff", "--name-only", "-z", bases[0], task.resultCommit, "--", ...PATHS])).split("\0").filter(Boolean);
      const ancestry = (await git(["rev-list", `--max-count=${MAX_ANCESTRY + 1}`, task.resultCommit, `^${baseCommit}`])).split(/\r?\n/u).filter(Boolean);
      if (ancestry.length > MAX_ANCESTRY) continue;
      const earliest = task.integrations.reduce((left, right) => left.order <= right.order ? left : right);
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
      if (proven) proofs.set(task.taskId, { parent: bases[0], commit: task.resultCommit, paths });
    } catch { /* A failed or unsupported proof falls back to the existing fenced replay. */ }
  }
  // A reopened Task may have published integrations whose old paths no longer
  // belong to its pending delta. Use net paths only after proving ownership.
  // Withdrawing a proof restores effective replay and may expose more overlaps.
  while (proofs.size) {
    const rejected = [];
    for (const [taskId, proof] of proofs) {
      if (tasks.some((other) => {
        if (other.taskId === taskId) return false;
        const paths = proofs.has(other.taskId)
          ? new Set(proofs.get(other.taskId).paths) : effectivePaths.get(other.taskId);
        return proof.paths.some((name) => paths.has(name));
      })) rejected.push(taskId);
    }
    if (!rejected.length) break;
    for (const taskId of rejected) proofs.delete(taskId);
  }
  return proofs;
}
