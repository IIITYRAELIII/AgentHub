export function taskProjectRoot({ workspace, stream = null } = {}) {
  return String(stream?.settings?.workingDirectory ?? "").trim()
    || String(workspace?.settings?.workingDirectory ?? "").trim()
    || null;
}

export async function configuredProjectForTaskWorkingDirectory({
  workingDirectory,
  findProject,
  taskGitWorkspaces = null,
} = {}) {
  const directory = String(workingDirectory ?? "").trim();
  if (!directory || typeof findProject !== "function") return null;
  const direct = findProject(directory);
  if (direct) return direct;
  const repositoryRoot = await taskGitWorkspaces?.managedRepositoryRoot?.(directory);
  return repositoryRoot ? findProject(repositoryRoot) : null;
}
