export function prepareContourProjectConfiguration({ config, environment, mapping }) {
  if (!mapping || !config || !Array.isArray(config.projects) || !config.projects.length) {
    throw new Error("Explicit recording mapping and source projects are required");
  }
  const operational = (value) => mapping.paths.map(mapping.canonicalPath(value), "project");
  const projects = config.projects.map((project) => ({ ...project, path: operational(project.path) }));
  const projectRoot = operational(config.projectRoot);
  if (new Set(projects.map((project) => project.path)).size !== projects.length) throw new Error("Duplicate prepared project");
  if (!projects.some((project) => project.path === projectRoot)) throw new Error("Default project is absent from prepared projects");
  const preparedEnvironment = { ...environment };
  // loadConfig intentionally treats this variable as a single-project override.
  // A prepared multi-project config must be the sole authority for its roots.
  delete preparedEnvironment.CODEX_PROJECT_ROOT;
  return { config: { ...config, projectRoot, projects }, environment: preparedEnvironment };
}
