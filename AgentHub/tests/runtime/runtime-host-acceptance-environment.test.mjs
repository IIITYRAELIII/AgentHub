import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runtimeHostCompilerCandidates } from "../../src/infrastructure/process/runtime-host-builder.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..", "..");

test("compiled RuntimeHost reapplies isolated environment from persistent marker after WMI restart", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "acceptance-host-environment-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const binary = path.join(temporary, "probe.exe");
  await execute(runtimeHostCompilerCandidates()[0], ["/nologo", "/target:exe", "/main:AcceptanceEnvironmentProbe", `/out:${binary}`,
    "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Management.dll", "/reference:System.Web.Extensions.dll",
    path.join(root, "RuntimeHost", "AgentHub.RuntimeHost.cs"), path.join(root, "tests", "fixtures", "runtime-host-acceptance-environment.cs")],
  { windowsHide: true, timeout: 10_000 });
  const owned = path.join(temporary, "owned");
  await mkdir(owned);
  const marker = path.join(owned, ".agent-hub-release-acceptance.json");
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, id: "acceptance-test", root: owned }));
  const run = () => execute(binary, [owned], { windowsHide: true, timeout: 3_000 });
  const result = JSON.parse((await run()).stdout);
  assert.equal(result.tokenPresent, false);
  assert.equal(result.executableOverridePresent, false);
  assert.equal(result.sentryPresent, false);
  assert.equal(result.nodeOptionsPresent, false);
  assert.equal(result.home, path.join(owned, "home"));
  assert.equal(result.codexHome, path.join(owned, "home", ".codex"));
  assert.equal(result.profile, "fake-codex");
  // Simulate a fresh WMI environment: the marker, not inheritance from the first
  // run, must reproduce the same sandbox on a second independent invocation.
  assert.deepEqual(JSON.parse((await run()).stdout), result);
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, id: "acceptance-test", root: temporary }));
  await assert.rejects(run(), /identity mismatch/);
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, id: "acceptance-test", root: owned }));
  // Register a real independent probe in the same Job Object, without starting
  // Hub or writing bot.lock. Cleanup must own it before any readiness evidence.
  const held = spawn(binary, [owned, "hold-before-instance-lock"], { windowsHide: true });
  t.after(() => { if (held.exitCode === null) held.kill(); });
  const heldExit = once(held, "exit");
  const registered = once(held.stdout, "data");
  assert.match(String((await registered)[0]), /registered-before-lock/);
  assert.match((await execute(binary, [owned, "close"], { windowsHide: true, timeout: 8_000 })).stdout, /closed/);
  const [exitCode] = await heldExit;
  assert.equal(exitCode, 1);
  await assert.rejects(run(), /acceptance is closed/);
  // Closing twice is idempotent; a later independent invocation stays fenced.
  await execute(binary, [owned, "close"], { windowsHide: true, timeout: 8_000 });
  await assert.rejects(run(), /acceptance is closed/);
  await rm(marker);
  const ordinary = JSON.parse((await run()).stdout);
  assert.equal(ordinary.tokenPresent, true);
  assert.equal(ordinary.executableOverridePresent, true);
});
