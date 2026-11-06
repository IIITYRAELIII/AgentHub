import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPinnedCandidate } from "../src/build.mjs";
const run = promisify(execFile);

test("build invokes only the pinned candidate public builder and preserves source", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-tool-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate"); await mkdir(path.join(candidate, "AgentHub"), { recursive: true });
  const builder = path.join(candidate, "AgentHub/build-runtime.mjs");
  const source = "process.stdout.write(JSON.stringify({argv:process.argv.slice(2), prepared:true}));\n";
  await writeFile(builder, source);
  const git = async (...args) => (await run("git", ["-C", candidate, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim();
  await git("init", "-b", "main"); await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "tiny public build interface");
  const commit = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}");
  const result = await buildPinnedCandidate({ candidate, commit, runtimeRoot: path.join(root, "output"),
    releaseId: "original-body", artifactVersion: "2.1.5+build.123" });
  assert.deepEqual(result.candidate, { commit, tree });
  assert.equal(result.prepared.prepared, true);
  assert.deepEqual(result.prepared.argv, ["--runtime-root", path.join(root, "output"), "--release-id", "original-body",
    "--source-commit", commit, "--artifact-version", "2.1.5+build.123"]);
  assert.equal(await readFile(builder, "utf8"), source);
  await assert.rejects(buildPinnedCandidate({ candidate, commit: "0".repeat(40) }), /candidate changed/);
  await writeFile(builder, source + "// useful WIP\n");
  await assert.rejects(buildPinnedCandidate({ candidate, commit }), /candidate changed or is dirty/);
  assert.match(await readFile(builder, "utf8"), /useful WIP/);
});
