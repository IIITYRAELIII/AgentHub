import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { verifyRuntimeManifest } from "./runtime-manifest-verifier.mjs";
import {
  protectRuntimeConfig,
  protectRuntimeDirectory,
  runtimeDirectoryAclArguments,
  runtimeSecretAclArguments,
} from "./runtime-security.mjs";

const execFile = promisify(execFileCallback);

test("runtime config ACL keeps only its owner and system administrators", async () => {
  const args = runtimeSecretAclArguments("C:\\runtime\\config.json", {
    USERDOMAIN: "DESKTOP",
    USERNAME: "owner",
  });
  assert.deepEqual(args, [
    "C:\\runtime\\config.json",
    "/inheritance:r",
    "/grant:r",
    "DESKTOP\\owner:(F)",
    "*S-1-5-18:(F)",
    "*S-1-5-32-544:(F)",
  ]);
  assert.equal(args.some((item) => item.includes("CodexSandboxUsers")), false);

  const calls = [];
  await protectRuntimeConfig("C:\\runtime\\config.json", {
    platform: "win32",
    environment: { USERDOMAIN: "DESKTOP", USERNAME: "owner" },
    runCommand: async (...call) => calls.push(call),
  });
  assert.equal(calls[0][0], "icacls.exe");
});

test("test runtime can explicitly keep its temporary ACL unchanged", async () => {
  const calls = [];
  await protectRuntimeConfig("C:\\runtime\\config.json", {
    platform: "win32",
    environment: { AGENT_HUB_DISABLE_SECRET_ACL: "1" },
    runCommand: async (...call) => calls.push(call),
  });
  await protectRuntimeDirectory("C:\\runtime\\releases", {
    platform: "win32",
    environment: { AGENT_HUB_DISABLE_SECRET_ACL: "1" },
    runCommand: async (...call) => calls.push(call),
  });
  assert.deepEqual(calls, []);
});

test("runtime control directories deny inherited sandbox modification", async () => {
  const args = runtimeDirectoryAclArguments("C:\\runtime\\releases", {
    USERDOMAIN: "DESKTOP",
    USERNAME: "owner",
  });
  assert.deepEqual(args, [
    "C:\\runtime\\releases",
    "/inheritance:r",
    "/grant:r",
    "DESKTOP\\owner:(OI)(CI)(F)",
    "*S-1-5-18:(OI)(CI)(F)",
    "*S-1-5-32-544:(OI)(CI)(F)",
  ]);
  assert.equal(args.some((item) => item.includes("CodexSandboxUsers")), false);
  const calls = [];
  await protectRuntimeDirectory("C:\\runtime\\releases", {
    platform: "win32",
    environment: { USERDOMAIN: "DESKTOP", USERNAME: "owner" },
    runCommand: async (...call) => calls.push(call),
  });
  assert.equal(calls[0][0], "icacls.exe");
});

test("runtime launchers use the shared manifest verifier on every platform", async () => {
  const launcher = await readFile(path.join(import.meta.dirname, "runtime-launch.ps1"), "utf8");
  const unixLauncher = await readFile(path.join(import.meta.dirname, "runtime-launch.sh"), "utf8");
  const verifier = await readFile(path.join(import.meta.dirname, "runtime-manifest-verifier.mjs"), "utf8");
  assert.match(launcher, /runtime-manifest-verifier\.mjs/);
  assert.match(unixLauncher, /runtime-manifest-verifier\.mjs/);
  assert.match(verifier, /createHash\("sha256"\)/);
  assert.doesNotMatch(launcher, /Get-FileHash/);
});

test("runtime launchers reject dot releases and resolve the release only inside releases", async () => {
  const launcher = await readFile(path.join(import.meta.dirname, "runtime-launch.ps1"), "utf8");
  const unixLauncher = await readFile(path.join(import.meta.dirname, "runtime-launch.sh"), "utf8");

  assert.match(launcher, /\$Current -in @\('\.', '\.\.'\)/);
  assert.match(launcher, /\$ReleaseRoot\.StartsWith\(\$ReleasePrefix, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(launcher, /ReparsePoint/);
  assert.match(unixLauncher, /current==='\.'\|\|current==='\.\.'/);
  assert.match(unixLauncher, /fs\.realpathSync\(path\.resolve\(releases,process\.argv\[2\]\)\)/);
  assert.match(unixLauncher, /release\.startsWith\(prefix\)/);
});

test("PowerShell launcher fails closed for current '..' and path escapes", async (t) => {
  if (process.platform !== "win32") return t.skip("PowerShell launcher test runs on Windows only");
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-launcher-"));
  const launcher = await readFile(path.join(import.meta.dirname, "runtime-launch.ps1"), "utf8");
  const launcherPath = path.join(runtimeRoot, "runtime-launch.ps1");
  await writeFile(launcherPath, launcher, "utf8");

  for (const current of ["..", "../outside", "C:\\outside"]) {
    await writeFile(path.join(runtimeRoot, "current.json"), JSON.stringify({ current }), "utf8");
    await assert.rejects(
      execFile("pwsh", ["-NoProfile", "-File", launcherPath]),
      /Agent Hub has no valid current runtime release/,
    );
  }
});

test("shared runtime manifest verifier rejects a modified release file", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manifest-"));
  const contents = "export const verified = true;\n";
  await writeFile(path.join(releaseRoot, "agent-hub-server.mjs"), contents, "utf8");
  await writeFile(path.join(releaseRoot, "runtime-manifest.json"), JSON.stringify({
    releaseId: "release-1",
    files: [{
      path: "agent-hub-server.mjs",
      bytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    }],
  }), "utf8");
  await verifyRuntimeManifest(releaseRoot, "release-1");
  await writeFile(path.join(releaseRoot, "agent-hub-server.mjs"), "tampered\n", "utf8");
  await assert.rejects(verifyRuntimeManifest(releaseRoot, "release-1"), /size mismatch|hash mismatch/);
});
