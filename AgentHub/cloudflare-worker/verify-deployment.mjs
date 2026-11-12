// Development compatibility entry; product behavior belongs to the pinned recipe.
import { releaseRecipeModule } from "../src/ports/release-recipe.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sourceRoot = path.resolve(import.meta.dirname, "..");
const { recipe } = await releaseRecipeModule();
export const { WorkerDeploymentNotConvergedError, workerVerificationCheckpointFile, workerVerificationCheckpointStore, fetchWithCurl, measureImmediateControlDrain, fetchWithTransportRace, changedBackgrounds, verifyThemeDeployment, WORKER_VERIFY_REQUEST_TIMEOUT_MS } = recipe.workerTools({ sourceRoot });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await recipe.workerCommand({ sourceRoot, action: 'verify-deployment' });
}
