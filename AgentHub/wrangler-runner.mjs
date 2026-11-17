// Development compatibility entry; dependency discovery and execution are external.
import { readReleaseToolPackage } from "./src/infrastructure/process/release-tool-package.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const tool = await readReleaseToolPackage();
const external = await tool.module("src/agent-hub/wrangler-runner.mjs");
export const { WranglerDependencyError, detectGitCommonDirectory, resolveWrangler, ensureWrangler, runWrangler } =
  { ...external,
    detectGitCommonDirectory: root => external.detectGitCommonDirectory(root ?? import.meta.dirname),
    resolveWrangler: options => external.resolveWrangler({ root: import.meta.dirname, ...options }),
    ensureWrangler: options => external.ensureWrangler({ root: import.meta.dirname, ...options }),
    runWrangler: (args, options) => external.runWrangler(args, { root: import.meta.dirname, ...options }) };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWrangler(process.argv.slice(2));
