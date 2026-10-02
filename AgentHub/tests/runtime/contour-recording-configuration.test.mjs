import { assertRecordingContourConfiguration, prepareRecordingContourEnvironment } from "../../src/infrastructure/filesystem/test-contour-recording-environment.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cloneProductionDataToTestContour, installTestContour, serveTestContour, testContourConfig, testContourEnvironment, testContourPaths } from "../../src/runtime/test-contour-manager.mjs";
import { prepareTestContourRecordingConfiguration, readTestContourRecordingConfiguration } from "../../src/infrastructure/filesystem/test-contour-recording-configuration.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-recording-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recording = path.join(root, "recording"); await mkdir(recording);
  const sourceConfig = { projectRoot: path.join(root, "canonical-a"), projects: [
    { name: "Alpha", path: path.join(root, "canonical-a") },
    { name: "Beta", path: path.join(root, "canonical-b") },
  ], telegramBotToken: "source-secret-not-copied" };
  const markerFile = path.join(recording, "recording-provider.json");
  const marker = { schemaVersion: 1, kind: "literal-recording-provider", root: recording,
    externalEffects: "deny", sources: sourceConfig.projects.map((project) => ({ source: project.path, kind: "project" })), threads: [] };
  await writeFile(markerFile, JSON.stringify(marker));
  return { root, recording, sourceConfig, markerFile, marker };
}

