import process from "node:process";

import { isMainModule } from "./src/infrastructure/process/main-module.mjs";
import { withPublicationLock } from "./src/infrastructure/process/publication-lock.mjs";
import {
  assertCleanPublicationTree,
  assertCurrentPublicationRevision,
} from "./src/infrastructure/persistence/publication-state.mjs";
import { main } from "./src/runtime/runtime-manager.mjs";

export * from "./src/runtime/runtime-manager.mjs";

if (isMainModule(import.meta.url)) {
  const command = process.argv[2] ?? "status";
  const execute = async () => {
    if (command === "deploy") {
      const repositoryRoot = new URL("..", import.meta.url);
      await assertCleanPublicationTree({ cwd: repositoryRoot });
      await assertCurrentPublicationRevision({ cwd: repositoryRoot });
    }
    return main();
  };
  const operation = command === "status" ? execute() : withPublicationLock(execute);
  operation.catch((error) => {
    console.error(`Runtime manager failed: ${error.message}`);
    process.exitCode = 1;
  });
}
