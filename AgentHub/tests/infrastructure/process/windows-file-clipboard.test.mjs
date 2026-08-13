import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { copyWindowsFileObject } from "../../../src/infrastructure/process/windows-file-clipboard.mjs";

test("Windows file clipboard uses a hidden STA PowerShell process", async () => {
  let invocation;
  await copyWindowsFileObject("result.cfe", {
    platform: "win32",
    execFileImpl: (file, args, options, callback) => {
      invocation = { file, args, options };
      callback(null);
    },
  });
  assert.equal(invocation.file, "powershell.exe");
  assert.ok(invocation.args.includes("-STA"));
  assert.ok(invocation.args.includes("-EncodedCommand"));
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.AGENT_HUB_CLIPBOARD_FILE, path.resolve("result.cfe"));
});

test("file clipboard rejects unsupported platforms", () => {
  assert.throws(
    () => copyWindowsFileObject("result.cfe", { platform: "linux" }),
    /только в Windows/u,
  );
});
