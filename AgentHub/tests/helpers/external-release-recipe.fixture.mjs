import { readReleaseToolPackage } from "../../src/infrastructure/process/release-tool-package.mjs";
import { releasePublicationPlatform } from "../../src/composition/release-tooling-composition.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const tool = await readReleaseToolPackage();
export const externalRecipeEntrypoint = pathToFileURL(path.join(tool.root, "src/agent-hub-execution.mjs"));
export const externalExtensionInstaller = path.join(tool.root, "python/vscode_extension.py");
export const externalRecipientRoot = path.join(tool.root, "recipient");
await tool.assertUnchanged();
if (tool.recipe?.apiVersion !== 1) throw new Error("Tests require the explicit external recipe API pin");
export const { releaseTestPlans, discoverReleaseTestInventory: discoverRecipeInventory, RELEASE_CHECK_IDS: RECIPE_CHECK_IDS } =
  await tool.module("src/agent-hub/src/infrastructure/filesystem/release-test-inventory.mjs");
const { createPublicationOwner } = await tool.module("src/agent-hub-publication.mjs");
export class ProductPublicationOwner {
  constructor(options) { return createPublicationOwner(options, releasePublicationPlatform()); }
}
const recipeApi = await tool.module(tool.recipe.module);
export const productToolsFor = sourceRoot => recipeApi.createPublicationTools({ sourceRoot, platform: releasePublicationPlatform() });
export const product = await tool.module("src/agent-hub-execution.mjs");
export const { releaseOperationPublicationArguments, releaseOperationRuntimePublicationInput,
  distributionArtifactAdapter, releaseOperationDeploymentProfile, createReleaseOperationPublicInstaller } = product;
const { createPublicRuntimeInstaller: productInstaller, publicRuntimeInstallerBinding, releaseTargetExecutionRoot,
  readPublishedRuntimePackage } = await tool.module("src/public-runtime-installer.mjs");
export { publicRuntimeInstallerBinding, releaseTargetExecutionRoot, readPublishedRuntimePackage };
// Existing cross-boundary stands explicitly use this application source as the
// public JSON API endpoint. Production calls provide their candidate root.
export const createPublicRuntimeInstaller = options => productInstaller({ sourceRoot: path.resolve(import.meta.dirname, "../.."), ...options });
export const { createGitHubDistributionSteps, githubReleaseTransport } = await tool.module("src/github-composition.mjs");
export const { nextRuntimeReleaseVersion } = await tool.module("src/agent-hub/src/infrastructure/filesystem/runtime-release-version.mjs");
export const { agentHubCalendarVersion, prepareCommittedAgentHubReleaseVersion,
  prepareAgentHubReleaseVersion, inspectAgentHubReleaseVersion, nextAgentHubPublicVersion } =
  await tool.module("src/agent-hub/src/infrastructure/filesystem/release-version.mjs");
export const { publicRuntimeInstallationAuthorization, normalizedRuntimeInstallation, PUBLIC_RUNTIME_INSTALLATION } =
  await tool.module("src/agent-hub/src/domain/public-runtime-installation.mjs");
export const { artifactFiles, buildArtifact, readArtifact, validateFrozenRuntimePublication } = await tool.module("src/artifact-io.mjs");
export const { publicationCheckpointStore, runPublicationSteps, PUBLIC_INSTALLER_HANDOFF } =
  await tool.module("src/agent-hub/src/infrastructure/persistence/publication-checkpoint.mjs");
export const { publicationRunStore, publicationRunPaths, readPublicationRunStatus,
  failedFrozenPublicationEvidence, PUBLICATION_STAGE_CONTRACT } =
  await tool.module("src/agent-hub/src/infrastructure/persistence/publication-run-store.mjs");
export const { completePublication, resumePendingPublicationCompletion,
  RUNTIME_READINESS_STAGE, RELEASE_FINALIZATION_STAGE, RECORD_PUBLICATION_STAGE } = await tool.module("src/publication-completion.mjs");
export const { resumeRuntimePublicationCompletion, publicationAwareReadiness } =
  (await tool.module("src/legacy-completion.mjs")).createLegacyCompletion({
    sourceRoot: path.resolve(import.meta.dirname, "../.."), platform: releasePublicationPlatform(),
  });
const application = (await tool.module("src/application-client.mjs")).applicationMaintenance(path.resolve(import.meta.dirname, "../.."));
export const publicationRuntimeStatus = input => application("status", input);
export const startInstalledPublicationRuntime = async options => (await tool.module("src/agent-hub/src/runtime/runtime-publication-start.mjs"))
  .startInstalledPublicationRuntime({ ...options, readStatus: options.readStatus ?? publicationRuntimeStatus });
export const waitForRuntimeReplacement = async options => (await tool.module("src/agent-hub/src/runtime/publication-readiness.mjs"))
  .waitForRuntimeReplacement({ ...options, readStatus: options.readStatus ?? publicationRuntimeStatus });

// Controlled lower-level product ports belong to the recipe test boundary.
// Production Hub composition never supplies these application functions.
const layout = await tool.module("src/agent-hub/src/infrastructure/filesystem/runtime-layout.mjs");
const verifier = await tool.module("src/agent-hub/src/infrastructure/filesystem/runtime-manifest-verifier.mjs");
const version = await tool.module("src/agent-hub/src/domain/agent-hub-version.mjs");
export const { createPublicationArtifactSteps } = (await tool.module("src/publication-artifacts.mjs"))
  .createArtifactPublicationTools({ ...layout, ...verifier, ...version,
    artifactFiles, buildArtifact, readArtifact, validateRuntimePublication: validateFrozenRuntimePublication });
