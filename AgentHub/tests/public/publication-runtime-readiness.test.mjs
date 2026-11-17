import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publicationRuntimeStatus, startInstalledPublicationRuntime } from "../helpers/external-release-recipe.fixture.mjs";
import { runtimeLayout } from "../../src/infrastructure/filesystem/runtime-layout.mjs";

const ready = { current: "new", runningRelease: "new", running: true, ready: true, pid: 42 };


test("unreadable or invalid lock never becomes confirmed process absence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-publication-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "data", "bot.lock");
  await mkdir(path.dirname(lock), { recursive: true });
  assert.equal((await publicationRuntimeStatus({ runtimeRoot: root })).running, false);
  await writeFile(lock, "{}");
  await assert.rejects(publicationRuntimeStatus({ runtimeRoot: root }), /no valid process identity/u);
  await rm(lock);
  await mkdir(lock);
  await assert.rejects(publicationRuntimeStatus({ runtimeRoot: root }));
});











test("cold start verifies installed launcher and rechecks process absence", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows RuntimeHost protocol");
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-publication-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "releases", "new");
  await mkdir(release, { recursive: true });
  const binary = Buffer.from("synthetic launcher; never executed");
  const entry = { path: "AgentHub.RuntimeHost.exe", bytes: binary.length, sha256: createHash("sha256").update(binary).digest("hex") };
  await writeFile(path.join(release, entry.path), binary);
  await writeFile(runtimeLayout(root).launcherFile, binary);
  await writeFile(path.join(release, "package.json"), JSON.stringify({ name: "agent-hub", version: "2026.9.10" }));
  await writeFile(path.join(release, "runtime-manifest.json"), JSON.stringify({ releaseId: "new", version: "2026.9.10", files: [entry] }));
  let calls = 0;
  const options = {
    runtimeRoot: root, expectedReleaseId: "new",
    readStatus: async () => ({ current: "new", running: false }),
    execute: async (file, args, launchOptions) => {
      assert.equal(file, runtimeLayout(root).launcherFile);
      assert.deepEqual(args, ["--spawn-independent"]);
      assert.equal(launchOptions.windowsHide, true);
      calls += 1;
    },
  };
  await startInstalledPublicationRuntime(options);
  assert.equal(calls, 1);
  assert.deepEqual(await startInstalledPublicationRuntime({ ...options, readStatus: async () => ({ current: "new", running: true }) }), { started: false });
  await assert.rejects(startInstalledPublicationRuntime({ ...options, readStatus: async () => ({ current: "other", running: false }) }), /changed before cold start/u);
  await assert.rejects(startInstalledPublicationRuntime({ ...options, readStatus: async () => ({ current: "new", running: null }) }), /absence is not confirmed/u);
  await writeFile(runtimeLayout(root).launcherFile, "tampered");
  await assert.rejects(startInstalledPublicationRuntime(options), /launcher does not match/u);
  assert.equal(calls, 1);
});
