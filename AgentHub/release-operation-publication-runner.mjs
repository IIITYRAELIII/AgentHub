import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publishChanged } from "./publish-changed.mjs";
import { runStep } from "./publish-all.mjs";
import { defaultRuntimeRoot } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { installPreparedRuntime, prepareRuntime, verifyInstalledRuntime } from "./src/runtime/runtime-manager.mjs";
import { createFrozenReleasePublication } from "./src/infrastructure/process/frozen-release-publication.mjs";
import { createPublicationArtifactSteps } from "./src/infrastructure/process/publication-artifacts.mjs";
import { publicationCheckpointStore } from "./src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "./src/infrastructure/persistence/publication-run-store.mjs";
import { ReleaseOperationStore } from "./src/infrastructure/persistence/release-operation-store.mjs";

function requiredEnvironment(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function releaseOperationPublicationArguments({ operation, candidate, saved } = {}) {
  return [
    ...(saved && !["published", "succeeded"].includes(saved.status) ? ["--resume"] : []),
    "--workspace", operation.workspaceId,
    "--stream", operation.streamId,
    "--thread", operation.threadId,
    "--from", candidate.baseCommit,
    operation.authorization.validationMode === "full" ? "--full-tests"
      : operation.authorization.validationMode === "quick" ? "--quick" : "--validation=focused",
  ];
}

export function releaseOperationRuntimePublicationInput({ operation, generation, candidate } = {}) {
  const publication = candidate?.manifest?.publication;
  // Original generations without this field keep their original executor
  // identity; introducing a receipt must never retarget an admitted effect.
  if (publication?.runtimeReleaseVersion === undefined) return null;
  if (generation?.operationId !== operation?.operationId
    || publication.head !== candidate.commit
    || typeof publication.releaseVersion !== "string"
    || typeof publication.runtimeReleaseVersion !== "string"
    || !/^\d+(?:\.\d+){2}$/u.test(publication.releaseVersion)
    || !publication.runtimeReleaseVersion.startsWith(`${publication.releaseVersion}.`)
    || !/^[1-9]\d*$/u.test(publication.runtimeReleaseVersion.slice(publication.releaseVersion.length + 1))) {
    throw new Error("Frozen runtime publication binding differs from the candidate generation");
  }
  return {
    operationId: operation.operationId, generation: generation.generation,
    sourceCommit: candidate.commit, version: publication.runtimeReleaseVersion,
  };
}

async function run() {
  const dataDir = requiredEnvironment("AGENT_HUB_DATA_DIR");
  const operationId = requiredEnvironment("AGENT_HUB_RELEASE_OPERATION_ID");
  const generationNumber = Number(requiredEnvironment("AGENT_HUB_RELEASE_GENERATION"));
  const targetId = requiredEnvironment("AGENT_HUB_RELEASE_TARGET_ID");
  const executionRoot = path.resolve(requiredEnvironment("AGENT_HUB_RELEASE_EXECUTION_ROOT"));
  const startedAt = requiredEnvironment("AGENT_HUB_RELEASE_RUNNER_STARTED_AT");
  const candidateIdentity = requiredEnvironment("AGENT_HUB_RELEASE_CANDIDATE_IDENTITY");
  const runtimeRoot = path.resolve(process.env.AGENT_HUB_RUNTIME_ROOT || defaultRuntimeRoot());
  const repositoryRoot = path.resolve(process.cwd(), "..");
  await writeFile(path.join(executionRoot, "runner.json"), `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    status: "running",
    operationId,
    generation: generationNumber,
    targetId,
    candidate: candidateIdentity,
    startedAt,
  }, null, 2)}\n`, "utf8");
  const store = new ReleaseOperationStore({ dataDir });
  const operation = store.get(operationId);
  const generation = store.generation(operationId, generationNumber);
  if (!operation || !generation) throw new Error("release operation generation was not found");
  if (generation.identitySha256 !== candidateIdentity) throw new Error("release operation generation identity changed");
  const candidate = generation.candidates.find((item) => path.resolve(item.releaseRoot) === repositoryRoot);
  if (!candidate) throw new Error("publication runner checkout does not match the immutable generation");
  const readPlan = async () => ({
    revision: candidate.planRevision,
    candidates: generation.selectedResults.map((result) => ({
      id: result.taskId,
      gitReferences: [{ projectRoot: candidate.repositoryRoot, resultCommit: result.resultCommit }],
    })),
  });
  const adapter = createFrozenReleasePublication({
    repositoryRoot,
    runtimeRoot,
    workspaceId: operation.workspaceId,
    readPlan,
  });
  const journal = publicationRunStore({ runtimeRoot: executionRoot });
  const checkpoint = publicationCheckpointStore(path.join(executionRoot, "publication-checkpoint.json"));
  const artifacts = createPublicationArtifactSteps({
    sourceRoot: process.cwd(), runtimeRoot, journal, run: runStep,
    prepareRuntimeImpl: prepareRuntime,
    installRuntimeImpl: installPreparedRuntime,
    verifyRuntimeImpl: verifyInstalledRuntime,
    runtimePublication: releaseOperationRuntimePublicationInput({ operation, generation, candidate }),
  });
  const saved = await journal.read();
  const args = releaseOperationPublicationArguments({ operation, candidate, saved });
  const result = await publishChanged(args, {
    runtimeRoot,
    checkpoint,
    journal,
    preparePublication: adapter.prepare,
    publishGit: adapter.publishGit,
    finalizePublication: async () => ({ status: "completed", delegated: true }),
    prepareArtifactSteps: artifacts.steps,
    verifyArtifacts: artifacts.verify,
    repositoryRoot,
  });
  const publication = await journal.read();
  const effect = {
    schemaVersion: 1,
    status: ["published", "succeeded"].includes(result.status) ? "applied" : "partial",
    operationId,
    generation: generationNumber,
    targetId,
    candidate: generation.identitySha256,
    revision: candidate.commit,
    publicationStatus: result.status,
    publicationRunId: publication?.runId ?? null,
    completedAt: new Date().toISOString(),
  };
  await writeFile(path.join(executionRoot, "result.json"), `${JSON.stringify(effect, null, 2)}\n`, "utf8");
  if (effect.status !== "applied") throw new Error(`publication stopped in ${result.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
}
