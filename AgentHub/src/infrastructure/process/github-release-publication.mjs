// Existing Hub state/domain ports; publication effects live in the external tool.
import { readReleaseToolPackage } from "./release-tool-package.mjs";
import { ownedGitArguments } from "../filesystem/preparation-git-isolation.mjs";
import { artifactVersionIdentity } from "../../domain/agent-hub-version.mjs";
import { parseGitHubRemote } from "../persistence/github-publication-baseline.mjs";
const tool = await readReleaseToolPackage();
const api = (await tool.module("src/github-publication.mjs")).createGitHubPublicationTools({
  toolRoot: tool.root, assertToolUnchanged: () => tool.assertUnchanged(),
  ownedGitArguments, artifactVersionIdentity, parseGitHubRemote,
});
export const { PACKAGE_DISTRIBUTION, PUBLISH_GITHUB_RELEASE,
  githubReleaseTransport, createGitHubDistributionSteps } = api;
