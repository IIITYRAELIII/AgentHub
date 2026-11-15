import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, link, symlink, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeScopedCaptureRetirement, withSealedRuntimeExecutor } from "../../../src/infrastructure/filesystem/sealed-runtime-executor.mjs";
import { inventoryNativeCapture } from "../../../src/infrastructure/filesystem/native-capture-inventory.mjs";
import { trustedWindowsPowerShellPath } from "../../../src/infrastructure/process/system-boot-identity.mjs";
import { captureRuntimeReleaseBinding } from "../../../src/infrastructure/filesystem/runtime-installation-custody.mjs";
import { retireSealedRuntimeRelease } from "../../../src/infrastructure/filesystem/sealed-runtime-release.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const actualSource = fileURLToPath(new URL("../../../src/infrastructure/filesystem/sealed-native-capture.cs", import.meta.url));
async function fixture(t, files = 130) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-producer-")), repository = path.join(root, "repository");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  for (let i = 0; i < files; i++) await writeFile(path.join(repository, String(i).padStart(3, "0") + ".dat"), "body:" + i);
  const plan = await inventoryNativeCapture(repository), planFile = path.join(root, "plan.json"), source = path.join(root, "native.cs");
  const bytes = Buffer.from(JSON.stringify(plan)); await writeFile(planFile, bytes); await writeFile(source, await readFile(actualSource));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });
  const run = partial => executeScopedCaptureRetirement(source, trustedWindowsPowerShellPath(process.env), {
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    AGENT_HUB_CAPTURE_SOURCE: source,
    AGENT_HUB_CAPTURE_INPUT: JSON.stringify({ root: repository, plan: planFile, sha256: digest(bytes), allowPartial: partial }),
  }, raw => JSON.parse(raw));
  return { root, repository, plan, planFile, source, run };
}

test("native capture producer releases invocation handles and refuses changed source bytes", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), starts = [], spawn = childProcess.spawn;
  const observed = t.mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args); if (args[2]?.env?.AGENT_HUB_CAPTURE_SOURCE === f.source) {
      const entry = { closed: false }; starts.push(entry); child.once("close", () => { entry.closed = true; });
    } return child;
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(withSealedRuntimeExecutor(async () => {
      const first = await f.run(false); assert.equal(first.status, "partial"); assert.equal(first.files, 64);
      await rename(f.repository, f.repository + "-moved"); await rename(f.repository + "-moved", f.repository);
      await writeFile(f.source, Buffer.concat([await readFile(f.source), Buffer.from("\n")]));
      await f.run(true);
    }), /producer-source-changed/u);
    assert.equal(starts.length, 1); assert.equal(starts[0].closed, true);
    assert.equal((await readdir(f.repository)).filter(name => name.endsWith(".dat")).length, 66);
  } finally { observed.mock.restore(); syncBuiltinESMExports(); }
});

test("shared finite scope joins capture and runtime protocols before switching resources", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), body = path.join(f.root, "runtime-body"), starts = [], spawn = childProcess.spawn;
  await mkdir(path.join(body, "assets"), { recursive: true });
  const bytes = Buffer.from("runtime fixture"); await writeFile(path.join(body, "assets/one.txt"), bytes);
  await writeFile(path.join(body, "runtime-manifest.json"), JSON.stringify({ releaseId: "fixture-runtime", directories: ["assets"],
    files: [{ path: "assets/one.txt", bytes: bytes.length, sha256: digest(bytes) }] }));
  const binding = await captureRuntimeReleaseBinding(body, "fixture-runtime");
  const observed = t.mock.method(childProcess, "spawn", (...args) => {
    if (args[2]?.env?.AGENT_HUB_CAPTURE_SOURCE || args[2]?.env?.AGENT_HUB_RUNTIME_RETIRE_SOURCE) {
      assert.ok(starts.every(entry => entry.closed), "Prior resource joins before the next producer starts");
      const child = spawn(...args), entry = { closed: false }; starts.push(entry); child.once("close", () => { entry.closed = true; }); return child;
    }
    return spawn(...args);
  }); syncBuiltinESMExports();
  try {
    await withSealedRuntimeExecutor(async () => {
      assert.equal((await f.run(false)).files, 64);
      assert.equal((await retireSealedRuntimeRelease(body, binding)).status, "complete");
      assert.equal((await f.run(true)).files, 64);
    });
    assert.equal(starts.length, 3); assert.ok(starts.every(entry => entry.closed));
    await assert.rejects(lstat(body), { code: "ENOENT" });
  } finally { observed.mock.restore(); syncBuiltinESMExports(); }
});

for (const hostile of ["foreign", "identity", "hash", "ads", "link", "reparse", "writer"]) {
  test("native capture producer preserves hostile " + hostile + " and blocks failed-binding restart", { skip: process.platform !== "win32" }, async t => {
    const f = await fixture(t, 2), target = path.join(f.repository, "000.dat"); let writer;
    if (hostile === "foreign") await writeFile(path.join(f.repository, "foreign.txt"), "retain foreign work");
    if (hostile === "identity") { const bytes = await readFile(target); await rename(target, path.join(f.root, "original.dat")); await writeFile(target, bytes); }
    if (hostile === "hash") {
      const plan = JSON.parse(await readFile(f.planFile)); plan.files.find(x => x.path === "000.dat").identity.sha256 = "0".repeat(64);
      const bytes = Buffer.from(JSON.stringify(plan)); await writeFile(f.planFile, bytes);
      f.run = partial => executeScopedCaptureRetirement(f.source, trustedWindowsPowerShellPath(process.env), {
        SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, AGENT_HUB_CAPTURE_SOURCE: f.source,
        AGENT_HUB_CAPTURE_INPUT: JSON.stringify({ root: f.repository, plan: f.planFile, sha256: digest(bytes), allowPartial: partial }),
      }, raw => JSON.parse(raw));
    }
    if (hostile === "ads") await writeFile(target + ":foreign", "retain stream");
    if (hostile === "link") await link(target, path.join(f.root, "outside-alias.dat"));
    if (hostile === "reparse") { const outside = path.join(f.root, "outside"); await mkdir(outside); await symlink(outside, path.join(f.repository, "redirect"), "junction"); }
    if (hostile === "writer") writer = await open(target, "r+");
    const starts = [], spawn = childProcess.spawn;
    const observed = t.mock.method(childProcess, "spawn", (...args) => {
      const child = spawn(...args); if (args[2]?.env?.AGENT_HUB_CAPTURE_SOURCE === f.source) {
        const entry = { closed: false }; starts.push(entry); child.once("close", () => { entry.closed = true; });
      } return child;
    }); syncBuiltinESMExports();
    try {
      await assert.rejects(withSealedRuntimeExecutor(async () => {
        const first = await f.run(false).catch(error => error);
        assert.ok(first instanceof Error, "Hostile input must refuse before unlink");
        assert.ok(first.nativeTelemetry?.native.nativeMs >= 0, "Native failure phase survives joined transport");
        assert.equal(first.nativeTelemetry.native.unlinkedFiles, 0);
        assert.equal(starts[0].closed, true, "Native failure joins before rejection");
        await assert.rejects(f.run(true)); assert.equal(starts.length, 1, "Failed binding cannot start another child");
      }));
      assert.equal(await readFile(target, "utf8"), "body:0");
      assert.equal(await readFile(path.join(f.repository, "001.dat"), "utf8"), "body:1");
      assert.equal(starts.length, 1); assert.equal(starts[0].closed, true);
    } finally { await writer?.close(); observed.mock.restore(); syncBuiltinESMExports(); }
  });
}