test("installer prepares recording projects consumed by real runtime config and environment", async (t) => {
  const f = await fixture(t); const calls = [];
  const installed = await installTestContour({ root: f.root, recordingSourceConfig: f.sourceConfig,
    run: async (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  const recording = await readTestContourRecordingConfiguration(f.root);
  const recordingRoot = await realpath(f.recording);
  assert.deepEqual(recording.projects.map((project) => project.name), ["Alpha", "Beta"]);
  assert.ok(recording.projects.every((project) => project.path.startsWith(path.join(recordingRoot, "execution", "project"))));
  const descriptorFile = path.join(f.recording, "recording-projects.json");
  const before = await readFile(descriptorFile, "utf8");
  assert.equal(before.includes("source-secret-not-copied"), false);
  await prepareTestContourRecordingConfiguration({ root: f.root, sourceConfig: f.sourceConfig });
  assert.equal(await readFile(descriptorFile, "utf8"), before);
  const config = testContourConfig({ paths: installed.paths, telegramApiBaseUrl: "http://127.0.0.1:1234", recording });
  assert.deepEqual(config.projects, recording.projects);
  assert.deepEqual(config.testContourRecording, { schemaVersion: 1, root: recordingRoot });
  assert.equal(path.basename(config.codexExecutableArgs[0]), "recording-contour-codex-cli.mjs");
  assert.deepEqual(config.codexExecutableArgs.slice(1), ["--recording-root", recordingRoot]);
  const environment = testContourEnvironment({ paths: installed.paths, telegramApiBaseUrl: "http://127.0.0.1:1234",
    releaseId: "test-release", contourId: installed.marker.id, port: 1234, runtimeNonce: "fixture-nonce", recording,
    environment: { CODEX_PROJECT_ROOT: "wrong-single-project", AGENT_HUB_RECORDING_PROVIDER_ROOT: "wrong-root" } });
  assert.equal(Object.hasOwn(environment, "CODEX_PROJECT_ROOT"), false);
  assert.equal(environment.AGENT_HUB_RECORDING_PROVIDER_ROOT, recordingRoot);
  await writeFile(f.markerFile, JSON.stringify({ ...f.marker, threads: [{ provider: "codex", id: "new", streamId: "s", cwd: f.sourceConfig.projectRoot }] }));
  await assert.rejects(readTestContourRecordingConfiguration(f.root), /identity mismatch/);
});

test("recording serve fails before provider discovery, runtime spawn or legacy state cleanup", async (t) => {
  const f = await fixture(t);
  await installTestContour({ root: f.root, recordingSourceConfig: f.sourceConfig, run: async () => {} });
  const paths = testContourPaths(f.root); const sentinel = "retained recording manager state";
  await writeFile(paths.stateFile, sentinel);
  let spawns = 0;
  await assert.rejects(serveTestContour({ root: f.root, spawnImpl: () => { spawns++; throw new Error("must not spawn"); } }),
    { code: "CONTOUR_RECORDING_BOOT_NOT_READY" });
  assert.equal(spawns, 0); assert.equal(await readFile(paths.stateFile, "utf8"), sentinel);
  await rm(f.markerFile);
  await assert.rejects(readTestContourRecordingConfiguration(f.root), { code: "ENOENT" });
  const normal = path.join(f.root, "ordinary"); await mkdir(normal);
  assert.equal(await readTestContourRecordingConfiguration(normal), null);
});

test("legacy production clone refuses a prepared recording cohort before resetting data", async (t) => {
  const f = await fixture(t);
  await installTestContour({ root: f.root, recordingSourceConfig: f.sourceConfig, run: async () => {} });
  const paths = testContourPaths(f.root);
  await mkdir(paths.dataDir, { recursive: true });
  const runtime = path.join(paths.dataDir, "runtime.sqlite");
  const sentinel = Buffer.from("owned prepared runtime sentinel");
  await writeFile(runtime, sentinel);
  await assert.rejects(cloneProductionDataToTestContour({ root: f.root,
    productionRoot: `${f.root}-unavailable-source` }), { code: "CONTOUR_RECORDING_REFRESH_REQUIRES_COHORT" });
  assert.deepEqual(await readFile(runtime), sentinel);
});


test("recording runtime environment drops inherited secrets and prepares only owned homes", async (t) => {
  const f = await fixture(t);
  const inherited = { SystemRoot: "C:\\Windows", PATH: "production-bin", HOME: "production-home", USERPROFILE: "production-profile",
    OPENAI_API_KEY: "private", ANTHROPIC_AUTH_TOKEN: "private", NODE_OPTIONS: "--require production-hook", CLAUDE_CONFIG_DIR: "production-config" };
  const prepared = await prepareRecordingContourEnvironment(f.recording, inherited);
  assert.equal(prepared.SystemRoot, inherited.SystemRoot);
  for (const key of ["PATH", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "NODE_OPTIONS"]) assert.equal(Object.hasOwn(prepared, key), false);
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    assert.equal(path.dirname(prepared[key]), f.recording);
    assert.equal((await stat(prepared[key])).isDirectory(), true);
  }
  const paths = testContourPaths(f.root);
  const environment = testContourEnvironment({ paths, telegramApiBaseUrl: "http://127.0.0.1:1234", releaseId: "r",
    contourId: "c", runtimeNonce: "n", port: 1234, recording: { root: f.recording }, environment: inherited });
  assert.equal(environment.CODEX_HOME, prepared.CODEX_HOME);
  assert.equal(environment.HOME, prepared.HOME);
  assert.equal(Object.hasOwn(environment, "OPENAI_API_KEY"), false);
});

test("recording configuration rejects remote effects and credentials before constructing clients", () => {
  const assertRaw = (raw, options = {}) => assertRecordingContourConfiguration(raw, { environment: {}, ...options });
  assert.doesNotThrow(() => assertRaw({ telegramBotToken: "123:test-contour-token", telegramApiBaseUrl: "http://127.0.0.1:1234" }, { telegramEnabled: true }));
  for (const raw of [{ components: { androidApp: true } }, { miniApp: { worker: { enabled: true } } },
    { miniApp: { quickTunnel: { enabled: true } } }, { diagnostics: { sentry: { enabled: true } } }]) {
    assert.throws(() => assertRaw(raw), /Remote components/);
  }
  assert.throws(() => assertRaw({ providerOptions: { apiKey: "private" } }), /Credentials/);
  assert.throws(() => assertRaw({ telegramBotToken: "456:real-token" }), /Production Telegram token/);
  assert.throws(() => assertRaw({ telegramApiBaseUrl: "https://api.telegram.org" }, { telegramEnabled: true }), /loopback/);
  assert.throws(() => assertRaw({}, { environment: { OPENAI_API_KEY: "private" } }), /Provider credentials/);
});
