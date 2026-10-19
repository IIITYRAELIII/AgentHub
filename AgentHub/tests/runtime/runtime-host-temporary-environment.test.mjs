import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildWindowsRuntimeHost } from "../../src/infrastructure/process/runtime-host-builder.mjs";

const execute = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-host-temp-"));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("runtime-host-temp-"));
    await rm(root, { recursive: true, force: true });
  });
  const physical = path.join(root, "physical"), logical = path.join(root, "logical");
  const releaseId = "temp-fixture", release = path.join(physical, "releases", releaseId);
  const ambient = path.join(root, "ambient-temp");
  await mkdir(release, { recursive: true });
  await mkdir(ambient);
  await symlink(physical, logical, "junction");
  const record = path.join(physical, "child.json");
  const body = `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const file=path.join(os.tmpdir(),'owned-child-write.txt'); fs.writeFileSync(file,'owned temporary bytes');
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({temp:os.tmpdir(),tmp:process.env.TMP,
root:process.env.AGENT_HUB_RUNTIME_ROOT,file,physicalFile:fs.realpathSync(file)}));`;
  const files = { "package.json": JSON.stringify({ type: "module", version: "2026.10.12" }), "agent-hub-main.mjs": body };
  const manifest = { releaseId, version: "2026.10.12", files: [] };
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(release, name), bytes);
    manifest.files.push({ path: name, bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(physical, "current.json"), JSON.stringify({ current: releaseId }));
  await writeFile(path.join(release, "runtime-manifest.json"), JSON.stringify(manifest));
  await buildWindowsRuntimeHost({ sourceRoot: path.resolve(import.meta.dirname, "../.."), outputFile: path.join(physical, "AgentHub.RuntimeHost.exe") });
  const run = () => execute(path.join(logical, "AgentHub.RuntimeHost.exe"), [], {
    windowsHide: true, timeout: 15_000, env: { ...process.env, TEMP: ambient, TMP: ambient },
  });
  return { root, physical, logical, ambient, record, run };
}

test("ordinary compiled Host scopes fresh-launch temporary writes through the logical root alias", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const f = await fixture(t), inherited = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  await f.run();
  const child = JSON.parse(await readFile(f.record, "utf8"));
  assert.equal(child.root, f.logical);
  assert.equal(child.temp, path.join(f.logical, "temp"));
  assert.equal(child.tmp, path.join(f.logical, "temp"));
  assert.equal(child.physicalFile, path.join(f.physical, "temp", "owned-child-write.txt"));
  assert.equal(await readFile(child.file, "utf8"), "owned temporary bytes");
  assert.deepEqual({ TEMP: process.env.TEMP, TMP: process.env.TMP }, inherited);
});

test("ordinary compiled Host refuses a substituted temporary directory before Node starts", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const f = await fixture(t), foreign = path.join(f.root, "foreign");
  await mkdir(foreign); await writeFile(path.join(foreign, "sentinel"), "preserve");
  await symlink(foreign, path.join(f.physical, "temp"), "junction");
  await assert.rejects(f.run());
  assert.match(await readFile(path.join(f.physical, "launcher-error.log"), "utf8"), /temporary directory.*reparse point/);
  await assert.rejects(readFile(f.record), { code: "ENOENT" });
  assert.equal(await readFile(path.join(foreign, "sentinel"), "utf8"), "preserve");
  await assert.rejects(readFile(path.join(foreign, "owned-child-write.txt")), { code: "ENOENT" });
});
