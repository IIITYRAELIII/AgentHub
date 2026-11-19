import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const source = path.resolve(import.meta.dirname, "../..");
const sha = body => createHash("sha256").update(body).digest("hex");

async function toolFixture(t, bodies) {
  const root = await mkdtemp(path.join(os.tmpdir(), "package-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  bodies = { "package.json": '{"name":"fixture-build-tools","version":"1.0.0","type":"module"}', ...bodies };
  for (const [relative, body] of Object.entries(bodies)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), body);
  }
  const records = Object.keys(bodies).sort().map(file => ({ path: file, bytes: Buffer.byteLength(bodies[file]), sha256: sha(bodies[file]) }));
  await writeFile(path.join(root, "export-manifest.json"), JSON.stringify({ apiVersion: 1, files: Object.keys(bodies) }));
  return { ...process.env, AGENT_HUB_RELEASE_TOOLS_ROOT: root,
    AGENT_HUB_RELEASE_TOOLS_SHA256: sha(JSON.stringify(records)) };
}

test("extension maintenance uses only its pinned independent Python installer and preserves explicit input", async t => {
  const env = await toolFixture(t, { "python/vscode_extension.py":
    'import json,sys\nv=json.load(sys.stdin)\nprint(json.dumps({"result":v}))\n' });
  // The fixture is an inert external installer, not a Hub API or release owner.
  const { spawn } = await import("node:child_process");
  const run = (action, values, childEnv = env) => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(source, "extension-maintenance.mjs"), action],
      { env: childEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.stdin.end(JSON.stringify(values));
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  for (const action of ["extension-install", "extension-remove"]) {
    const output = await run(action, { profile: "test-contour", source_revision: "a".repeat(40) });
    assert.equal(output.code, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout).result, { action, profile: "test-contour",
      source_revision: "a".repeat(40), sourceRoot: source });
  }
  const drift = await run("extension-install", {}, { ...env, AGENT_HUB_RELEASE_TOOLS_SHA256: "0".repeat(64) });
  assert.notEqual(drift.code, 0); assert.equal(drift.stdout, "");
  assert.match(drift.stderr, /differs from its pinned version/u);
  const foreign = await run("release-run", {});
  assert.notEqual(foreign.code, 0); assert.equal(foreign.stdout, "");
  assert.match(foreign.stderr, /Unknown extension action/u);
});

test("Android development entry invokes only the independent pinned compiler with explicit source and arguments", async t => {
  const env = await toolFixture(t, { "src/android-build.ps1":
    'param([string]$SourceRoot,[string]$Configuration)\n@{sourceRoot=$SourceRoot;configuration=$Configuration}|ConvertTo-Json -Compress\n' });
  const output = await execute(process.execPath, [path.join(source, "android-build.mjs"), "-Configuration", "Debug"],
    { env, windowsHide: true, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output.stdout), { sourceRoot: source, configuration: "Debug" });
  assert.equal(output.stderr, "");
});
