import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as abortableDelay } from "node:timers/promises";

import { defaultRuntimeRoot, defaultTestContourRoot } from "../infrastructure/filesystem/runtime-layout.mjs";
import { verifyRuntimeManifest } from "../infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { LoopbackTelegramApi } from "../infrastructure/network/loopback-telegram-api.mjs";
import { callDesktopControl } from "../infrastructure/process/desktop-control.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";
import { stopProcessTree } from "../infrastructure/process/process-tree.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";
import { waitForRuntimeReplacement } from "./publication-readiness.mjs";

const MARKER = ".agent-hub-release-acceptance.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const executeFile = promisify(execFile);
const normalize = (value) => path.resolve(value).toLowerCase();
const inside = (value, root) => normalize(value) === normalize(root)
  || normalize(value).startsWith(`${normalize(root)}${path.sep}`);

export function releaseAcceptanceCoverage() {
  return [
    { id: "artifact-integrity", status: "pending" },
    { id: "previous-runtime-readiness", status: "pending" },
    { id: "replacement-while-previous-alive", status: "pending" },
    { id: "candidate-runtime-readiness", status: "pending" },
    { id: "production-snapshot", status: "excluded", reason: "Coherent journal/runtime/command-ledger snapshot and safe remapping are not implemented; this run starts with synthetic empty data." },
    { id: "durable-queue-recovery", status: "excluded", reason: "No accepted pending command is seeded; readiness alone does not prove FIFO, receipt or outbox recovery." },
    { id: "real-external-transport", status: "excluded", reason: "Telegram is loopback; Worker, DashBot, Sentry and provider account access are disabled." },
    { id: "failure-rollback", status: "excluded", reason: "This command does not deliberately install a failing artifact." },
    { id: "browser-ui", status: "excluded", reason: "Use the separate UI verification gate; this command checks runtime lifecycle." },
  ];
}

