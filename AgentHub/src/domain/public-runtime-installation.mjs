import path from "node:path";

export const PUBLIC_RUNTIME_INSTALLATION = "public-package-v1";

function repositoryIdentity(root) {
  if (typeof root !== "string" || !root.trim()) return null;
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function publicRuntimeInstallationAuthorization(targets = []) {
  const local = targets.filter(target => target.kind === "agent-hub-publication" && target.environment !== "github-release");
  if (!local.length) return {};
  for (const target of local) {
    const repository = repositoryIdentity(target.repositoryRoot);
    const approved = targets.filter(candidate => candidate.kind === "agent-hub-publication"
      && candidate.targetId === "agent-hub-github-release" && candidate.environment === "github-release"
      && repository !== null && repositoryIdentity(candidate.repositoryRoot) === repository);
    if (approved.length !== 1) {
      throw new Error("Local installation requires one separately approved public package target for the same repository");
    }
  }
  return { runtimeInstallation: PUBLIC_RUNTIME_INSTALLATION };
}

export function normalizedRuntimeInstallation(value, targets) {
  if (value === undefined) return {};
  if (value !== PUBLIC_RUNTIME_INSTALLATION
    || publicRuntimeInstallationAuthorization(targets).runtimeInstallation !== value) {
    throw new TypeError("Unsupported public runtime installation authorization");
  }
  return { runtimeInstallation: value };
}
