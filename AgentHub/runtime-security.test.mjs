import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  protectRuntimeConfig,
  protectRuntimeDirectory,
  runtimeDirectoryAclArguments,
  runtimeSecretAclArguments,
} from "./runtime-security.mjs";

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

test("Windows runtime launcher verifies hashes without PowerShell modules", async () => {
  const launcher = await readFile(path.join(import.meta.dirname, "runtime-launch.ps1"), "utf8");
  assert.match(launcher, /Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(launcher, /Get-FileHash/);
});
