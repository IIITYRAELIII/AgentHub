import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { exerciseAcceptanceReplacement, inspectAcceptanceArtifact, releaseAcceptanceConfig, releaseAcceptanceCoverage, waitForAcceptanceHost } from "../../src/runtime/test-contour-release-acceptance.mjs";

test("spawn errors fail initial readiness immediately and drain its observer", async () => {
  const host = new EventEmitter();
  let drained = false;
  const waiting = waitForAcceptanceHost(host, {}, { waitReady: async ({ delay }) => {
    try { await delay(120_000); } finally { drained = true; }
  } });
  host.emit("error", new Error("ENOENT launcher"));
  await assert.rejects(waiting, /ENOENT launcher/);
  assert.equal(drained, true);
  assert.equal(host.listenerCount("error"), 0);
  assert.equal(host.listenerCount("exit"), 0);
});

test("early launcher exit fails readiness without waiting for the full deadline", async () => {
  const host = new EventEmitter();
  const waiting = waitForAcceptanceHost(host, {}, { waitReady: async ({ delay }) => delay(120_000) });
  host.emit("exit", 7, null);
  await assert.rejects(waiting, /exited before readiness: 7/);
});

test("acceptance report names gaps instead of equating readiness with production parity", () => {
  const coverage = releaseAcceptanceCoverage();
  assert.equal(coverage.filter((item) => item.status === "pending").length, 4);
  for (const id of ["production-snapshot", "durable-queue-recovery", "real-external-transport", "failure-rollback"]) {
    assert.equal(coverage.find((item) => item.id === id).status, "excluded");
    assert.ok(coverage.find((item) => item.id === id).reason.length > 20);
  }
});

test("acceptance persistent config uses only owned synthetic provider and Telegram", () => {
  const root = path.join(os.tmpdir(), "acceptance-config");
  const config = releaseAcceptanceConfig({ root, fakeCodexFile: path.join(root, "providers", "fake.mjs"), telegramApiBaseUrl: "http://127.0.0.1:1234" });
  assert.equal(config.telegramApiBaseUrl, "http://127.0.0.1:1234");
  assert.ok(config.codexExecutableArgs.includes("--require-test-contour"));
  assert.equal(config.codexExecutableAutoUpdate, false);
  assert.equal(config.components.sharedDashboardBot, false);
  assert.equal(config.diagnostics.sentry.enabled, false);
  assert.equal(config.claudeExecutable, path.join(root, "providers", "disabled-claude.exe"));
  assert.throws(() => releaseAcceptanceConfig({ root, fakeCodexFile: path.join(root, "fake.mjs"), telegramApiBaseUrl: "https://api.telegram.org" }), /loopback/);
  assert.throws(() => releaseAcceptanceConfig({ root, fakeCodexFile: path.join(root, "..", "real.mjs"), telegramApiBaseUrl: "http://127.0.0.1:1234" }), /isolated/);
});

function replacementFixture({ observeOverlap = true, requestFails = false, readinessFails = false } = {}) {
  let requested = false;
  let oldAlive = true;
  let activated = null;
  let requestCount = 0;
  const root = path.join(os.tmpdir(), "isolated-acceptance");
  const options = {
    root, previous: { releaseId: "old" }, candidate: { releaseId: "new" },
    alive: (pid) => pid === 10 ? oldAlive : pid === 20,
    evidence: async (_, releaseId) => ({ pid: releaseId === "old" ? 10 : 20, releaseId }),
    activate: async (value) => { activated = value; },
    probe: async (action, params, control) => {
      assert.equal(action, "restart-server");
      assert.equal(control.runtimeRoot, root);
      assert.equal(activated.current, "new");
      requested = true;
      requestCount += 1;
      if (requestFails) throw new Error("ambiguous timeout");
    },
    readCurrentLock: async () => requested && observeOverlap
      ? { pid: 20, releaseId: "new", ready: false } : { pid: 10, releaseId: "old", ready: true },
    waitReady: async ({ runtimeRoot, expectedReleaseId }) => {
      assert.equal(runtimeRoot, root);
      assert.equal(expectedReleaseId, "new");
      await new Promise((resolve) => setImmediate(resolve));
      if (readinessFails) throw new Error("wrong release");
      oldAlive = false;
    },
    delay: () => new Promise((resolve) => setImmediate(resolve)),
  };
  return { options, requests: () => requestCount };
}

test("replacement activates exact bytes and requires overlapping live process generations", async () => {
  const fixture = replacementFixture();
  const result = await exerciseAcceptanceReplacement(fixture.options);
  assert.equal(result.before.pid, 10);
  assert.equal(result.after.pid, 20);
  assert.equal(result.overlap.replacementReady, false);
  assert.equal(fixture.requests(), 1);
});

test("ambiguous restart response reconciles readiness without sending another restart", async () => {
  const fixture = replacementFixture({ requestFails: true });
  const result = await exerciseAcceptanceReplacement(fixture.options);
  assert.equal(result.requestError, "ambiguous timeout");
  assert.equal(fixture.requests(), 1);
});

test("ready candidate without observed live overlap is not lifecycle success", async () => {
  const fixture = replacementFixture({ observeOverlap: false });
  await assert.rejects(exerciseAcceptanceReplacement(fixture.options), /overlap/);
});

test("wrong or unready release cannot be promoted to acceptance success", async () => {
  const fixture = replacementFixture({ readinessFails: true });
  await assert.rejects(exerciseAcceptanceReplacement(fixture.options), /wrong release/);
  assert.equal(fixture.requests(), 1);
});

async function syntheticArtifact(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "acceptance-manifest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [name, bytes] of [["agent-hub-main.mjs", "export {};\n"], ["package.json", '{"name":"agent-hub","version":"2026.9.10"}\n'], ["AgentHub.RuntimeHost.exe", "synthetic-host-not-executable"]]) {
    await writeFile(path.join(root, name), bytes);
    files.push({ path: name, bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(root, "runtime-manifest.json"), JSON.stringify({ releaseId: "candidate-1", version: "2026.9.10", files }));
  return root;
}

test("acceptance checks executable artifact bytes and rejects changed content", async (t) => {
  const root = await syntheticArtifact(t);
  const artifact = await inspectAcceptanceArtifact(root);
  assert.equal(artifact.releaseId, "candidate-1");
  assert.match(artifact.manifestSha256, /^[a-f0-9]{64}$/);
  await writeFile(path.join(root, "agent-hub-main.mjs"), "export 1;\n");
  await assert.rejects(inspectAcceptanceArtifact(root), /mismatch/);
});

test("manifest path escape and duplicate entries fail before artifact execution", async (t) => {
  const root = await syntheticArtifact(t);
  const file = path.join(root, "runtime-manifest.json");
  const value = JSON.parse(await readFile(file, "utf8"));
  value.files.push(value.files[0]);
  await writeFile(file, JSON.stringify(value));
  await assert.rejects(inspectAcceptanceArtifact(root), /duplicate/);
  value.files.at(-1).path = "../outside.mjs";
  await writeFile(file, JSON.stringify(value));
  await assert.rejects(inspectAcceptanceArtifact(root), /escapes/);
});
