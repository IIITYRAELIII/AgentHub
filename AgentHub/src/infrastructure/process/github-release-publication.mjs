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
  if (!options.runtimePublication || !options.journal || !options.artifacts) throw new Error("Frozen distribution owner is required");
  const version = artifactVersionIdentity(options.runtimePublication.version).publicVersion;
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Stable distribution requires a stable public version");
  let owner;
  const load = () => owner ??= tools(toolPackage).then(api => api.createGitHubDistributionSteps(options));
  async function executeStep(label, identity, args) {
    const matches = (await load()).steps(identity).filter(step => step.label === label);
    if (matches.length !== 1 || matches[0].reusable !== false) throw new Error("External distribution step contract changed");
    return matches[0].execute(...args);
  }
  return {
    // Preserve the existing synchronous step-planning port. Executor selection
    // and its asynchronous verification happen when the actual step runs.
    steps: identity => [PACKAGE_DISTRIBUTION, PUBLISH_GITHUB_RELEASE].map(label => ({
      label, reusable: false, execute: (...args) => executeStep(label, identity, args),
    })),
    verify: async (...args) => (await load()).verify(...args),
  };
}
