import assert from "node:assert/strict";
import test from "node:test";
import { protectRuntimeConfig, runtimeSecretAclArguments } from "./runtime-security.mjs";

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
