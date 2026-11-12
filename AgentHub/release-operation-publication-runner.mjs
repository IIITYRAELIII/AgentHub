import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releasePublicationPlatform } from "./src/composition/release-tooling-composition.mjs";
import { ReleaseOperationStore } from "./src/infrastructure/persistence/release-operation-store.mjs";
import { readReleaseToolPackage } from "./src/infrastructure/process/release-tool-package.mjs";

function requiredEnvironment(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function runReleaseRecipe() {
  const dataDir = requiredEnvironment("AGENT_HUB_DATA_DIR");
  const operationId = requiredEnvironment("AGENT_HUB_RELEASE_OPERATION_ID");
  const generationNumber = Number(requiredEnvironment("AGENT_HUB_RELEASE_GENERATION"));
  const targetId = requiredEnvironment("AGENT_HUB_RELEASE_TARGET_ID");
  const executionRoot = path.resolve(requiredEnvironment("AGENT_HUB_RELEASE_EXECUTION_ROOT"));
  const startedAt = requiredEnvironment("AGENT_HUB_RELEASE_RUNNER_STARTED_AT");
  const candidateIdentity = requiredEnvironment("AGENT_HUB_RELEASE_CANDIDATE_IDENTITY");
  const runtimeRoot = path.resolve(requiredEnvironment("AGENT_HUB_RUNTIME_ROOT"));
  const tool = await readReleaseToolPackage();
  if (!tool.recipe || tool.recipe.apiVersion !== 1) throw new Error("Original tool does not expose the release recipe API");
  const recipe = await tool.module(tool.recipe.module);
  if (recipe.releaseRecipeApiVersion !== 1 || typeof recipe.executePublication !== "function") {
    throw new Error("Pinned release recipe API differs");
  }
  const store = new ReleaseOperationStore({ dataDir });
  const operation = store.get(operationId);
  const generation = store.generation(operationId, generationNumber);
  if (!operation || !generation) throw new Error("release operation generation was not found");
  if (generation.identitySha256 !== candidateIdentity) throw new Error("release operation generation identity changed");
  const sourceRoot = path.resolve(process.cwd());
  const candidates = generation.candidates.filter(candidate => {
    const relative = path.relative(candidate.releaseRoot, sourceRoot);
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (candidates.length !== 1) throw new Error("publication runner checkout does not match its immutable generation");
  const candidate = candidates[0];
  const expectedExecutor = operation.authorization.recipe?.executor;
  if (expectedExecutor && (!isDeepStrictEqual(expectedExecutor, tool.location)
      || !isDeepStrictEqual(expectedExecutor, candidate.manifest?.publication?.recipeExecutor))) {
    throw new Error("Publication executor differs from authorized frozen recipe");
  }
  const prior = JSON.parse(await readFile(path.join(executionRoot, "runner.json"), "utf8"));
  await writeFile(path.join(executionRoot, "runner.json"), `${JSON.stringify({ ...prior,
    schemaVersion: 1, pid: process.pid, status: "running", operationId, generation: generationNumber,
    targetId, candidate: candidateIdentity, tool: { name: tool.name, version: tool.version, sha256: tool.sha256 }, startedAt,
  }, null, 2)}\n`, "utf8");
  await tool.assertUnchanged();
  return recipe.executePublication({ operation, generation, candidate, dataDir, sourceRoot, runtimeRoot,
    executionRoot, targetId, tool }, releasePublicationPlatform());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReleaseRecipe().catch(error => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
}
