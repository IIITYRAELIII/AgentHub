import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { ReleaseOperationCommandService } from "../../src/application/release-operation-command-service.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { processIsAlive } from "../../src/infrastructure/process/process-liveness.mjs";

const fixture = JSON.parse(await readFile(process.argv[2], "utf8"));
const store = new ReleaseOperationStore({ dataDir: fixture.dataDir });
const finishStep = store.finishStep.bind(store);
store.finishStep = (receipt, outcome) => {
  const result = finishStep(receipt, outcome);
  if (receipt.stepId === "compose" && outcome.status === "applied") process.exit(86);
  return result;
};
const releaseOperations = new ReleaseOperationService({
  store,
  processAlive: processIsAlive,
  ownerId: "crash-worker",
  leaseMs: 100,
  compose: async () => fixture.generation,
  validate: async () => ({ status: "passed" }),
  publishTarget: async () => ({ status: "applied" }),
  readTarget: async () => ({ status: "not_applied" }),
  finalize: async () => ({ status: "completed" }),
});
const commands = new ReleaseOperationCommandService({
  releaseOperations,
  workspaceCatalog: {
    workspace: () => ({ id: fixture.workspaceId }),
    hierarchy: () => [{
      id: fixture.workspaceId,
      streams: [{ id: fixture.streamId, threads: [{ threadId: fixture.threadId }] }],
    }],
    activeThread: () => ({ threadId: fixture.threadId }),
  },
  taskBoard: {
    task: (taskId) => ({ id: taskId, workspaceId: fixture.workspaceId, streamId: fixture.streamId }),
  },
});
const ack = commands.start(fixture.request);
writeFileSync(fixture.ackFile, `${JSON.stringify(ack)}\n`, "utf8");
setInterval(() => {}, 1_000);
