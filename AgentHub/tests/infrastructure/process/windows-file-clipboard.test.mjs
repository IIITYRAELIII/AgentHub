import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import {
  copyWindowsFileObject,
  revealWindowsFile,
} from "../../../src/infrastructure/process/windows-file-clipboard.mjs";

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

test("Windows Explorer reveals the exact file without a shell command", async () => {
  let invocation;
  const reveal = revealWindowsFile("file with spaces.txt", {
    platform: "win32",
    existsSyncImpl: () => true,
    spawnImpl: (file, args, options) => {
      const child = new EventEmitter();
      child.unref = () => {};
      invocation = { file, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await reveal;
  assert.equal(invocation.file, "explorer.exe");
  assert.deepEqual(invocation.args, [`/select,${path.resolve("file with spaces.txt")}`]);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.stdio, "ignore");
});

test("Windows Explorer reveal resolves after launch without treating process exit as result", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const reveal = revealWindowsFile("бит_Документооборот.cfe", {
    platform: "win32",
    existsSyncImpl: () => true,
    spawnImpl: () => child,
  });
  child.emit("spawn");
  child.emit("exit", 1);
  await reveal;
});

test("Windows Explorer reveal rejects missing files before launching Explorer", async () => {
  let launched = false;
  assert.throws(
    () => revealWindowsFile("missing.cfe", {
      platform: "win32",
      existsSyncImpl: () => false,
      spawnImpl: () => {
        launched = true;
        return new EventEmitter();
      },
    }),
    /Файл не найден/u,
  );
  assert.equal(launched, false);
});

test("file reveal rejects unsupported platforms", () => {
  assert.throws(
    () => revealWindowsFile("result.cfe", { platform: "linux" }),
    /только в Windows/u,
  );
});
