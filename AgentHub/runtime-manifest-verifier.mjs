import path from "node:path";
import process from "node:process";

import { verifyRuntimeManifest } from "./src/infrastructure/filesystem/runtime-manifest-verifier.mjs";

export * from "./src/infrastructure/filesystem/runtime-manifest-verifier.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [releaseRoot, releaseId] = process.argv.slice(2);
  verifyRuntimeManifest(releaseRoot, releaseId).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
