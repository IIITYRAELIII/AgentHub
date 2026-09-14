import assert from "node:assert/strict";
import test from "node:test";

import { readTrustedSystemBootIdentity } from "../../../src/infrastructure/process/system-boot-identity.mjs";

test("trusted Windows boot identity comes from Win32_OperatingSystem", async () => {
  const calls = [];
  const result = await readTrustedSystemBootIdentity({
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    execFileImpl(executable, args, options, callback) {
      calls.push({ executable, args, options });
      callback(null, "2026-09-12T01:02:03.0000000Z\r\n");
    },
  });
  assert.deepEqual(result, {
    source: "Win32_OperatingSystem.LastBootUpTime",
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    bootTime: "2026-09-12T01:02:03.000Z",
  });
  assert.equal(calls[0].executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.match(calls[0].args.at(-1), /Win32_OperatingSystem/u);
  assert.equal(calls[0].options.windowsHide, true);
});

test("trusted boot identity fails closed outside Windows or on invalid output", async () => {
  await assert.rejects(readTrustedSystemBootIdentity({ platform: "linux" }), /only from Win32_OperatingSystem/u);
  await assert.rejects(readTrustedSystemBootIdentity({
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    execFileImpl: (_executable, _args, _options, callback) => callback(null, "not-a-date"),
  }), /invalid boot identity/u);
  await assert.rejects(readTrustedSystemBootIdentity({
    platform: "win32",
    environment: { SystemRoot: "..\\substituted" },
  }), /SystemRoot is unavailable/u);
  await assert.rejects(readTrustedSystemBootIdentity({
    platform: "win32",
    environment: { SystemRoot: "C:\\Repository\\Windows" },
  }), /SystemRoot is unavailable/u);
});
