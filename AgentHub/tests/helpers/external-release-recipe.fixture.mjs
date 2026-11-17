import { fileURLToPath } from "node:url";
import { readReleaseToolPackage } from "../../src/infrastructure/process/release-tool-package.mjs";
const tool = await readReleaseToolPackage();
export const { buildArtifact } = await tool.module("src/artifact-io.mjs");
await tool.assertUnchanged();
export const { nextRuntimeReleaseVersion } = await tool.module("src/agent-hub/src/infrastructure/filesystem/runtime-release-version.mjs");
export const { agentHubCalendarVersion, prepareCommittedAgentHubReleaseVersion,
  prepareAgentHubReleaseVersion, inspectAgentHubReleaseVersion, nextAgentHubPublicVersion } =
  await tool.module("src/agent-hub/src/infrastructure/filesystem/release-version.mjs");
export const { publicRuntimeInstallationAuthorization, normalizedRuntimeInstallation, PUBLIC_RUNTIME_INSTALLATION } =
  await tool.module("src/agent-hub/src/domain/public-runtime-installation.mjs");

const application = (await tool.module("src/application-client.mjs")).applicationMaintenance(fileURLToPath(new URL("../..", import.meta.url)));
export const publicationRuntimeStatus = input => application("status", input);
export const startInstalledPublicationRuntime = async options => (await tool.module("src/agent-hub/src/runtime/runtime-publication-start.mjs"))
  .startInstalledPublicationRuntime({ ...options, readStatus: options.readStatus ?? publicationRuntimeStatus });
