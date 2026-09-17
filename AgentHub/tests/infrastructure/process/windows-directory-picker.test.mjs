import assert from "node:assert/strict";
import test from "node:test";

import {
  pickWindowsDirectory,
  windowsDirectoryPickerInternals,
} from "../../../src/infrastructure/process/windows-directory-picker.mjs";

test("Windows directory picker passes the initial path outside the PowerShell command line", async () => {
  let invocation = null;
  const result = await pickWindowsDirectory({
    initialPath: "D:\\projects\\Utilities",
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows", KEEP: "yes" },
    execFileImpl: (file, args, options, callback) => {
      invocation = { file, args, options };
      callback(null, "D:\\projects\\Utilities\\AgentHub", "");
    },
  });
  assert.deepEqual(result, { canceled: false, path: "D:\\projects\\Utilities\\AgentHub" });
  assert.equal(invocation.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(invocation.args.includes("D:\\projects\\Utilities"), false);
  assert.equal(
    invocation.options.env[windowsDirectoryPickerInternals.INITIAL_PATH_ENVIRONMENT_KEY],
    "D:\\projects\\Utilities",
  );
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, windowsDirectoryPickerInternals.PICKER_TIMEOUT_MS);
});

test("Windows directory picker treats an empty result as cancellation", async () => {
  const result = await pickWindowsDirectory({
    platform: "win32",
    execFileImpl: (_file, _args, _options, callback) => callback(null, "", ""),
  });
  assert.deepEqual(result, { canceled: true, path: "" });
});

test("Windows directory picker rejects non-Windows hosts and non-absolute results", async () => {
  await assert.rejects(pickWindowsDirectory({ platform: "linux" }), /только в Agent Hub для Windows/u);
  await assert.rejects(pickWindowsDirectory({
    platform: "win32",
    execFileImpl: (_file, _args, _options, callback) => callback(null, "relative\\folder", ""),
  }), /некорректный путь/u);
});
