import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildWindowsIcon,
  buildWindowsRuntimeHost,
  windowsIconEntries,
} from "../../../src/infrastructure/process/runtime-host-builder.mjs";
import { verifyRuntimeManifest } from "../../../runtime-manifest-verifier.mjs";
import {
  protectRuntimeConfig,
  protectRuntimeDirectory,
  runtimeDirectoryAclArguments,
  runtimeSecretAclArguments,
} from "../../../src/infrastructure/filesystem/runtime-security.mjs";

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

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

test("runtime launchers verify the manifest on every platform", async () => {
  const launcher = await readFile(
    path.join(ROOT, "RuntimeHost", "AgentHub.RuntimeHost.cs"),
    "utf8",
  );
  const unixLauncher = await readFile(path.join(ROOT, "runtime-launch.sh"), "utf8");
  const verifier = await readFile(
    path.join(ROOT, "src", "infrastructure", "filesystem", "runtime-manifest-verifier.mjs"),
    "utf8",
  );
  assert.match(launcher, /VerifyManifest/);
  assert.match(unixLauncher, /runtime-manifest-verifier\.mjs/);
  assert.match(launcher, /agent-hub-main\.mjs/);
  assert.match(unixLauncher, /agent-hub-main\.mjs/);
  assert.match(verifier, /createHash\("sha256"\)/);
  assert.match(launcher, /SHA256\.Create/);
  assert.match(launcher, /AssemblyTitle\("Agent Hub Server"\)/u);
  assert.match(launcher, /SetCurrentProcessExplicitAppUserModelID/u);
  assert.match(launcher, /CreateJobObject/u);
  assert.match(launcher, /AssignProcessToJobObject/u);
});

test("RuntimeHost icon provides native layers for Windows task sizes", async (t) => {
  if (process.platform !== "win32") return t.skip("RuntimeHost icon builder runs on Windows only");
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-icon-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputFile = path.join(directory, "AgentHub.RuntimeHost.ico");
  await buildWindowsIcon({ sourceRoot: ROOT, outputFile });
  const icon = await readFile(outputFile);
  const entries = windowsIconEntries(icon);
  assert.deepEqual(entries.map(({ width }) => width), [16, 20, 24, 32, 48, 64, 128, 256]);
  assert.deepEqual(entries.map(({ height }) => height), [16, 20, 24, 32, 48, 64, 128, 256]);
  assert.ok(entries.every(({ bitsPerPixel }) => bitsPerPixel === 32));
  for (const entry of entries) {
    const png = icon.subarray(entry.offset, entry.offset + entry.bytes);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), entry.width);
    assert.equal(png.readUInt32BE(20), entry.height);
  }
  const builder = await readFile(path.join(ROOT, "RuntimeHost", "AgentHub.IconBuilder.cs"), "utf8");
  assert.match(builder, /CreateCompactBlade/u);
  assert.match(builder, /RotateAt\(angle, center\)/u);
  assert.doesNotMatch(builder, /FillCircle|DrawEllipse|DrawLine\(spoke/u);
});

