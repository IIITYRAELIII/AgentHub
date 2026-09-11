import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordingContourProfile, RECORDING_BOOT_GAPS } from "../../src/infrastructure/filesystem/test-contour-recording-profile.mjs";

test("absent recording profile leaves normal configuration unchanged", async () => {
  assert.equal(await recordingContourProfile(undefined, { environment: {} }), null);
});

test("copied data and an optimistic marker cannot bypass missing external effect owners", async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "hub-recording-guard-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const root = path.join(runtimeRoot, "recording");
  await mkdir(root);
  await writeFile(path.join(root, "recording-provider.json"), JSON.stringify({ schemaVersion: 1, root, kind: "literal-recording-provider", externalEffects: "deny", bootable: true, productionParity: true }));
  const raw = { schemaVersion: 1, root };
  await assert.rejects(recordingContourProfile(raw, { dataDir: path.join(runtimeRoot, "data"), environment: {} }), /isolated/);
  const environment = { AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RUNTIME_ROOT: runtimeRoot };
  await assert.rejects(recordingContourProfile(raw, { dataDir: path.join(runtimeRoot, "other-data"), environment }), /disagree/);
  await assert.rejects(recordingContourProfile(raw, { dataDir: path.join(runtimeRoot, "data"), environment }), (error) => {
    assert.equal(error.code, "CONTOUR_RECORDING_BOOT_NOT_READY");
    assert.deepEqual(error.gaps, RECORDING_BOOT_GAPS);
    return true;
  });
});
