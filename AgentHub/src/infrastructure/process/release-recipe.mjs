import { isDeepStrictEqual } from "node:util";
import { readReleaseToolPackage } from "./release-tool-package.mjs";

export async function releaseRecipeModule({ environment = process.env, expectedExecutor = null } = {}) {
  const tool = await readReleaseToolPackage(expectedExecutor != null
    ? { root: expectedExecutor.root ?? null, expectedSha256: expectedExecutor.sha256 ?? null,
      expectedLocation: expectedExecutor }
    : { root: environment.AGENT_HUB_RELEASE_TOOLS_ROOT ?? null,
      expectedSha256: environment.AGENT_HUB_RELEASE_TOOLS_SHA256 ?? null });
  if (tool.recipe?.apiVersion !== 1) throw new Error("Pinned tool has no release recipe API");
  const recipe = await tool.module(tool.recipe.module);
  if (recipe.releaseRecipeApiVersion !== 1) throw new Error("Pinned release recipe API differs");
  if (expectedExecutor && !isDeepStrictEqual(tool.location, expectedExecutor)) {
    throw new Error("Release recipe executor differs from its original authority");
  }
  return { tool, recipe };
}
