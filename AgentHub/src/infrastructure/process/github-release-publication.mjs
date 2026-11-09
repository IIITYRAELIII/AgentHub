// Existing Hub state/domain ports; publication effects live in the external tool.
import { readReleaseToolPackage } from "./release-tool-package.mjs";
import { ownedGitArguments } from "../filesystem/preparation-git-isolation.mjs";
import { artifactVersionIdentity } from "../../domain/agent-hub-version.mjs";
import { parseGitHubRemote } from "../persistence/github-publication-baseline.mjs";
export const PACKAGE_DISTRIBUTION = "Упаковка установочного архива";
export const PUBLISH_GITHUB_RELEASE = "Публикация GitHub Release";

async function tools(toolPackage) {
  const tool = toolPackage ?? await readReleaseToolPackage();
  await tool.assertUnchanged();
  return (await tool.module("src/github-publication.mjs")).createGitHubPublicationTools({
    toolRoot: tool.root, assertToolUnchanged: () => tool.assertUnchanged(),
    ownedGitArguments, artifactVersionIdentity, parseGitHubRemote,
  });
}

// Importing the application does not select an executor. An addressed original
// supplies its verified retained package when it actually needs these ports.
export function githubReleaseTransport(options, toolPackage = null) {
  let transport;
  return async (...args) => {
    transport ??= tools(toolPackage).then(api => api.githubReleaseTransport(options));
    return (await transport)(...args);
  };
}

export function createGitHubDistributionSteps({ toolPackage = null, ...options } = {}) {
  let owner;
  const load = () => owner ??= tools(toolPackage).then(api => api.createGitHubDistributionSteps(options));
  return { steps: async (...args) => (await load()).steps(...args),
    verify: async (...args) => (await load()).verify(...args) };
}
