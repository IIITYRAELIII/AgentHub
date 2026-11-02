// Private full-application artifacts. No publication or installed pointer write.
import assert from "node:assert/strict";
import { cp, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareRuntime } from "../src/runtime/runtime-manager.mjs";
import { verifyRuntimeManifest } from "../src/infrastructure/filesystem/runtime-manifest-verifier.mjs";
const [sourceRoot, dependencies, output, revision] = process.argv.slice(2).map((value, i) => i === 3 ? value : path.resolve(value));
const builds = process.argv[6] ? process.argv[6].split(",").map(Number) : [40000001, 40000002];
assert.ok(builds.length === 2 && builds.every(value => Number.isSafeInteger(value) && value > 0));
if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) throw Error("Exact private candidate revision required");
assert.equal((await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, windowsHide: true })).stdout.trim(), revision);
assert.equal((await promisify(execFile)("git", ["status", "--porcelain"], { cwd: sourceRoot, windowsHide: true })).stdout, "");
const lock = async root => {
  const value = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  delete value.version; delete value.packages[""].version; return value;
};
assert.deepEqual(await lock(sourceRoot), await lock(dependencies));
const manifest = JSON.parse(await readFile(path.join(dependencies, "runtime-manifest.json"), "utf8"));
await verifyRuntimeManifest(dependencies, manifest.releaseId);
const version = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8")).version;
await mkdir(output, { recursive: true });
const artifacts = [];
for (const [index, name] of [[1, "previous"], [2, "candidate"]]) {
  const runtimeRoot = path.join(output, `build-${name}`), releaseId = `isolated-whole-${name}-${revision.slice(0, 10)}`;
  const existing = path.join(runtimeRoot, "releases", releaseId);
  let result;
  try { await verifyRuntimeManifest(existing, releaseId); result = { releaseRoot: existing, reused: true }; }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    result = await prepareRuntime({ sourceRoot, runtimeRoot, releaseId, publicationRevision: revision,
      expectedReleaseVersion: `${version}+build.${builds[index - 1]}`,
      installProductionDependencies: staging => cp(path.join(dependencies, "node_modules"), path.join(staging, "node_modules"), { recursive: true, errorOnExist: true, force: false }) });
  }
  artifacts.push({ ...result, releaseId });
}
await writeFile(path.join(output, "artifacts.json"), JSON.stringify({ revision, sourceRoot, dependenciesManifest: manifest.releaseId, artifacts }, null, 2));
console.log(JSON.stringify(artifacts));
