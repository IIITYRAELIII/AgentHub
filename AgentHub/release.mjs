// Hub owner compatibility exports. The operator CLI is the external tool.
export { parseReleaseArguments, openReleaseRuntime, executeRelease } from "./src/composition/release-api-runtime.mjs";
import { launchReleaseTool } from "./src/infrastructure/process/release-tool-launcher.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await launchReleaseTool(process.argv.slice(2));
}
