import { assertContourExternalEffects } from "../ports/contour-external-effects.mjs";

export async function reconcileContourAwareStartupGit({ policy = null, releaseGitWorkspaces, taskGitWorkspaces, projectRoots, startupStep }) {
  assertContourExternalEffects(policy);
  const run = (kind, service) => policy
    ? { ...policy.exclude(kind, "reconcile", projectRoots), repositories: [] }
    : service.reconcile({ projectRoots });
  const releaseReconciliation = await startupStep("release-git-reconciliation", () => run("release-git-startup", releaseGitWorkspaces));
  const taskGitReconciliation = await startupStep("task-git-reconciliation", () => run("task-git-startup", taskGitWorkspaces));
  return { releaseReconciliation, taskGitReconciliation };
}

export function refreshContourAwareExchangeRate({ policy = null, store }) {
  assertContourExternalEffects(policy);
  return policy ? Promise.resolve(policy.exclude("exchange-rate", "refresh")) : store.refresh();
}