test("runtime launchers reject dot releases and resolve the release only inside releases", async () => {
  const launcher = await readFile(
    path.join(ROOT, "RuntimeHost", "AgentHub.RuntimeHost.cs"),
    "utf8",
  );
  const unixLauncher = await readFile(path.join(ROOT, "runtime-launch.sh"), "utf8");

  assert.match(launcher, /current == "\." \|\| current == "\.\."/);
  assert.match(launcher, /releaseRoot\.StartsWith\(releasePrefix, StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(launcher, /ReparsePoint/);
  assert.match(unixLauncher, /current==='\.'\|\|current==='\.\.'/);
  assert.match(unixLauncher, /fs\.realpathSync\(path\.resolve\(releases,process\.argv\[2\]\)\)/);
  assert.match(unixLauncher, /release\.startsWith\(prefix\)/);
});

test("Windows RuntimeHost fails closed for current '..' and path escapes", async (t) => {
  if (process.platform !== "win32") return t.skip("RuntimeHost test runs on Windows only");
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-launcher-"));
  const launcherPath = path.join(runtimeRoot, "AgentHub.RuntimeHost.exe");
  await buildWindowsRuntimeHost({ sourceRoot: ROOT, outputFile: launcherPath });

  for (const current of ["..", "../outside", "C:\\outside"]) {
    await writeFile(path.join(runtimeRoot, "current.json"), JSON.stringify({ current }), "utf8");
    await assert.rejects(execFile(launcherPath, ["--check"]));
  }
  assert.match(
    await readFile(path.join(runtimeRoot, "launcher-error.log"), "utf8"),
    /Agent Hub has no valid current runtime release/,
  );
});

test("Windows production launch path contains no script-host or policy bypass", async () => {
  const files = ["src/runtime/runtime-restart.mjs", "install.py", "start.ps1"];
  const combined = (await Promise.all(files.map((file) => (
    readFile(path.join(ROOT, file), "utf8")
  )))).join("\n");
  assert.doesNotMatch(combined, /wscript\.exe/iu);
  assert.doesNotMatch(combined, /ExecutionPolicy\s+Bypass/iu);
  assert.doesNotMatch(combined, /WindowStyle\s+Hidden\s+-ExecutionPolicy/iu);
  const runtimeHost = await readFile(
    path.join(ROOT, "RuntimeHost", "AgentHub.RuntimeHost.cs"),
    "utf8",
  );
  assert.match(runtimeHost, /InvokeMember\("Arguments"[\s\S]+String\.Empty/u);
});

test("Windows RuntimeHost verifies, launches and retires legacy scripts", async (t) => {
  if (process.platform !== "win32") return t.skip("RuntimeHost test runs on Windows only");
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-host-"));
  const releaseId = "release-1";
  const releaseRoot = path.join(runtimeRoot, "releases", releaseId);
  await mkdir(releaseRoot, { recursive: true });
  const server = "process.exit(0);\n";
  const packageContents = `${JSON.stringify({ name: "agent-hub", version: "2026.8.23" })}\n`;
  await writeFile(path.join(releaseRoot, "agent-hub-main.mjs"), server, "utf8");
  await writeFile(path.join(releaseRoot, "package.json"), packageContents, "utf8");
  await writeFile(path.join(releaseRoot, "runtime-manifest.json"), JSON.stringify({
    releaseId,
    version: "2026.8.23",
    files: [
      {
        path: "agent-hub-main.mjs",
        bytes: Buffer.byteLength(server),
        sha256: createHash("sha256").update(server).digest("hex"),
      },
      {
        path: "package.json",
        bytes: Buffer.byteLength(packageContents),
        sha256: createHash("sha256").update(packageContents).digest("hex"),
      },
    ],
  }), "utf8");
  await writeFile(path.join(runtimeRoot, "current.json"), JSON.stringify({ current: releaseId }), "utf8");
  for (const legacy of ["launch.vbs", "runtime-launch.vbs", "launch.ps1"]) {
    await writeFile(path.join(runtimeRoot, legacy), "legacy\n", "utf8");
  }
  const launcher = path.join(runtimeRoot, "AgentHub.RuntimeHost.exe");
  await buildWindowsRuntimeHost({ sourceRoot: ROOT, outputFile: launcher });
  await execFile(launcher, []);
  for (const legacy of ["launch.vbs", "runtime-launch.vbs", "launch.ps1"]) {
    await assert.rejects(readFile(path.join(runtimeRoot, legacy)), /ENOENT/u);
  }

  await writeFile(path.join(releaseRoot, "agent-hub-main.mjs"), "tampered\n", "utf8");
  await assert.rejects(execFile(launcher, ["--check"]));
  assert.match(await readFile(path.join(runtimeRoot, "launcher-error.log"), "utf8"), /size mismatch|hash mismatch/u);
});

test("shared runtime manifest verifier rejects a modified release file", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-manifest-"));
  const contents = "export const verified = true;\n";
  const packageContents = `${JSON.stringify({ name: "agent-hub", version: "2026.8.23" })}\n`;
  await writeFile(path.join(releaseRoot, "agent-hub-server.mjs"), contents, "utf8");
  await writeFile(path.join(releaseRoot, "package.json"), packageContents, "utf8");
  const manifest = {
    releaseId: "release-1",
    version: "2026.8.23",
    releaseVersion: "2026.8.23.1",
    files: [
      {
        path: "agent-hub-server.mjs",
        bytes: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
      {
        path: "package.json",
        bytes: Buffer.byteLength(packageContents),
        sha256: createHash("sha256").update(packageContents).digest("hex"),
      },
    ],
  };
  await writeFile(path.join(releaseRoot, "runtime-manifest.json"), JSON.stringify(manifest), "utf8");
  await verifyRuntimeManifest(releaseRoot, "release-1");
  await writeFile(
    path.join(releaseRoot, "runtime-manifest.json"),
    JSON.stringify({ ...manifest, version: "2026.8.24" }),
    "utf8",
  );
  await assert.rejects(verifyRuntimeManifest(releaseRoot, "release-1"), /version does not match/u);
  await writeFile(
    path.join(releaseRoot, "runtime-manifest.json"),
    JSON.stringify({ ...manifest, releaseVersion: "2026.8.24.1" }),
    "utf8",
  );
  await assert.rejects(verifyRuntimeManifest(releaseRoot, "release-1"), /invalid release version/u);
  await writeFile(path.join(releaseRoot, "runtime-manifest.json"), JSON.stringify(manifest), "utf8");
  await writeFile(path.join(releaseRoot, "agent-hub-server.mjs"), "tampered\n", "utf8");
  await assert.rejects(verifyRuntimeManifest(releaseRoot, "release-1"), /size mismatch|hash mismatch/);
});
