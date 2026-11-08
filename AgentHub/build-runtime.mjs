import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRuntime } from "./src/runtime/runtime-manager.mjs";

// Minimal application-owned self-build interface. No Task service, publication,
// install, activation, provider process or workflow state is opened here.
export async function buildRuntime(args, { prepare = prepareRuntime } = {}) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--runtime-root", "--release-id", "--source-commit", "--artifact-version"].includes(args[i])
      || !args[i + 1] || Object.hasOwn(options, args[i])) throw new Error("Invalid self-build argument");
    options[args[i]] = args[i + 1];
  }
  if (Object.keys(options).length !== 4) throw new Error("Self-build requires runtime-root, release-id, source-commit and artifact-version");
  return prepare({ sourceRoot: import.meta.dirname, runtimeRoot: path.resolve(options["--runtime-root"]),
    releaseId: options["--release-id"], publicationRevision: options["--source-commit"],
    expectedReleaseVersion: options["--artifact-version"] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRuntime(process.argv.slice(2)).then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => {
    process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1;
  });
}
