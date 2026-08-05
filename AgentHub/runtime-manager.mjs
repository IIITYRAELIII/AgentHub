import process from "node:process";

import { isMainModule } from "./src/infrastructure/process/main-module.mjs";
import { main } from "./src/runtime/runtime-manager.mjs";

export * from "./src/runtime/runtime-manager.mjs";

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Runtime manager failed: ${error.message}`);
    process.exitCode = 1;
  });
}
