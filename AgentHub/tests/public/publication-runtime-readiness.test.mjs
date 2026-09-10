import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restartRuntimeAndVerify, waitForRuntimeReplacement } from "../../publish-all.mjs";
import { publicationRuntimeStatus, startInstalledPublicationRuntime } from "../../src/runtime/runtime-publication-start.mjs";
import { runtimeLayout } from "../../src/infrastructure/filesystem/runtime-layout.mjs";

const ready = { current: "new", runningRelease: "new", running: true, ready: true, pid: 42 };
const snapshot = { server: { process: { releaseId: "new", pid: 42 } } };

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

test("replacement endpoint cannot pass readiness for an old or unready release", async () => {
  for (const status of [
    { ...ready, runningRelease: "old" }, { ...ready, current: "other" },
    { ...ready, ready: false }, { ...ready, running: false }, { ...ready, pid: 99 },
  ]) {
    let clock = 0;
    await assert.rejects(waitForRuntimeReplacement({
      expectedReleaseId: "new", previousEndpointId: "old-endpoint", timeoutMs: 10,
      readEndpoint: async () => ({ endpointId: "new-endpoint" }),
      readStatus: async () => status, probe: async () => snapshot,
      now: () => clock, delay: async () => { clock += 10; },
    }), /Expected ready runtime new/u);
  }
});

test("matching lock with stale server response is not publication evidence", async () => {
  let clock = 0;
  await assert.rejects(waitForRuntimeReplacement({
    expectedReleaseId: "new", timeoutMs: 10,
    readEndpoint: async () => ({ endpointId: "new-endpoint" }),
    readStatus: async () => ready,
    probe: async () => ({ server: { process: { releaseId: "old", pid: 42 } } }),
    now: () => clock, delay: async () => { clock += 10; },
  }), /Expected ready runtime new/u);
});

test("offline publication starts once and verifies the frozen current release", async () => {
  const events = [];
  await restartRuntimeAndVerify(
    async () => assert.fail("offline runtime has no restart RPC"),
    async (options) => { events.push("verify"); assert.equal(options.expectedReleaseId, "new"); },
    "unused", {
      readStatus: async () => ({ current: "new", running: false }),
      readEndpoint: async () => { throw new Error("offline"); },
      startInstalled: async ({ expectedReleaseId }) => {
        assert.equal(expectedReleaseId, "new"); events.push("start"); return { started: true };
      },
    },
  );
  assert.deepEqual(events, ["start", "verify"]);
});

test("ambiguous restart failure never triggers a cold start", async () => {
  await assert.rejects(restartRuntimeAndVerify(
    async () => { throw new Error("RPC timed out"); }, async () => assert.fail("no readiness"), "unused", {
      readStatus: async () => ({ current: "new", running: true }),
      readEndpoint: async () => ({ endpointId: "old" }),
      startInstalled: async () => assert.fail("must not duplicate a potentially accepted restart"),
    },
  ), /RPC timed out/u);
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
