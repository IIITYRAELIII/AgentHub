const instances = new WeakSet();
const kinds = new Set(["release-git-startup", "task-git-startup", "task-git", "release-git", "task-git-diff", "usage-sync", "exchange-rate", "media", "codex-rollout"]);

export function createContourExternalEffectsPort(record) {
  if (typeof record !== "function") throw new TypeError("Contour effect recording port is required");
  const policy = Object.freeze({
    exclude(kind, operation, targets = []) {
      if (!kinds.has(kind)) throw new Error(`Unclassified contour effect: ${kind}`);
      if (typeof operation !== "string" || !operation || !Array.isArray(targets)) throw new Error("Invalid contour exclusion");
      // Only operational target identities enter this log. Enrollment codes,
      // provider credentials, message content and arbitrary options never do.
      const recordedTargets = targets.map(({ workspaceId, projectRoot, registrationSource }) => ({
        workspaceId: String(workspaceId ?? ""), projectRoot: String(projectRoot ?? ""),
        registrationSource: String(registrationSource ?? ""),
      }));
      const result = { skipped: true, status: "excluded", reason: "test-contour-external-effect", kind, operation };
      record({ ...result, targets: recordedTargets });
      return result;
    },
  });
  instances.add(policy);
  return policy;
}

export function assertContourExternalEffects(policy) {
  if (policy != null && !instances.has(policy)) throw new Error("Unverified contour effect policy");
  return policy;
}

export function assertContourGitAvailable(policy, kind, operation) {
  assertContourExternalEffects(policy);
  if (!policy) return;
  policy.exclude(kind, operation);
  throw Object.assign(new Error(`Recording contour excludes ${kind} operation ${operation}`), {
    code: "CONTOUR_EXTERNAL_EFFECT_EXCLUDED", kind, operation,
  });
}