// Persistent config is intentional: the independent RuntimeHost restart does
// not inherit environment variables from the old Node process.
export function releaseAcceptanceConfig({ root, telegramApiBaseUrl, fakeCodexFile, nodeExecutable = process.execPath }) {
  const url = new URL(telegramApiBaseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Acceptance Telegram must be loopback HTTP");
  if (!inside(fakeCodexFile, root)) throw new Error("Acceptance provider must belong to the isolated root");
  return {
    components: { telegram: true, miniApp: false, androidApp: false, sharedDashboardBot: false, codexContextCleanup: false, testContour: false },
    telegramBotToken: "123:release-acceptance",
    telegramApiBaseUrl: url.toString().replace(/\/$/u, ""),
    allowedUserIds: [42], allowedChatIds: [84], privateChatsOnly: true,
    provider: "codex", projectRoot: path.join(root, "project"),
    projects: [{ name: "Release acceptance", path: path.join(root, "project") }],
    dataDir: path.join(root, "data"),
    codexExecutable: nodeExecutable,
    codexExecutableArgs: [fakeCodexFile, "--accept-all", "--require-test-contour", "--state", path.join(root, "data", "fake-codex-state.json")],
    codexExecutableAutoUpdate: false, codexRateLimitPolling: false, claudeRateLimitPolling: false,
    // Never launch an installed real Claude CLI during optional discovery.
    claudeExecutable: path.join(root, "providers", "disabled-claude.exe"), claudeExecutableArgs: [],
    codexRolloutContext: { enabled: false }, createInitialThreadOnStartup: false,
    codexModel: "fake-codex", codexModels: [{ value: "fake-codex", label: "Fake Codex" }],
    taskBoard: { triageEnabled: false },
    diagnostics: { sentry: { enabled: false, dsn: "", environment: "release-acceptance" } },
    miniApp: { host: "127.0.0.1", quickTunnel: { enabled: false }, worker: { enabled: false } },
    voiceEnabled: false, ttsEnabled: false,
  };
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }

async function rejectReparsePath(root, relative = "") {
  const absolute = path.resolve(root, relative);
  if (!inside(absolute, root)) throw new Error("Artifact path escapes its release");
  // Check ancestors as well as leaves: directory junctions must not move the
  // copy boundary into a production or mutable tree.
  let current = absolute;
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Reparse path is not an acceptance artifact: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

export async function inspectAcceptanceArtifact(releaseRoot) {
  const root = path.resolve(releaseRoot);
  await rejectReparsePath(root);
  const manifestBytes = await readFile(path.join(root, "runtime-manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(manifest.releaseId ?? "")) throw new Error("Invalid acceptance release ID");
  const paths = new Set();
  for (const entry of manifest.files ?? []) {
    if (!entry.path || path.isAbsolute(entry.path) || paths.has(entry.path.toLowerCase())) throw new Error("Invalid or duplicate artifact path");
    paths.add(entry.path.toLowerCase());
    await rejectReparsePath(root, entry.path);
  }
  if (!paths.has("agenthub.runtimehost.exe") || !paths.has("agent-hub-main.mjs")) throw new Error("Acceptance requires a complete Windows runtime artifact");
  await verifyRuntimeManifest(root, manifest.releaseId);
  return { root, releaseId: manifest.releaseId, manifestSha256: hash(manifestBytes), files: manifest.files };
}

async function copyArtifact(artifact, root) {
  const target = path.join(root, "releases", artifact.releaseId);
  await mkdir(target, { recursive: true });
  for (const entry of artifact.files) {
    const source = await rejectReparsePath(artifact.root, entry.path);
    const output = path.join(target, entry.path);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(source, output, 1 /* COPYFILE_EXCL */);
  }
  await copyFile(path.join(artifact.root, "runtime-manifest.json"), path.join(target, "runtime-manifest.json"), 1);
  const copied = await inspectAcceptanceArtifact(target);
  if (copied.manifestSha256 !== artifact.manifestSha256) throw new Error("Artifact changed while copying");
  return target;
}

async function readLock(root) {
  return readJson(path.join(root, "data", "bot.lock")).catch(() => null);
}

async function runtimeEvidence(root, releaseId) {
  const lock = await readLock(root);
  const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot: root, timeoutMs: 10_000 });
  if (!lock?.ready || lock.releaseId !== releaseId || snapshot?.server?.process?.pid !== lock.pid
    || snapshot?.server?.process?.releaseId !== releaseId || !processIsAlive(lock.pid)) {
    throw new Error("Runtime lock and control snapshot do not confirm the exact acceptance artifact");
  }
  return { pid: lock.pid, instanceToken: lock.instanceToken, releaseId };
}

export async function waitForAcceptanceHost(host, options, { waitReady = waitForRuntimeReplacement } = {}) {
  const cancellation = new AbortController();
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  const onError = (error) => rejectFailure(error);
  const onExit = (code, signal) => rejectFailure(new Error(`Acceptance launcher exited before readiness: ${code ?? signal}`));
  host.once("error", onError);
  host.once("exit", onExit);
  const readiness = Promise.resolve().then(() => waitReady({
    ...options,
    now: () => cancellation.signal.aborted ? Number.POSITIVE_INFINITY : Date.now(),
    delay: (milliseconds) => abortableDelay(milliseconds, undefined, { signal: cancellation.signal }),
  }));
  try {
    return await Promise.race([failure, readiness]);
  } finally {
    cancellation.abort();
    // Drain the readiness observer before cleanup; its next delay/iteration is
    // cancelled rather than leaving a two-minute background loop behind.
    await readiness.catch(() => {});
    host.removeListener("error", onError);
    host.removeListener("exit", onExit);
  }
}

export async function exerciseAcceptanceReplacement({ root, previous, candidate, timeoutMs = 120_000,
  probe = callDesktopControl, readCurrentLock = readLock, alive = processIsAlive,
  waitReady = waitForRuntimeReplacement, evidence = runtimeEvidence, delay = sleep,
  activate = async (value) => writeTextAtomic(path.join(root, "current.json"), `${JSON.stringify(value)}\n`),
} = {}) {
  const before = await evidence(root, previous.releaseId);
  await activate({ current: candidate.releaseId, previous: previous.releaseId, updatedAt: new Date().toISOString() });
  let overlap = null;
  let observing = true;
  const observation = (async () => {
    while (observing) {
      const lock = await readCurrentLock(root);
      if (lock?.pid && lock.pid !== before.pid && lock.releaseId === candidate.releaseId && alive(lock.pid) && alive(before.pid)) {
        overlap = { previousPid: before.pid, replacementPid: lock.pid, replacementReady: lock.ready === true, observedAt: new Date().toISOString() };
        return;
      }
      await delay(10);
    }
  })();
  // A timed-out command is not retried: readiness is reconciled by identity.
  let requestError = null;
  try {
    try { await probe("restart-server", {}, { runtimeRoot: root, timeoutMs: 10_000 }); }
    catch (error) { requestError = error.message; }
    await waitReady({ runtimeRoot: root, expectedReleaseId: candidate.releaseId, timeoutMs });
    const after = await evidence(root, candidate.releaseId);
    if (after.pid === before.pid) throw new Error("Acceptance replacement reused the old process");
    if (!overlap) throw new Error("No observed overlap of live previous and replacement runtimes; lifecycle coverage is unconfirmed");
    const deadline = Date.now() + 10_000;
    while (alive(before.pid) && Date.now() < deadline) await delay(25);
    if (alive(before.pid)) throw new Error("Previous runtime remained alive after replacement readiness");
    return { before, after, overlap, requestError };
  } finally {
    observing = false;
    await observation;
  }
}

export async function acceptReleaseArtifact({ artifactRoot, previousArtifactRoot,
  outputRoot = path.join(defaultTestContourRoot(), "release-acceptance"),
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
  timeoutMs = 120_000,
} = {}) {
  if (process.platform !== "win32") throw new Error("Release acceptance currently requires Windows RuntimeHost");
  if (!artifactRoot || !previousArtifactRoot) throw new Error("Both --artifact and --previous-artifact are required");
  const output = path.resolve(outputRoot);
  if (inside(output, defaultRuntimeRoot()) || inside(output, sourceRoot) || inside(output, artifactRoot) || inside(output, previousArtifactRoot)) {
    throw new Error("Acceptance output must be outside production, source and input artifacts");
  }
  await mkdir(output, { recursive: true });
  await rejectReparsePath(output);
  if (normalize(await realpath(output)) !== normalize(output)) throw new Error("Acceptance output resolves through a junction");
  const root = await mkdtemp(path.join(output, "run-"));
  const manifestFile = path.join(root, "acceptance-manifest.json");
  const report = { schemaVersion: 1, id: randomUUID(), root, scope: "windows-runtime-replacement", status: "running",
    productionParity: false, startedAt: new Date().toISOString(), scenarios: releaseAcceptanceCoverage() };
  const save = () => writeTextAtomic(manifestFile, `${JSON.stringify(report, null, 2)}\n`);
  const passed = (id, evidence) => Object.assign(report.scenarios.find((item) => item.id === id), { status: "passed", evidence });
  let host = null;
  let telegram = null;
  let acceptancePrepared = false;
  const launcher = path.join(root, "AgentHub.RuntimeHost.exe");
  const ownedPids = new Set();
  await save();
  try {
    const previous = await inspectAcceptanceArtifact(previousArtifactRoot);
    const candidate = await inspectAcceptanceArtifact(artifactRoot);
    if (previous.releaseId === candidate.releaseId) throw new Error("Acceptance requires distinct previous and candidate release IDs");
    report.artifacts = { previous: { releaseId: previous.releaseId, manifestSha256: previous.manifestSha256 },
      candidate: { releaseId: candidate.releaseId, manifestSha256: candidate.manifestSha256 } };
    await copyArtifact(previous, root);
    const candidateCopy = await copyArtifact(candidate, root);
    await copyFile(path.join(candidateCopy, "AgentHub.RuntimeHost.exe"), launcher, 1);
    // Old hosts must fail before starting any Hub process, rather than silently
    // running an acceptance root without persistent isolation.
    const capability = await readFile(path.join(candidateCopy, "RuntimeHost.release-acceptance-v1.json"), "utf8").catch(() => "");
    if (!candidate.files.some((file) => file.path === "RuntimeHost.release-acceptance-v1.json")
      || JSON.parse(capability || "null")?.schemaVersion !== 1
      || JSON.parse(capability || "null")?.cleanupFence !== 1) throw new Error("Candidate RuntimeHost lacks persistent release-acceptance isolation/cleanup");
    for (const directory of ["data", "project", "providers", "home/.codex", "home/.claude", "temp"]) await mkdir(path.join(root, directory), { recursive: true });
    const fakeCodexFile = path.join(root, "providers", "fake-codex-app-server.mjs");
    await copyFile(path.join(sourceRoot, "e2e", "fake-codex-app-server.mjs"), fakeCodexFile, 1);
    report.harness = { fakeCodexSha256: hash(await readFile(fakeCodexFile)) };
    telegram = new LoopbackTelegramApi();
    await telegram.start();
    const config = releaseAcceptanceConfig({ root, telegramApiBaseUrl: telegram.baseUrl, fakeCodexFile });
    await writeFile(path.join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(path.join(root, MARKER), `${JSON.stringify({ schemaVersion: 1, id: report.id, root })}\n`, { encoding: "utf8", flag: "wx" });
    acceptancePrepared = true;
    await writeTextAtomic(path.join(root, "current.json"), `${JSON.stringify({ current: previous.releaseId })}\n`);
    passed("artifact-integrity", report.artifacts);
    await save();
    host = spawn(launcher, [], { cwd: root, stdio: "ignore", windowsHide: true });
    if (host.pid) ownedPids.add(host.pid);
    await waitForAcceptanceHost(host, { runtimeRoot: root, expectedReleaseId: previous.releaseId, timeoutMs });
    const before = await runtimeEvidence(root, previous.releaseId);
    ownedPids.add(before.pid);
    passed("previous-runtime-readiness", before);
    await save();
    const replacement = await exerciseAcceptanceReplacement({ root, previous, candidate, timeoutMs });
    ownedPids.add(replacement.after.pid);
    passed("replacement-while-previous-alive", replacement.overlap);
    passed("candidate-runtime-readiness", replacement.after);
    report.restart = replacement;
    // Verify retained candidate bytes again after lifecycle execution.
    const retained = await inspectAcceptanceArtifact(candidateCopy);
    if (retained.manifestSha256 !== candidate.manifestSha256) throw new Error("Candidate artifact changed during acceptance");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw Object.assign(error, { acceptanceManifest: manifestFile });
  } finally {
    let fenceError = null;
    if (acceptancePrepared) {
      try {
        await executeFile(launcher, ["--close-release-acceptance"], {
          cwd: root, windowsHide: true, timeout: 12_000, maxBuffer: 4_096,
        });
      } catch (error) { fenceError = error.message; }
    }
    const lock = await readLock(root);
    if (lock?.pid && report.artifacts && Object.values(report.artifacts).some((artifact) => artifact.releaseId === lock.releaseId)) ownedPids.add(lock.pid);
    const cleanupFailures = [];
    for (const pid of ownedPids) {
      if (processIsAlive(pid) && await stopProcessTree(pid).catch(() => false) !== true) cleanupFailures.push(pid);
    }
    const stopDeadline = Date.now() + 5_000;
    while ([...ownedPids].some((pid) => processIsAlive(pid)) && Date.now() < stopDeadline) await sleep(25);
    for (const pid of ownedPids) {
      if (processIsAlive(pid) && !cleanupFailures.includes(pid)) cleanupFailures.push(pid);
    }
    let adapterError = null;
    await telegram?.stop().catch((error) => { adapterError = error.message; });
    report.cleanup = { stopped: cleanupFailures.length === 0 && !adapterError && !fenceError,
      launchFenceClosed: acceptancePrepared && !fenceError, fenceError, remainingPids: cleanupFailures, adapterError };
    if (cleanupFailures.length || adapterError || fenceError) report.status = "failed";
    report.finishedAt = new Date().toISOString();
    await save();
  }
  if (report.status !== "passed") throw Object.assign(new Error("Acceptance process cleanup failed"), { acceptanceManifest: manifestFile });
  return { ...report, manifestFile };
}
