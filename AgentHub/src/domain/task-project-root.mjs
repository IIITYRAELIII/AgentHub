export function taskProjectRoot({ workspace, stream = null } = {}) {
  return String(stream?.settings?.workingDirectory ?? "").trim()
    || String(workspace?.settings?.workingDirectory ?? "").trim()
    || null;
}

export async function configuredProjectForTaskWorkingDirectory({
  workingDirectory,
  findProject,
  taskGitWorkspaces = null,
  taskId = null,
  taskNumber = null,
} = {}) {
  const directory = String(workingDirectory ?? "").trim();
  if (!directory || typeof findProject !== "function") return null;
  const direct = findProject(directory);
  if (direct) return direct;
  const repositoryRoot = await taskGitWorkspaces?.managedRepositoryRoot?.(directory, { taskId, taskNumber });
  return repositoryRoot ? findProject(repositoryRoot) : null;
}
