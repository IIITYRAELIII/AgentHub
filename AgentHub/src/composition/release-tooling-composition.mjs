import path from "node:path";
import { readReleaseToolPackage } from "../infrastructure/process/release-tool-package.mjs";
import { freezePreparedPublication } from "./publication-freeze.mjs";
import { assertReleaseCloneForPublication, assertPreparedPublicationSource } from "../infrastructure/filesystem/release-git-workspace.mjs";
import { createFrozenReleasePublication } from "../infrastructure/process/frozen-release-publication.mjs";
import { measureTaskOperation } from "../infrastructure/process/task-operation-timing.mjs";

export function releasePublicationPlatform() {
  return Object.freeze({ apiVersion: 1, publication: Object.freeze({
    freezePreparedPublication, assertReleaseCloneForPublication, assertPreparedPublicationSource, createFrozenReleasePublication }),
    trace: Object.freeze({ measure: measureTaskOperation }),
    execution: Object.freeze({ runnerFile: path.resolve(import.meta.dirname, "../../release-operation-publication-runner.mjs") }),
  });
}

// The pinned recipe supplies product behavior. Only the existing candidate,
// Git custody, state and checkpoint API crosses this boundary.
export async function createExternalPublicationTools({
  toolPackage = null, sourceRoot = path.resolve(import.meta.dirname, "../.."),
} = {}) {
  const tool = toolPackage ?? await readReleaseToolPackage();
  await tool.assertUnchanged();
  if (!tool.recipe || tool.recipe.apiVersion !== 1) throw new Error("Pinned tool has no release recipe API");
  const recipe = await tool.module(tool.recipe.module);
  if (recipe.releaseRecipeApiVersion !== 1) throw new Error("Pinned release recipe API differs");
  return { ...recipe.createPublicationTools({ sourceRoot, platform: releasePublicationPlatform() }), tool };
}
