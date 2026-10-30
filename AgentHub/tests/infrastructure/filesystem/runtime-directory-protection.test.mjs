import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { hasRuntimeDirectoryProtection, protectRuntimeDirectory } from "../../../src/infrastructure/filesystem/runtime-security.mjs";

const execute = promisify(execFile);
test("unknown directory ACL applies the existing protection and preserves its failure", async () => {
  for (const known of [false, true]) {
    const calls = [];
    await protectRuntimeDirectory("owned fixture", { platform: "win32", environment: { USERNAME: "owner" },
      inspectDirectory: async () => known, runCommand: async (...args) => calls.push(args) });
    assert.equal(calls.length, known ? 0 : 1);
    if (!known) assert.equal(calls[0][0], "icacls.exe");
  }
  const cause = new Error("exact ACL apply failure");
  await assert.rejects(protectRuntimeDirectory("owned fixture", { platform: "win32", environment: { USERNAME: "owner" },
    inspectDirectory: async () => false, runCommand: async () => { throw cause; } }), (error) => error === cause);
});

test("actual protected directory skips repeated ACL propagation while new children retain inheritance", {
  skip: process.platform !== "win32", timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-directory-acl-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  let applications = 0;
  const runCommand = async (command, args) => { applications++; await execute(command, args, { windowsHide: true, encoding: "utf8" }); };
  const started = performance.now();
  await protectRuntimeDirectory(root, { runCommand });
  const firstMs = performance.now() - started;
  assert.equal(await hasRuntimeDirectoryProtection(root), true);
  const repeatStart = performance.now(), prior = applications;
  await protectRuntimeDirectory(root, { runCommand });
  const repeatMs = performance.now() - repeatStart;
  assert.equal(applications, prior, "exact current ACL must avoid another propagating mutation");
  const child = path.join(root, "new-directory"); await mkdir(child); await writeFile(path.join(child, "new.txt"), "owned fixture");
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const inherited = await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
    $file=[System.IO.File]::GetAccessControl($env:HUB_ACL_CHILD)
    $rules=@($file.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
    if($rules.Count -ne 3){throw 'child inheritance count differs'}
    foreach($rule in $rules){if(-not $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'child inheritance differs'}}
    [Console]::Write('inherited')`], { windowsHide: true, encoding: "utf8", timeout: 5000,
    env: { ...process.env, HUB_ACL_CHILD: path.join(child, "new.txt") } });
  assert.equal(inherited.stdout, "inherited");
  // A foreign explicit ACE makes the root proof ineligible. This is not a
  // promise to sanitize arbitrary descendants or erase foreign explicit ACEs.
  await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference='Stop'
    $acl=[System.IO.Directory]::GetAccessControl($env:HUB_ACL_ROOT)
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute','Allow')
    $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:HUB_ACL_ROOT,$acl)`],
  { windowsHide: true, encoding: "utf8", timeout: 5000, env: { ...process.env, HUB_ACL_ROOT: root } });
  assert.equal(await hasRuntimeDirectoryProtection(root), false);
  let fallback = 0;
  await protectRuntimeDirectory(root, { runCommand: async () => { fallback++; } });
  assert.equal(fallback, 1);
  assert.equal(await hasRuntimeDirectoryProtection(path.join(root, "missing")), false);
  t.diagnostic(JSON.stringify({ firstMs, repeatMs, initialApplications: prior, repeatedApplications: 0,
    foreignAceRefused: true, newFileInheritanceChecked: true }));
});
