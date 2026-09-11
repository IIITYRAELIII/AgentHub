import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runtimeHostCompilerCandidates } from "../../src/infrastructure/process/runtime-host-builder.mjs";
import { runtimeSecretAclArguments, runtimeDirectoryAclArguments } from "../../src/infrastructure/filesystem/runtime-security.mjs";
import { recordingContourEnvironment } from "../../src/infrastructure/filesystem/test-contour-recording-environment.mjs";

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
  const isolatedEnvironment = { USERNAME: result.userName, USERDOMAIN: result.userDomain };
  assert.notEqual(result.userName, "synthetic-wrong-owner");
  assert.ok(result.userName);
  assert.deepEqual(runtimeSecretAclArguments(path.join(owned, "config.json"), isolatedEnvironment), [
    path.join(owned, "config.json"), "/inheritance:r", "/grant:r",
    `${result.windowsOwner}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)",
  ]);
  assert.equal(runtimeDirectoryAclArguments(owned, isolatedEnvironment)[3], `${result.windowsOwner}:(OI)(CI)(F)`);
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

test("compiled RuntimeHost verifies and persists recording acceptance profile across independent launches", { skip: process.platform !== "win32", timeout: 25_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "recording-host-environment-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const binary = path.join(temporary, "probe.exe");
  await execute(runtimeHostCompilerCandidates()[0], ["/nologo", "/target:exe", "/main:AcceptanceEnvironmentProbe", `/out:${binary}`,
    "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Management.dll", "/reference:System.Web.Extensions.dll",
    path.join(root, "RuntimeHost", "AgentHub.RuntimeHost.cs"), path.join(root, "tests", "fixtures", "runtime-host-acceptance-environment.cs")],
  { windowsHide: true, timeout: 10_000 });
  const owned = path.join(temporary, "owned"), recording = path.join(owned, "recording");
  await mkdir(recording, { recursive: true }); await mkdir(path.join(owned, "data"));
  for (const name of ["journal.sqlite", "runtime.sqlite", "message-command-ledger.sqlite"]) await writeFile(path.join(owned, "data", name), "owned synthetic file");
  const markerFile = path.join(owned, ".agent-hub-release-acceptance.json");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const save = async (file, value) => { const bytes = JSON.stringify(value); await writeFile(file, bytes); return hash(bytes); };
  const files = {
    provider: path.join(recording, "recording-provider.json"), projects: path.join(recording, "recording-projects.json"),
    preparation: path.join(owned, "contour-preparation.json"), config: path.join(owned, "config.json"),
  };
  const seed = async ({ provider = {}, projects = {}, preparation = {}, config = {} } = {}) => {
    const providerHash = await save(files.provider, { schemaVersion: 1, kind: "literal-recording-provider", root: recording, externalEffects: "deny", ...provider });
    const projectsHash = await save(files.projects, { schemaVersion: 1, kind: "recording-project-configuration", root: recording, markerSha256: providerHash, ...projects });
    const preparationHash = await save(files.preparation, { schemaVersion: 1, kind: "owned-contour-preparation", root: owned,
      phase: "prepared", bootable: false, recordingMarkerSha256: providerHash, configSha256: projectsHash, ...preparation });
    const configHash = await save(files.config, { dataDir: path.join(owned, "data"), testContourRecording: { schemaVersion: 1, root: recording }, ...config });
    const marker = { schemaVersion: 2, id: "recording-acceptance", root: owned, profile: "recording", recordingRoot: recording,
      recordingMarkerSha256: providerHash, projectConfigurationSha256: projectsHash, preparationSha256: preparationHash, configSha256: configHash };
    await save(markerFile, marker); return marker;
  };
  const run = () => execute(binary, [owned], { windowsHide: true, timeout: 3_000 });
  let marker = await seed();
  const expectedEnvironment = recordingContourEnvironment(recording);
  const first = JSON.parse((await run()).stdout);
  assert.equal(first.profile, "recording"); assert.equal(first.recordingRoot, recording); assert.equal(first.testContour, "1");
  for (const [key, env] of [["home", "HOME"], ["codexHome", "CODEX_HOME"], ["claudeHome", "CLAUDE_CONFIG_DIR"],
    ["appData", "APPDATA"], ["localAppData", "LOCALAPPDATA"], ["temp", "TEMP"], ["tmp", "TMP"]]) assert.equal(first[key], expectedEnvironment[env]);
  for (const key of ["tokenPresent", "executableOverridePresent", "sentryPresent", "nodeOptionsPresent", "pathPresent"]) assert.equal(first[key], false);
  assert.deepEqual(JSON.parse((await run()).stdout), first);
  await save(markerFile, { ...marker, profile: "unknown" }); await assert.rejects(run(), /Unknown release acceptance profile/);
  await save(markerFile, { ...marker, schemaVersion: 3 }); await assert.rejects(run(), /identity mismatch/);
  await save(markerFile, { ...marker, recordingRoot: temporary }); await assert.rejects(run(), /root identity mismatch/);
  await save(markerFile, { ...marker, recordingRoot: recording.slice(2) }); await assert.rejects(run(), /root identity mismatch/);
  await save(markerFile, { ...marker, configSha256: "bad-hash" }); await assert.rejects(run(), /Invalid recording acceptance hash/);
  await save(markerFile, { ...marker, configSha256: undefined }); await assert.rejects(run(), /Missing JSON property/);
  await save(markerFile, marker);
  for (const file of Object.values(files)) {
    const bytes = await readFile(file); await writeFile(file, Buffer.concat([bytes, Buffer.from(" ")]));
    await assert.rejects(run(), /hash mismatch/); await writeFile(file, bytes);
  }
  await seed({ provider: { externalEffects: "allow" } }); await assert.rejects(run(), /profile identity mismatch/);
  await seed({ provider: { schemaVersion: 2 } }); await assert.rejects(run(), /profile identity mismatch/);
  await seed({ provider: { root: temporary } }); await assert.rejects(run(), /root identity mismatch/);
  await seed({ preparation: { bootable: true } }); await assert.rejects(run(), /profile identity mismatch/);
  await seed({ preparation: { phase: "preparing" } }); await assert.rejects(run(), /profile identity mismatch/);
  await seed({ preparation: { recordingMarkerSha256: "0".repeat(64) } }); await assert.rejects(run(), /profile identity mismatch/);
  await seed({ projects: { markerSha256: "0".repeat(64) } }); await assert.rejects(run(), /profile identity mismatch/);
  await seed({ projects: { root: temporary } }); await assert.rejects(run(), /root identity mismatch/);
  await seed({ config: { testContourRecording: { schemaVersion: 1, root: temporary } } }); await assert.rejects(run(), /root identity mismatch/);
  await seed({ config: { dataDir: temporary } }); await assert.rejects(run(), /root identity mismatch/);
  marker = await seed();
  const missingDb = path.join(owned, "data", "runtime.sqlite");
  const dbBytes = await readFile(missingDb); await rm(missingDb);
  await assert.rejects(run(), /file is missing/); await writeFile(missingDb, dbBytes);
  const movedRecording = path.join(temporary, "recording-behind-junction");
  await rename(recording, movedRecording); await symlink(movedRecording, recording, "junction");
  await assert.rejects(run(), /reparse point/);
  await rm(recording); await rename(movedRecording, recording);
  // A fixed owned HOME must not be replaced by a junction to another profile.
  const home = path.join(recording, "home"), foreignHome = path.join(temporary, "foreign-home");
  await mkdir(foreignHome); await writeFile(path.join(foreignHome, "sentinel"), "untouched");
  await rm(home, { recursive: true }); await symlink(foreignHome, home, "junction");
  await assert.rejects(run(), /reparse point/);
  assert.equal(await readFile(path.join(foreignHome, "sentinel"), "utf8"), "untouched");
  await rm(home); await mkdir(home);
  assert.deepEqual(JSON.parse((await run()).stdout), first);
  const held = spawn(binary, [owned, "hold-before-instance-lock"], { windowsHide: true });
  t.after(() => { if (held.exitCode === null) held.kill(); });
  const heldExit = once(held, "exit");
  assert.match(String((await once(held.stdout, "data"))[0]), /registered-before-lock/);
  // Invalid mutable config must not prevent closing the already-owned Job.
  await writeFile(files.config, "{}"); await assert.rejects(run(), /hash mismatch/);
  assert.match((await execute(binary, [owned, "close"], { windowsHide: true, timeout: 8_000 })).stdout, /closed/);
  assert.equal((await heldExit)[0], 1);
  await assert.rejects(run(), /acceptance is closed/);
  await execute(binary, [owned, "close"], { windowsHide: true, timeout: 8_000 });
  await assert.rejects(run(), /acceptance is closed/);
});
