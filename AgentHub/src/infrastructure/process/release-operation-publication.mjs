import { isDeepStrictEqual } from "node:util";
import { readReleaseToolPackage } from "./release-tool-package.mjs";

// Product-neutral delegation. SQL admission, original identities, generations
// and finalization stay in their existing platform owners. The pinned recipe
// implements target effects and their addressed readback/recovery proof.
export class ReleaseOperationPublication {
  #resolved = null;
  constructor(options = {}) {
    if (options.platform?.apiVersion !== 1) throw new TypeError("Explicit release platform API is required");
    this.options = options;
    this.platform = options.platform;
    this.environment = options.environment ?? process.env;
  }
  async #recipe(input = null) {
    if (!this.#resolved) this.#resolved = (async () => {
      const tool = await readReleaseToolPackage({ root: this.environment.AGENT_HUB_RELEASE_TOOLS_ROOT,
        expectedSha256: this.environment.AGENT_HUB_RELEASE_TOOLS_SHA256 });
      if (!tool.recipe || tool.recipe.apiVersion !== 1) throw new Error("Pinned tool has no release recipe API");
      const recipe = await tool.module(tool.recipe.module);
      if (recipe.releaseRecipeApiVersion !== 1 || typeof recipe.createPublicationOwner !== "function") {
        throw new Error("Pinned release recipe API differs");
      }
      return { tool, recipe, owner: recipe.createPublicationOwner(this.options, this.platform) };
    })().catch(error => { this.#resolved = null; throw error; });
    const result = await this.#resolved;
    await result.tool.assertUnchanged();
    const expected = input?.operation?.authorization?.recipe?.executor;
    if (expected && !isDeepStrictEqual(expected, result.tool.location)) {
      throw new Error("Release recipe executor differs from its original authority");
    }
    for (const candidate of input?.generation?.candidates ?? []) {
      const frozen = candidate.manifest?.publication?.recipeExecutor;
      if (expected && !isDeepStrictEqual(expected, frozen)) throw new Error("Frozen recipe executor authority differs");
    }
    return result;
  }
  async publish(input) { return (await this.#recipe(input)).owner.publish(input); }
  async readback(input) { return (await this.#recipe(input)).owner.readback(input); }
  async publishPreparedAssets(input) { return (await this.#recipe(input)).owner.publishPreparedAssets(input); }
  async withPublicationRecovery(input) { return (await this.#recipe(input)).owner.withPublicationRecovery(input); }
  async withRetainedGeneration(input) { return (await this.#recipe(input)).owner.withRetainedGeneration(input); }
  async resolveTestPlans(candidates, selection) { return (await this.#recipe()).recipe.resolveTestPlans(candidates, selection); }
  async loadAuthorizationPolicy() {
    const { recipe, tool } = await this.#recipe();
    if (typeof recipe.prepareAuthorization !== "function") throw new TypeError("Recipe authorization policy is required");
    return authorization => {
      const result = recipe.prepareAuthorization(structuredClone(authorization));
      if (result?.then) throw new TypeError("Recipe authorization policy must return synchronous JSON");
      if (!result || Object.keys(result).join() !== "recipe") throw new TypeError("Recipe policy cannot replace release authority");
      return { recipe: { ...result.recipe, executor: structuredClone(tool.location) } };
    };
  }
}
