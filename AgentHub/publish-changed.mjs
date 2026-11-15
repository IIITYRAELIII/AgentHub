// Compatibility API adapter. Execution policy lives in the pinned external tool.
import { createExternalPublicationTools } from "./src/composition/release-tooling-composition.mjs";
import { launchReleaseTool } from "./src/infrastructure/process/release-tool-launcher.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const tools = await createExternalPublicationTools();
export const { RELEASE_CANDIDATE_CONTOUR_LABEL, classifyPublicationChanges, focusedSteps, selectedPublicationSteps, needsVisualPublicationTests, parseChangedArguments, publishChanged, runReleaseOperationCli, freezePreparedPublication } = tools;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await launchReleaseTool(["run", ...process.argv.slice(2)], { toolPackage: tools.tool });
}
