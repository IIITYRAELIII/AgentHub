import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ReleasePreparationRejectedError } from "../../domain/release-preparation.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paths = (bytes) => bytes.toString("utf8").split("\0").filter(Boolean);
const refuse = (message) => { throw new ReleasePreparationRejectedError(message); };

// Read-only checks run inside the existing candidate owner, before its effects
// and before commit-tree/update-ref. This helper never writes Git or checkpoints.
export async function assertPreparationCheckpoint({ guard, clone, initial, checkpoint, git }) {
  if (!guard) return;
  if (!checkpoint || checkpoint.phase !== "prepared"
      || checkpoint.manifestHash !== guard.manifestHash
      || checkpoint.preReleaseHead !== guard.preReleaseHead
      || sha256(await readFile(clone.checkpointFile)) !== guard.checkpointHash
      || await git(["rev-parse", "refs/heads/PreRelease^{commit}"]) !== guard.preReleaseHead
      || await git(["rev-parse", `${guard.preReleaseHead}^{tree}`]) !== guard.tree
      || initial.mainCommit !== guard.primaryMainCommit
      || await git(["rev-parse", "refs/remotes/origin/main^{commit}"]) !== guard.originMainCommit) {
    refuse("Preparation checkpoint, ref, tree or main pins changed");
  }
  if (sha256(await readFile(checkpoint.manifestFile)) !== guard.manifestHash) {
    refuse("Preparation prior manifest bytes changed");
  }
}

export async function assertPreparationTree({ guard, tree, baseCommit, tasks, git }) {
  if (!guard) return;
  if (tree !== guard.approvedTree || baseCommit !== guard.approvedBaseCommit) {
    refuse("Full selected/joint preparation tree differs from the reviewed tree");
  }
  const owned = new Set();
  for (const task of tasks) {
    if (!/^[a-f0-9]{40}$/u.test(String(task.baseCommit ?? ""))) {
      refuse("Preparation Task has no exact registered base");
    }
    for (const relative of paths(await git([
      "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z",
      task.baseCommit, task.resultCommit, "--",
    ], { rawOutput: true }))) {
      if (relative !== "CHANGELOG.md") owned.add(relative);
    }
  }
  const changed = paths(await git([
    "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", guard.publishedRevision, tree, "--",
  ], { rawOutput: true }));
  if (changed.some((relative) => !owned.has(relative))) {
    refuse("Preparation changes entries outside the full selected Task-owned union");
  }
}
