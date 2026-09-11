// A projection at the existing read boundary, never a second catalog or ledger.
// The verified recording mapping owns path equivalence and seeded Thread IDs.
export function contourReadModelOptions(options, mapping) {
  if (!mapping) return options;
  const { projects, services } = options;
  const canonicalProject = (project) => ({ ...project, path: mapping.canonicalPath(project.path) });
  const entries = (values) => values.map((entry) => mapping.target(entry));
  const projected = { ...services };
  if (services.catalogEntries) projected.catalogEntries = () => entries(services.catalogEntries());
  if (services.refreshCatalog) projected.refreshCatalog = async (...args) => entries(await services.refreshCatalog(...args));
  if (services.threadsForStream) projected.threadsForStream = (streamId) => (
    services.threadsForStream(streamId).map((thread) => mapping.target({ ...thread, streamId }))
  );
  if (services.findProject) projected.findProject = (value) => {
    const canonical = mapping.canonicalPath(value);
    const project = services.findProject(mapping.paths.map(canonical, "project"));
    return project ? canonicalProject(project) : project;
  };
  if (services.workspaceHierarchy) projected.workspaceHierarchy = (...args) => (
    services.workspaceHierarchy(...args).map((workspace) => ({
      ...workspace,
      settings: workspace.settings ? { ...workspace.settings,
        ...(workspace.settings.workingDirectory ? { workingDirectory: mapping.canonicalPath(workspace.settings.workingDirectory) } : {}),
      } : workspace.settings,
      streams: (workspace.streams ?? []).map((stream) => ({
        ...stream,
        settings: stream.settings ? { ...stream.settings,
          ...(stream.settings.project ? { project: mapping.canonicalPath(stream.settings.project) } : {}),
        } : stream.settings,
        threads: (stream.threads ?? []).map((thread) => mapping.target({ ...thread, streamId: stream.id })),
      })),
    }))
  );
  for (const name of ["readCachedHistory", "refreshHistory"]) {
    if (services[name]) projected[name] = (binding, ...args) => services[name](mapping.target(binding), ...args);
  }
  if (services.readHistoryPage) projected.readHistoryPage = (bindings, ...args) => (
    services.readHistoryPage(entries(bindings), ...args)
  );
  return { ...options, projects: projects.map(canonicalProject), services: projected };
}

// Preparation-only input to the existing config loader. This does not enable
// the recording profile or relax its unconditional boot fence. Neither input
// is persisted here; unrelated config/environment fields retain their values.
