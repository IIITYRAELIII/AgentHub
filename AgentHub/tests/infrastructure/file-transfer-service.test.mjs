import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, open as openFile, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint, CompactSign, exportJWK, generateKeyPair } from "jose";

import { fileTransferPolicy, transferFilename, transferRange, TRANSFER_BLOCK_BYTES } from "../../src/domain/file-transfer.mjs";
import { FileTransferService } from "../../src/infrastructure/filesystem/file-transfer-service.mjs";
import { FileTransferStore } from "../../src/infrastructure/persistence/file-transfer-store.mjs";

async function fixture({ now = Date.now, instanceId, policyOverrides = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-transfer-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await mkdir(workspace, { recursive: true });
  const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test", ...policyOverrides });
  const key = randomBytes(32);
  const keyring = { currentKid: "test-v1", keys: { "test-v1": key } };
  const store = new FileTransferStore({ dataDir, policy, now, instanceId });
  const service = new FileTransferService({ dataDir, roots: [workspace], store, policy, keyring });
  return { dataDir, key, policy, root, service, store, workspace };
}

test("transfer filenames truncate by code point and totalize lone surrogates", () => {
  const boundary = transferFilename("a".repeat(179) + "🧪.bin");
  assert.equal([...boundary].length, 180);
  assert.equal(boundary.endsWith("🧪"), true);
  assert.doesNotMatch(boundary, /[\ud800-\udfff]/u);
  const malformed = transferFilename(`before-\ud83e-after.bin`);
  assert.equal(malformed, "before-�-after.bin");
  assert.doesNotThrow(() => encodeURIComponent(malformed));
});

async function proof(payload, privateKey, jkt, typ) {
  return new CompactSign(Buffer.from(payload))
    .setProtectedHeader({ alg: "ES256", typ, kid: jkt })
    .sign(privateKey);
}

async function childClaim(input) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/file-transfer-claim-worker.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(input));
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

async function childReserve(input) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/file-transfer-reserve-worker.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const stdout = [], stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(input));
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

async function startRevokeChild(input) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/file-transfer-revoke-worker.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const ready = new Promise((resolve) => child.stdout.once("data", resolve));
  child.stdin.end(JSON.stringify(input));
  await ready;
  return { child, stderr };
}

async function createClaimedTransfer(value, { owner, name, bytes }) {
  const source = path.join(value.workspace, name);
  await writeFile(source, bytes);
  const artifact = await value.service.prepare({ owner, sourcePath: source, requestId: `${owner}:prepare` });
  await value.service.waitForPreparation(artifact.id);
  const share = await value.service.createShare({ owner, artifactId: artifact.id,
    requestId: `${owner}:share`, ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const claimId = randomBytes(32).toString("base64url");
  const challenge = await value.service.createClaimChallenge({ kid, shareId, secret, claimId, publicJwk });
  const challengeReplay = await value.service.createClaimChallenge({ kid, shareId, secret, claimId, publicJwk });
  assert.equal(challengeReplay.payload, challenge.payload,
    "lost challenge response must recover the exact nonce without storing it raw");
  const signature = await proof(challenge.payload, privateKey, jkt, "agenthub-transfer-claim+jws");
  const session = await value.service.claim({ kid, shareId, secret, payload: challenge.payload,
    proof: signature, publicJwk });
  return { artifact, challenge, claimProof: signature, jkt, kid, privateKey, publicJwk,
    secret, session, shareId, source };
}

async function downloadIssuedShare(service, share) {
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const challenge = await service.createClaimChallenge({ kid, shareId, secret,
    claimId: randomBytes(32).toString("base64url"), publicJwk });
  const claimProof = await proof(challenge.payload, privateKey, jkt, "agenthub-transfer-claim+jws");
  const session = await service.claim({ kid, shareId, secret, payload: challenge.payload,
    proof: claimProof, publicJwk });
  const plan = await service.createPlan({ credential: session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: share.size - 1 });
  const planProof = await proof(plan.payload, privateKey, jkt, "agenthub-transfer-download+jws");
  const request = await service.activatePlan({ credential: session.credential,
    payload: plan.payload, proof: planProof, ipHash: `ip:${shareId}` });
  const chunks = [];
  const finalize = await service.streamPlan(request, {
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    waitForDrain: async () => {},
  });
  await finalize(true);
  return Buffer.concat(chunks);
}

test("file transfer preparation creates an immutable managed snapshot and explicit share", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const source = path.join(value.workspace, "пример.bin");
  const bytes = Buffer.concat([Buffer.alloc(64 * 1024, 0x61), Buffer.from("tail")]);
  await writeFile(source, bytes);

  const preparing = await value.service.prepare({
    owner: "device:one", sourcePath: source, requestId: "prepare-1",
  });
  assert.equal(preparing.state, "preparing");
  await value.service.waitForPreparation(preparing.id);
  const ready = await value.service.status("device:one", preparing.id);
  assert.equal(ready.state, "ready");
  assert.equal(ready.size, bytes.length);
  assert.equal(ready.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(await readFile(value.service.artifactPath(preparing.id)), bytes);

  const share = await value.service.createShare({ owner: "device:one", artifactId: preparing.id,
    requestId: "share-1", ttlMs: 3_600_000 });
  assert.equal(share.state, "ready");
  assert.equal(share.name, "пример.bin");
  assert.equal(share.size, bytes.length);
  assert.equal(share.sha256, ready.sha256);
  assert.equal(share.bytesServed, 0);
  assert.equal(share.claimedAt, null);
  assert.match(share.url, /^https:\/\/files\.example\.test\/transfer\/#v1\.test-v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
  const ownerStatus = await value.service.ownerStatus("device:one", source);
  assert.deepEqual(ownerStatus.share, share,
    "create must return the same complete persisted view and capability as owner status");
  await writeFile(source, Buffer.from("changed source"));
  assert.deepEqual(await readFile(value.service.artifactPath(preparing.id)), bytes,
    "the managed snapshot must not follow later source changes");
  const staleStatus = await value.service.ownerStatus("device:one", source);
  assert.equal(staleStatus.artifact, null, "changed source identity must not project an old ready snapshot");
  assert.equal(staleStatus.share, null, "changed source identity must not project an old share as current");
  const [, , kid, shareId, secret] = /^https:\/\/[^/]+\/transfer\/#(v1)\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  const inspected = await value.service.inspect({ kid, shareId, secret });
  assert.equal(inspected.name, "пример.bin");
  assert.equal(inspected.size, bytes.length);

  const databaseBytes = await readFile(path.join(value.dataDir, "runtime.sqlite"));
  assert.equal(databaseBytes.includes(Buffer.from(secret)), false, "raw capability must not be stored");
  for (const name of (await readdir(value.dataDir)).filter((entry) => entry.startsWith("runtime.sqlite-"))) {
    assert.equal((await readFile(path.join(value.dataDir, name))).includes(Buffer.from(secret)), false,
      `raw capability must not be stored in ${name}`);
  }
});

test("one early capability waits without claim and becomes ready after immutable publication and restart", async (t) => {
  const value = await fixture();
  const services = [value.service];
  t.after(async () => {
    await Promise.all(services.map((service) => service.close().catch(() => {})));
    await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const owner = "device:early-link";
  const source = path.join(value.workspace, "early-link.bin");
  const bytes = Buffer.alloc(2 * TRANSFER_BLOCK_BYTES, 0x45);
  await writeFile(source, bytes);
  const addBlocks = value.store.addBlocks.bind(value.store);
  let copyReachedResolve;
  let releaseCopyResolve;
  const copyReached = new Promise((resolve) => { copyReachedResolve = resolve; });
  const releaseCopy = new Promise((resolve) => { releaseCopyResolve = resolve; });
  value.store.addBlocks = async (...args) => {
    copyReachedResolve();
    await releaseCopy;
    return addBlocks(...args);
  };

  const artifact = await value.service.prepare({ owner, sourcePath: source, requestId: "early:prepare" });
  await copyReached;
  const share = await value.service.createShare({ owner, sourcePath: source, artifactId: artifact.id,
    requestId: "early:share", ttlMs: 3_600_000 });
  assert.equal(share.state, "preparing");
  assert.match(share.url, /#v1\.test-v1\./u);
  const lostResponseReplay = await value.service.createShare({ owner, sourcePath: source, artifactId: artifact.id,
    requestId: "early:share", ttlMs: 3_600_000 });
  assert.equal(lostResponseReplay.url, share.url);
  assert.equal(lostResponseReplay.state, "preparing");
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  const waiting = await Promise.all(Array.from({ length: 32 }, () => value.service.inspect({ kid, shareId, secret })));
  assert.equal(waiting.every((item) => item.state === "preparing" && item.sha256 === null), true,
    "concurrent early opens must observe waiting without partial publication");
  const { publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  await assert.rejects(value.service.createClaimChallenge({ kid, shareId, secret,
    claimId: randomBytes(32).toString("base64url"), publicJwk }), /transfer-unavailable/u,
  "a waiting capability must not admit claim or bytes");

  releaseCopyResolve();
  await value.service.waitForPreparation(artifact.id);
  const ready = await value.service.inspect({ kid, shareId, secret });
  assert.equal(ready.state, "ready");
  assert.equal(ready.sha256, createHash("sha256").update(bytes).digest("hex"));
  const replay = await value.service.createShare({ owner, sourcePath: source, artifactId: artifact.id,
    requestId: "early:share", ttlMs: 3_600_000 });
  assert.equal(replay.url, share.url, "publication must not rotate the early capability");
  assert.equal(replay.state, "ready");

  await value.service.close();
  const restartedStore = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy,
    instanceId: "early-restarted" });
  const restarted = new FileTransferService({ dataDir: value.dataDir, roots: [value.workspace],
    store: restartedStore, policy: value.policy,
    keyring: { currentKid: "test-v1", keys: { "test-v1": value.key } } });
  services.push(restarted);
  assert.equal((await restarted.inspect({ kid, shareId, secret })).state, "ready");
  assert.equal((await restarted.ownerStatus(owner, source)).share.url, share.url);
  assert.deepEqual(await downloadIssuedShare(restarted, replay), bytes);
});

test("early capability expiry and revoke remain terminal after publication", async (t) => {
  let now = Date.now();
  const value = await fixture({ now: () => now });
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const owner = "device:early-terminal";
  const source = path.join(value.workspace, "early-terminal.bin");
  await writeFile(source, Buffer.alloc(2 * TRANSFER_BLOCK_BYTES, 0x54));
  const addBlocks = value.store.addBlocks.bind(value.store);
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  value.store.addBlocks = async (...args) => { reachedResolve(); await release; return addBlocks(...args); };
  const artifact = await value.service.prepare({ owner, sourcePath: source, requestId: "terminal:prepare" });
  await reached;
  const share = await value.service.createShare({ owner, sourcePath: source, artifactId: artifact.id,
    requestId: "terminal:share", ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  assert.equal((await value.service.inspect({ kid, shareId, secret })).state, "preparing");
  assert.equal((await value.service.revoke(owner, shareId)).state, "revoked");
  assert.equal((await value.service.inspect({ kid, shareId, secret })).state, "revoked");
  releaseResolve();
  await value.service.waitForPreparation(artifact.id);
  assert.equal((await value.service.inspect({ kid, shareId, secret })).state, "revoked");

  const secondSource = path.join(value.workspace, "early-expiry.bin");
  await writeFile(secondSource, Buffer.alloc(TRANSFER_BLOCK_BYTES, 0x58));
  const second = await value.service.prepare({ owner, sourcePath: secondSource, requestId: "expiry:prepare" });
  const expiring = await value.service.createShare({ owner, sourcePath: secondSource, artifactId: second.id,
    requestId: "expiry:share", ttlMs: 3_600_000 });
  const [, expiryKid, expiryShareId, expirySecret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(expiring.url);
  now += 3_600_001;
  assert.equal((await value.service.inspect({ kid: expiryKid, shareId: expiryShareId, secret: expirySecret })).state,
    "expired");
  await assert.rejects(value.service.waitForPreparation(second.id), /transfer-preparation-unavailable/u);
  assert.equal((await value.service.inspect({ kid: expiryKid, shareId: expiryShareId, secret: expirySecret })).state,
    "expired");
});

test("explicit preparation cancellation keeps the early link terminal and publishes no bytes", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const owner = "device:early-cancel";
  const source = path.join(value.workspace, "early-cancel.bin");
  await writeFile(source, Buffer.alloc(2 * TRANSFER_BLOCK_BYTES, 0x43));
  const addBlocks = value.store.addBlocks.bind(value.store);
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  value.store.addBlocks = async (...args) => { reachedResolve(); await release; return addBlocks(...args); };
  const artifact = await value.service.prepare({ owner, sourcePath: source, requestId: "cancel:prepare" });
  await reached;
  const share = await value.service.createShare({ owner, sourcePath: source, artifactId: artifact.id,
    requestId: "cancel:share", ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  assert.equal((await value.service.cancelPreparation(owner, artifact.id)).state, "failed");
  assert.equal((await value.service.inspect({ kid, shareId, secret })).state, "cancelled");
  releaseResolve();
  await assert.rejects(value.service.waitForPreparation(artifact.id), /transfer-preparation-cancelled/u);
  assert.equal((await value.service.inspect({ kid, shareId, secret })).state, "cancelled");
  await assert.rejects(readFile(value.service.artifactPath(artifact.id)), { code: "ENOENT" });
});

test("stale preparation recovery after restart keeps the early capability terminal", async (t) => {
  let now = Date.now();
  const value = await fixture({ now: () => now, instanceId: "early-crashed" });
  const services = [value.service];
  t.after(async () => {
    await Promise.all(services.map((service) => service.close().catch(() => {})));
    await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const owner = "device:early-recovery";
  const source = path.join(value.workspace, "early-recovery.bin");
  await writeFile(source, Buffer.alloc(2 * TRANSFER_BLOCK_BYTES, 0x52));
  const addBlocks = value.store.addBlocks.bind(value.store);
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  value.store.addBlocks = async (...args) => { reachedResolve(); await release; return addBlocks(...args); };
  const artifact = await value.service.prepare({ owner, sourcePath: source, requestId: "recovery:prepare" });
  await reached;
  const share = await value.service.createShare({ owner, sourcePath: source, artifactId: artifact.id,
    requestId: "recovery:share", ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  now += 31_000;
  const recoveredStore = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy,
    now: () => now, instanceId: "early-recovered", isAlive: () => false });
  const recovered = new FileTransferService({ dataDir: value.dataDir, roots: [value.workspace],
    store: recoveredStore, policy: value.policy,
    keyring: { currentKid: "test-v1", keys: { "test-v1": value.key } } });
  services.push(recovered);
  assert.equal((await recovered.status(owner, artifact.id)).state, "failed");
  assert.equal((await recovered.inspect({ kid, shareId, secret })).state, "failed");
  releaseResolve();
  await assert.rejects(value.service.waitForPreparation(artifact.id), /transfer-preparation-cancelled/u);
});

test("same-path same-size replacement creates one new snapshot while the old share keeps its bytes", async (t) => {
  const value = await fixture();
  const services = [value.service];
  t.after(async () => {
    await Promise.all(services.map((service) => service.close().catch(() => {})));
    await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const owner = "device:replacement";
  const source = path.join(value.workspace, "same-path.bin");
  const bytesA = Buffer.alloc(2 * TRANSFER_BLOCK_BYTES, 0x41);
  const bytesB = Buffer.alloc(bytesA.length, 0x42);
  await writeFile(source, bytesA);
  const artifactA = await value.service.prepare({ owner, sourcePath: source, requestId: "prepare-a" });
  await value.service.waitForPreparation(artifactA.id);
  const shareA = await value.service.createShare({ owner, artifactId: artifactA.id,
    requestId: "share-a", ttlMs: 3_600_000 });

  await writeFile(source, bytesB);
  const stale = await value.service.ownerStatus(owner, source);
  assert.equal(stale.artifact, null);
  assert.equal(stale.share, null);
  await assert.rejects(value.service.createShare({ owner, sourcePath: source, artifactId: artifactA.id,
    requestId: "share-stale-a", ttlMs: 3_600_000 }), /transfer-source-changed/u,
  "backend share creation must reject a stale artifact even if a client cached its id");

  const secondStore = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy,
    instanceId: "replacement-concurrent" });
  const second = new FileTransferService({ dataDir: value.dataDir, roots: [value.workspace],
    store: secondStore, policy: value.policy,
    keyring: { currentKid: "test-v1", keys: { "test-v1": value.key } } });
  services.push(second);
  const [left, right] = await Promise.all([
    value.service.prepare({ owner, sourcePath: source, requestId: "prepare-b-left" }),
    second.prepare({ owner, sourcePath: source, requestId: "prepare-b-right" }),
  ]);
  assert.equal(left.id, right.id, "concurrent creates for one physical source version must converge");
  assert.notEqual(left.id, artifactA.id);
  await Promise.all([value.service.waitForPreparation(left.id), second.waitForPreparation(left.id)]);
  const artifactB = await value.service.status(owner, left.id);
  assert.equal(artifactB.state, "ready");
  assert.equal(artifactB.sha256, createHash("sha256").update(bytesB).digest("hex"));
  assert.deepEqual(await readFile(value.service.artifactPath(artifactB.id)), bytesB);

  await value.service.close();
  await second.close();
  const restartedStore = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy,
    instanceId: "replacement-restarted" });
  const restarted = new FileTransferService({ dataDir: value.dataDir, roots: [value.workspace],
    store: restartedStore, policy: value.policy,
    keyring: { currentKid: "test-v1", keys: { "test-v1": value.key } } });
  services.push(restarted);
  const afterRestart = await restarted.ownerStatus(owner, source);
  assert.equal(afterRestart.artifact.id, artifactB.id);
  const reused = await restarted.prepare({ owner, sourcePath: source, requestId: "prepare-b-reuse" });
  assert.equal(reused.id, artifactB.id, "unchanged source may reuse its persisted ready snapshot");
  const shareB = await restarted.createShare({ owner, artifactId: artifactB.id,
    requestId: "share-b", ttlMs: 3_600_000 });

  const downloadedA = await downloadIssuedShare(restarted, shareA);
  const downloadedB = await downloadIssuedShare(restarted, shareB);
  assert.deepEqual(downloadedA, bytesA, "the old capability remains bound to immutable A bytes");
  assert.deepEqual(downloadedB, bytesB, "the new capability downloads replacement B bytes");
  assert.equal(createHash("sha256").update(downloadedA).digest("hex"), shareA.sha256);
  assert.equal(createHash("sha256").update(downloadedB).digest("hex"), shareB.sha256);
});

test("expired ready snapshot is not reused before GC while its prepare receipt still replays", async (t) => {
  let now = Date.now();
  const value = await fixture({ now: () => now });
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const owner = "device:expired-snapshot";
  const source = path.join(value.workspace, "expires.bin");
  const bytes = Buffer.alloc(64 * 1024, 0x65);
  await writeFile(source, bytes);

  const first = await value.service.prepare({ owner, sourcePath: source, requestId: "expires:prepare:old" });
  await value.service.waitForPreparation(first.id);
  const ready = await value.service.status(owner, first.id);
  assert.equal(ready.state, "ready");

  now = ready.expiresAt + 1;
  const replacement = await value.service.prepare({ owner, sourcePath: source, requestId: "expires:prepare:new" });
  assert.notEqual(replacement.id, first.id, "a new request must not reuse an expired ready snapshot");
  await value.service.waitForPreparation(replacement.id);
  assert.equal((await value.service.status(owner, replacement.id)).sha256,
    createHash("sha256").update(bytes).digest("hex"));

  const replay = await value.service.prepare({ owner, sourcePath: source, requestId: "expires:prepare:old" });
  assert.equal(replay.id, first.id, "the original request id must retain its exact durable receipt");
  assert.equal(replay.expiresAt, ready.expiresAt);
  assert.deepEqual(await readFile(value.service.artifactPath(first.id)), bytes,
    "creating the replacement must not mutate or delete the old managed bytes before GC");
});

test("pathless owner create permits only exact replay and cannot issue stale bytes", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const owner = "device:legacy-owner";
  const source = path.join(value.workspace, "legacy-owner.bin");
  const oldBytes = Buffer.alloc(64 * 1024, 0x31);
  const newBytes = Buffer.alloc(oldBytes.length, 0x32);
  await writeFile(source, oldBytes);
  const artifact = await value.service.prepare({ owner, sourcePath: source, requestId: "legacy:prepare" });
  await value.service.waitForPreparation(artifact.id);
  const issued = await value.service.createShare({ owner, sourcePath: source, artifactId: artifact.id,
    requestId: "legacy:share", ttlMs: 3_600_000 });

  const replay = await value.service.createShare({ owner, artifactId: artifact.id,
    requestId: "legacy:share", ttlMs: 3_600_000, replayOnly: true });
  assert.deepEqual(replay, issued, "a lost response from the old client must recover the persisted share");

  await writeFile(source, newBytes);
  await assert.rejects(value.service.createShare({ owner, artifactId: artifact.id,
    requestId: "legacy:new-share", ttlMs: 3_600_000, replayOnly: true }),
  (error) => error?.code === "transfer-client-refresh-required" && error?.statusCode === 409,
  "a pathless new request must fail closed instead of issuing the old artifact");
  assert.deepEqual(await downloadIssuedShare(value.service, issued), oldBytes,
    "the replayed old capability remains bound to its original immutable bytes");
});

test("same-size replacement during preparation fails closed without publishing mixed bytes", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const owner = "device:preparation-replacement";
  const source = path.join(value.workspace, "preparation-race.bin");
  const bytesA = Buffer.alloc(129 * TRANSFER_BLOCK_BYTES, 0x61);
  const bytesB = Buffer.alloc(bytesA.length, 0x62);
  await writeFile(source, bytesA);
  const addBlocks = value.store.addBlocks.bind(value.store);
  let replaced = false;
  let reachedResolve;
  let releaseResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  value.store.addBlocks = async (...args) => {
    if (!replaced) {
      replaced = true;
      reachedResolve();
      await release;
      await writeFile(source, bytesB);
    }
    return addBlocks(...args);
  };
  const artifact = await value.service.prepare({ owner, sourcePath: source, requestId: "prepare-race" });
  await reached;
  const early = await value.service.createShare({ owner, sourcePath: source, artifactId: artifact.id,
    requestId: "prepare-race-share", ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(early.url);
  assert.equal((await value.service.inspect({ kid, shareId, secret })).state, "preparing");
  releaseResolve();
  await assert.rejects(value.service.waitForPreparation(artifact.id), /transfer-source-changed/u);
  assert.equal(replaced, true);
  assert.equal((await value.service.status(owner, artifact.id)).state, "failed");
  assert.equal((await value.service.inspect({ kid, shareId, secret })).state, "failed");
  await assert.rejects(readFile(value.service.artifactPath(artifact.id)), { code: "ENOENT" });

  const replacement = await value.service.prepare({ owner, sourcePath: source, requestId: "prepare-after-race" });
  await value.service.waitForPreparation(replacement.id);
  assert.notEqual(replacement.id, artifact.id);
  assert.deepEqual(await readFile(value.service.artifactPath(replacement.id)), bytesB);
});

test("legacy ready artifacts without source identity migrate fail-closed and are never reused", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-transfer-identity-migration-"));
  const databasePath = path.join(root, "runtime.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE transfer_artifacts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_key TEXT NOT NULL, request_id TEXT NOT NULL,
    name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0), sha256 TEXT, identity_json TEXT,
    state TEXT NOT NULL CHECK(state IN ('preparing','publishing','ready','failed','deleting','deleted')),
    prepared_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    pid INTEGER NOT NULL, instance_id TEXT NOT NULL, UNIQUE(owner,request_id));`);
  legacy.prepare(`INSERT INTO transfer_artifacts
    (id,owner,source_key,request_id,name,size,sha256,identity_json,state,prepared_bytes,created_at,expires_at,pid,instance_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "device:legacy",
    "source:legacy", "legacy-request", "legacy.bin", 1, createHash("sha256").update("a").digest("hex"),
    "{}", "ready", 1, Date.now(), Date.now() + 86_400_000, process.pid, "legacy-instance");
  legacy.close();

  const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test" });
  const store = new FileTransferStore({ dataDir: root, policy, instanceId: "migration-instance" });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  await store.initialize();
  const sourceIdentity = { dev: "1", ino: "2", size: 1, mtimeNs: "3", ctimeNs: "4" };
  assert.equal(await store.ownerFile("device:legacy", ["source:legacy"], sourceIdentity), null,
    "unknown legacy identity must not project stale ready state");
  const replacement = await store.reserve({ owner: "device:legacy", sourceKey: "source:legacy",
    sourceIdentity, requestId: "replacement-request", name: "legacy.bin", size: 1,
    availableBytes: 2 * 1024 ** 3 });
  assert.notEqual(replacement.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(migrated.prepare("SELECT count(*) n FROM pragma_table_info('transfer_artifacts') WHERE name='source_identity_json'").get().n, 1);
    assert.equal(migrated.prepare("SELECT count(*) n FROM pragma_table_info('transfer_artifacts') WHERE name='failure_code'").get().n, 1);
  } finally { migrated.close(); }
});

test("atomic PoP claim has exactly one winner across independent store connections", async (t) => {
  const value = await fixture();
  const source = path.join(value.workspace, "race.bin");
  await writeFile(source, Buffer.alloc(128 * 1024, 0x7b));
  const artifact = await value.service.prepare({ owner: "device:race", sourcePath: source, requestId: "prepare-race" });
  await value.service.waitForPreparation(artifact.id);
  const issued = await value.service.createShare({ owner: "device:race", artifactId: artifact.id,
    requestId: "share-race", ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(issued.url);
  const second = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy });
  await second.initialize();
  const secondService = new FileTransferService({ dataDir: value.dataDir, roots: [value.workspace],
    store: second, policy: value.policy, keyring: { currentKid: "test-v1", keys: { "test-v1": value.key } } });
  t.after(async () => {
    await second.close();
    await value.service.close();
    await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const attempts = [];
  for (let index = 0; index < 100; index += 1) {
    const target = index % 2 ? value.service : secondService;
    const claimId = randomBytes(32).toString("base64url");
    const challenge = await target.createClaimChallenge({ kid, shareId, secret, claimId, publicJwk });
    const proof = await new CompactSign(Buffer.from(challenge.payload))
      .setProtectedHeader({ alg: "ES256", typ: "agenthub-transfer-claim+jws", kid: jkt })
      .sign(privateKey);
    attempts.push({ target, payload: challenge.payload, proof });
  }
  const results = await Promise.allSettled(attempts.map(({ target, payload, proof }) => (
    target.claim({ kid, shareId, secret, payload, proof, publicJwk })
  )));
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.match(winners[0].value.id, /^[0-9a-f-]{36}$/u);
  assert.match(winners[0].value.credential, /^v1\.test-v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
  assert.equal((await value.service.inspect({ kid, shareId, secret })).state, "claimed",
    "the exact capability may report that another recipient already claimed it without reopening claim");
});

test("lost create and claim responses replay byte-identically across key rotation", async (t) => {
  const value = await fixture();
  const bytes = Buffer.alloc(64 * 1024, 0x4b);
  const source = path.join(value.workspace, "rotation.bin");
  await writeFile(source, bytes);
  const artifact = await value.service.prepare({ owner: "device:rotation", sourcePath: source,
    requestId: "rotation:prepare" });
  await value.service.waitForPreparation(artifact.id);
  const firstShare = await value.service.createShare({ owner: "device:rotation", artifactId: artifact.id,
    requestId: "rotation:share", ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(firstShare.url);
  const key2 = randomBytes(32);
  const rotatedStore = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy });
  const rotated = new FileTransferService({ dataDir: value.dataDir, roots: [value.workspace],
    store: rotatedStore, policy: value.policy, keyring: { currentKid: "test-v2", keys: {
      "test-v1": { secret: value.key, status: "verify_only" },
      "test-v2": { secret: key2, status: "active" },
    } } });
  t.after(async () => {
    await rotated.close(); await value.service.close(); await rm(value.root, { recursive: true, force: true });
  });
  const replayedShare = await rotated.createShare({ owner: "device:rotation", artifactId: artifact.id,
    requestId: "rotation:share", ttlMs: 3_600_000 });
  assert.deepEqual(replayedShare, firstShare,
    "lost create response replay must recover the byte-equivalent canonical share view");

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const challenge = await value.service.createClaimChallenge({ kid, shareId, secret,
    claimId: randomBytes(32).toString("base64url"), publicJwk });
  const signed = await proof(challenge.payload, privateKey, jkt, "agenthub-transfer-claim+jws");
  const firstSession = await value.service.claim({ kid, shareId, secret, payload: challenge.payload,
    proof: signed, publicJwk });
  const replayedSession = await rotated.claim({ kid, shareId, secret, payload: challenge.payload,
    proof: signed, publicJwk });
  assert.equal(replayedSession.credential, firstSession.credential);
  const plan = await rotated.createPlan({ credential: replayedSession.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  assert.match(plan.payload, /"purpose":"download"/u);
  assert.match(JSON.parse(plan.payload).path, /^\/transfer\/api\/session\/[A-Za-z0-9_-]{43}\/download$/u);

  const missingStore = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy });
  const missing = new FileTransferService({ dataDir: value.dataDir, roots: [value.workspace],
    store: missingStore, policy: value.policy, keyring: { currentKid: "test-v2", keys: { "test-v2": key2 } } });
  await assert.rejects(missing.createShare({ owner: "device:rotation", artifactId: artifact.id,
    requestId: "rotation:share", ttlMs: 3_600_000 }), /transfer-unavailable/u);
  await missing.close();
});

test("lost prepare responses replay exactly across rotation and reject unavailable or changed identities", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-prepare-rotation-"));
  const services = [];
  t.after(async () => {
    await Promise.allSettled(services.map((service) => service.close()));
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace"), dataDir = path.join(root, "data");
  await mkdir(path.join(workspace, "one"), { recursive: true });
  await mkdir(path.join(workspace, "two"), { recursive: true });
  const source = path.join(workspace, "one", "same.bin");
  const changedSource = path.join(workspace, "two", "same.bin");
  const bytes = Buffer.alloc(64 * 1024, 0x31);
  await writeFile(source, bytes);
  await writeFile(changedSource, bytes);
  const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test" });
  const key1 = randomBytes(32), key2 = randomBytes(32);
  const firstStore = new FileTransferStore({ dataDir, policy, instanceId: "prepare-k1" });
  const first = new FileTransferService({ dataDir, roots: [workspace], store: firstStore, policy,
    keyring: { currentKid: "prepare-k1", keys: {
      "prepare-k1": { secret: key1, status: "active" },
      "prepare-k2": { secret: key2, status: "verify_only" },
    } } });
  services.push(first);
  const initial = await first.prepare({ owner: "device:prepare-rotation", sourcePath: source,
    requestId: "prepare:lost-response" });
  await first.waitForPreparation(initial.id);
  await first.close();

  const rotatedStore = new FileTransferStore({ dataDir, policy, instanceId: "prepare-k2" });
  const rotated = new FileTransferService({ dataDir, roots: [workspace], store: rotatedStore, policy,
    keyring: { currentKid: "prepare-k2", keys: {
      "prepare-k1": { secret: key1, status: "verify_only" },
      "prepare-k2": { secret: key2, status: "active" },
    } } });
  services.push(rotated);
  const replay = await rotated.prepare({ owner: "device:prepare-rotation", sourcePath: source,
    requestId: "prepare:lost-response" });
  assert.equal(replay.id, initial.id);
  assert.equal(replay.reserved, false, "exact replay must not copy the source again");
  await assert.rejects(rotated.prepare({ owner: "device:prepare-rotation", sourcePath: changedSource,
    requestId: "prepare:lost-response" }), /transfer-request-conflict/u);

  const before = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  const artifactCount = before.prepare("SELECT count(*) n FROM transfer_artifacts").get().n;
  const auditCount = before.prepare("SELECT count(*) n FROM transfer_audit").get().n;
  before.close();
  const missingStore = new FileTransferStore({ dataDir, policy, instanceId: "prepare-missing-k1" });
  const missing = new FileTransferService({ dataDir, roots: [workspace], store: missingStore, policy,
    keyring: { currentKid: "prepare-k2", keys: { "prepare-k2": key2 } } });
  services.push(missing);
  await assert.rejects(missing.prepare({ owner: "device:prepare-rotation", sourcePath: source,
    requestId: "prepare:lost-response" }), (error) => error?.code === "transfer-unavailable"
      && error?.statusCode === 410);
  const after = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  assert.equal(after.prepare("SELECT count(*) n FROM transfer_artifacts").get().n, artifactCount);
  assert.equal(after.prepare("SELECT count(*) n FROM transfer_audit").get().n, auditCount,
    "missing retired issuance key must not mutate transfer state");
  after.close();
  await missing.close();
  await rotated.close();
});

test("concurrent prepare during rotation creates one artifact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-prepare-rotation-race-"));
  const workspace = path.join(root, "workspace"), dataDir = path.join(root, "data");
  await mkdir(workspace, { recursive: true });
  const source = path.join(workspace, "race.bin");
  await writeFile(source, Buffer.alloc(128 * 1024, 0x52));
  const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test" });
  const key1 = randomBytes(32), key2 = randomBytes(32);
  const store1 = new FileTransferStore({ dataDir, policy, instanceId: "prepare-race-k1" });
  const store2 = new FileTransferStore({ dataDir, policy, instanceId: "prepare-race-k2" });
  const first = new FileTransferService({ dataDir, roots: [workspace], store: store1, policy,
    keyring: { currentKid: "race-k1", keys: {
      "race-k1": { secret: key1, status: "active" }, "race-k2": { secret: key2, status: "verify_only" },
    } } });
  const second = new FileTransferService({ dataDir, roots: [workspace], store: store2, policy,
    keyring: { currentKid: "race-k2", keys: {
      "race-k1": { secret: key1, status: "verify_only" }, "race-k2": { secret: key2, status: "active" },
    } } });
  t.after(async () => { await Promise.all([first.close(), second.close()]); await rm(root, { recursive: true, force: true }); });
  await Promise.all([first.initialize(), second.initialize()]);
  const results = await Promise.all([first, second].map((service) => service.prepare({
    owner: "device:prepare-race", sourcePath: source, requestId: "prepare:rotation-race",
  })));
  assert.equal(results[0].id, results[1].id);
  assert.equal(results.filter((artifact) => artifact.reserved).length, 1);
  await (results[0].reserved ? first : second).waitForPreparation(results[0].id);
  const database = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  assert.equal(database.prepare("SELECT count(*) n FROM transfer_artifacts WHERE owner=? AND request_id=?")
    .get("device:prepare-race", "prepare:rotation-race").n, 1);
  database.close();
});

test("atomic PoP claim has exactly one winner across child processes", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const source = path.join(value.workspace, "process-race.bin");
  await writeFile(source, Buffer.alloc(64 * 1024, 0x5a));
  const artifact = await value.service.prepare({ owner: "device:process", sourcePath: source,
    requestId: "process:prepare" });
  await value.service.waitForPreparation(artifact.id);
  const share = await value.service.createShare({ owner: "device:process", artifactId: artifact.id,
    requestId: "process:share", ttlMs: 3_600_000 });
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const claims = [];
  for (let index = 0; index < 24; index += 1) {
    const claimId = randomBytes(32).toString("base64url");
    const challenge = await value.service.createClaimChallenge({ kid, shareId, secret, claimId, publicJwk });
    claims.push({ kid, shareId, secret, payload: challenge.payload,
      proof: await proof(challenge.payload, privateKey, jkt, "agenthub-transfer-claim+jws"), publicJwk });
  }
  await value.store.close();
  const results = await Promise.all(claims.map((claim) => childClaim({
    claim,
    dataDir: value.dataDir,
    key: value.key.toString("base64"),
    kid,
    policy: { enabled: true, publicBaseUrl: "https://files.example.test" },
  })));
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1);
  assert.match(winners[0].id, /^[0-9a-f-]{36}$/u);
});

test("signed exact plans reject copied credentials, sibling keys, alteration, and replay", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const bytes = Buffer.concat([Buffer.alloc(64 * 1024, 0x31), Buffer.from("verified-tail")]);
  const claimed = await createClaimedTransfer(value, { owner: "device:proof", name: "proof.bin", bytes });

  const replay = await value.service.claim({ kid: claimed.kid, shareId: claimed.shareId,
    secret: claimed.secret, payload: claimed.challenge.payload, proof: claimed.claimProof,
    publicJwk: claimed.publicJwk });
  assert.equal(replay.id, claimed.session.id);
  assert.equal(replay.credential, claimed.session.credential,
    "lost claim response must recover the same usable credential for the exact PoP envelope");
  const rawValues = [claimed.secret, claimed.session.credential.split(".").at(-1),
    JSON.parse(claimed.challenge.payload).nonce];
  for (const name of (await readdir(value.dataDir)).filter((entry) => entry.startsWith("runtime.sqlite"))) {
    const persisted = await readFile(path.join(value.dataDir, name));
    for (const raw of rawValues) assert.equal(persisted.includes(Buffer.from(raw)), false,
      `${name} must not contain raw transfer capabilities or nonces`);
  }

  const planRequestId = randomBytes(32).toString("base64url");
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: planRequestId, start: 0, end: bytes.length - 1 });
  const planReplay = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: planRequestId, start: 0, end: bytes.length - 1 });
  assert.equal(planReplay.payload, plan.payload, "lost plan response must recover the exact signed envelope");
  await assert.rejects(value.service.createPlan({ credential: claimed.session.credential,
    requestId: planRequestId, start: 1, end: bytes.length - 1 }), /transfer-request-conflict/u);
  const { privateKey: siblingPrivate, publicKey: siblingPublic } = await generateKeyPair("ES256", { extractable: true });
  const siblingJwk = await exportJWK(siblingPublic);
  const siblingJkt = await calculateJwkThumbprint(siblingJwk, "sha256");
  const siblingProof = await proof(plan.payload, siblingPrivate, siblingJkt, "agenthub-transfer-download+jws");
  await assert.rejects(value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: siblingProof, ipHash: "ip:one" }), /transfer-unavailable/u);

  const changed = JSON.stringify({ ...JSON.parse(plan.payload), end: bytes.length - 2 });
  const changedProof = await proof(changed, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  await assert.rejects(value.service.activatePlan({ credential: claimed.session.credential,
    payload: changed, proof: changedProof, ipHash: "ip:one" }), /transfer-unavailable/u);
  await assert.rejects(value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: "", ipHash: "ip:one" }), /transfer-unavailable/u,
  "an unsigned plan must be rejected before any request can emit bytes");

  const validProof = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: validProof, ipHash: "ip:one" });
  const output = [];
  const finish = await value.service.streamPlan(request, {
    write(chunk) { output.push(Buffer.from(chunk)); return true; }, waitForDrain: async () => {},
  });
  await finish(true);
  assert.deepEqual(Buffer.concat(output), bytes);
  await assert.rejects(value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: validProof, ipHash: "ip:one" }), /transfer-unavailable/u,
  "one signed plan must never stream twice");
});

test("output owner rejects overflow and makes writer uncertainty terminal", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const claimed = await createClaimedTransfer(value, { owner: "device:accounting",
    name: "accounting.bin", bytes: Buffer.alloc(128 * 1024, 0x42) });
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: 3 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:accounting" });
  let writes = 0;
  await assert.rejects(value.store.authorizeBlockOutput(request.id, 0, Buffer.alloc(5), () => { writes += 1; }),
    /transfer-output-block-mismatch/u);
  assert.equal(writes, 0, "a non-ledger block must be rejected before the writer is called");
  await value.store.finishRequest(request.id, request.instanceId, false);

  const nextPlan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: 65_535 });
  const nextProof = await proof(nextPlan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const next = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: nextPlan.payload, proof: nextProof, ipHash: "ip:accounting" });
  await assert.rejects(value.store.authorizeBlockOutput(next.id, 0, Buffer.alloc(64 * 1024, 0x42), () => {
    throw new Error("socket enqueue result unknown");
  }), /socket enqueue result unknown/u);
  const status = await value.service.list("device:accounting", claimed.source);
  assert.equal(status[0].state, "ambiguous_terminal");
  await assert.rejects(value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: 1 }),
    /transfer-unavailable/u, "ambiguous output must never reopen the session");
});

test("terminal output and backpressure failures never reopen a session", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(64 * 1024, 0x64);
  const claimed = await createClaimedTransfer(value, { owner: "device:drain", name: "drain.bin", bytes });
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:drain" });
  let writes = 0;
  await assert.rejects(value.service.streamPlan(request, {
    write() { writes += 1; return false; },
    waitForDrain: async () => { throw new Error("response closed while draining"); },
  }), /response closed while draining/u);
  assert.equal(writes, 1);
  assert.equal((await value.service.list("device:drain", claimed.source))[0].state, "ambiguous_terminal");
  await assert.rejects(value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 }),
  /transfer-unavailable/u);
});

test("paused drain permits no next write and post-effect SQLite contention never repeats writer", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(128 * 1024, 0x65);
  const claimed = await createClaimedTransfer(value, { owner: "device:paused", name: "paused.bin", bytes });
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:paused" });
  let releaseDrain;
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  let writes = 0;
  const streaming = value.service.streamPlan(request, {
    write() { writes += 1; return writes !== 1; }, waitForDrain: () => drain,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(writes, 1, "a false write must stop before the next managed block");
  releaseDrain();
  const finish = await streaming;
  assert.equal(writes, 2);
  await finish(true);

  const second = await fixture();
  t.after(async () => { await second.service.close(); await rm(second.root, { recursive: true, force: true }); });
  const oneBlock = Buffer.alloc(64 * 1024, 0x66);
  const busyClaimed = await createClaimedTransfer(second, { owner: "device:busy", name: "busy.bin", bytes: oneBlock });
  const busyPlan = await second.service.createPlan({ credential: busyClaimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: oneBlock.length - 1 });
  const busyProof = await proof(busyPlan.payload, busyClaimed.privateKey, busyClaimed.jkt, "agenthub-transfer-download+jws");
  const busyRequest = await second.service.activatePlan({ credential: busyClaimed.session.credential,
    payload: busyPlan.payload, proof: busyProof, ipHash: "ip:busy" });
  const blocker = new DatabaseSync(path.join(second.dataDir, "runtime.sqlite"));
  blocker.exec("PRAGMA busy_timeout=0");
  let busyWrites = 0;
  const busyFinish = await second.service.streamPlan(busyRequest, {
    write() {
      busyWrites += 1;
      blocker.exec("BEGIN IMMEDIATE");
      setTimeout(() => blocker.exec("COMMIT"), 75);
      return true;
    },
    waitForDrain: async () => {},
  });
  assert.equal(busyWrites, 1, "post-effect retry must never invoke the writer twice");
  await busyFinish(true);
  blocker.close();
});

test("source reparse points and managed artifact corruption fail closed before bytes", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const outside = path.join(value.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "outside.bin"), Buffer.from("outside"));
  const linked = path.join(value.workspace, "linked");
  try {
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(value.service.prepare({ owner: "device:reparse",
      sourcePath: path.join(linked, "outside.bin"), requestId: "reparse:prepare" }),
    /transfer-source-reparse-point|transfer-source-outside-workspace/u);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    t.diagnostic("junction creation is unavailable on this host; containment still rejects resolved outside paths");
    await assert.rejects(value.service.prepare({ owner: "device:reparse",
      sourcePath: path.join(outside, "outside.bin"), requestId: "reparse:outside" }),
    /transfer-source-outside-workspace/u);
  }

  const bytes = Buffer.alloc(64 * 1024, 0x61);
  const claimed = await createClaimedTransfer(value, { owner: "device:corrupt", name: "corrupt.bin", bytes });
  await writeFile(value.service.artifactPath(claimed.artifact.id), Buffer.alloc(bytes.length, 0x62));
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:corrupt" });
  let writes = 0;
  await assert.rejects(value.service.streamPlan(request, {
    write() { writes += 1; return true; }, waitForDrain: async () => {},
  }),
    /transfer-artifact-mismatch/u);
  assert.equal(writes, 0);
  const status = await value.service.list("device:corrupt", claimed.source);
  assert.equal(status[0].state, "failed");
});

test("missing managed artifact after activation aborts admission and releases the session", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(64 * 1024, 0x47);
  const claimed = await createClaimedTransfer(value, { owner: "device:missing", name: "missing.bin", bytes });
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:missing" });
  await rm(value.service.artifactPath(claimed.artifact.id), { force: true });
  let writes = 0;
  await assert.rejects(value.service.streamPlan(request, {
    write() { writes += 1; return true; }, waitForDrain: async () => {},
  }), /ENOENT/u);
  assert.equal(writes, 0);
  assert.equal((await value.service.list("device:missing", claimed.source))[0].state, "claimed");
  const replacement = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  assert.match(JSON.parse(replacement.payload).path, /^\/transfer\/api\/session\/[A-Za-z0-9_-]{43}\/download$/u);
});

test("pre-output close during artifact setup aborts without authorization or stream quota leak", async (t) => {
  const value = await fixture({ policyOverrides: { maxStreams: 1 } });
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(128 * 1024, 0x4b);
  const claimed = await createClaimedTransfer(value, { owner: "device:pre-output-close",
    name: "pre-output-close.bin", bytes });
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:pre-output-close" });

  const controller = new AbortController();
  const blockHashes = value.store.blockHashes.bind(value.store);
  value.store.blockHashes = async (...args) => {
    const result = await blockHashes(...args);
    controller.abort();
    return result;
  };
  let authorizeCalls = 0;
  let writes = 0;
  const authorizeBlockOutput = value.store.authorizeBlockOutput.bind(value.store);
  value.store.authorizeBlockOutput = async (...args) => {
    authorizeCalls += 1;
    return authorizeBlockOutput(...args);
  };

  await assert.rejects(value.service.streamPlan(request, {
    write() { writes += 1; return true; },
    waitForDrain: async () => {},
    signal: controller.signal,
  }), /transfer-output-aborted/u);
  assert.equal(authorizeCalls, 0, "a known close before output must not create output_candidate");
  assert.equal(writes, 0);

  const db = new DatabaseSync(path.join(value.dataDir, "runtime.sqlite"));
  try {
    const states = db.prepare(`SELECT r.state request_state,p.state plan_state,t.state share_state
      FROM transfer_requests r JOIN transfer_plans p ON p.id=r.plan_id
      JOIN transfer_sessions s ON s.id=r.session_id JOIN transfer_shares t ON t.id=s.share_id
      WHERE r.id=?`).get(request.id);
    assert.deepEqual({ ...states }, { request_state: "aborted", plan_state: "aborted", share_state: "claimed" });
    assert.equal(db.prepare("SELECT count(*) n FROM transfer_requests WHERE state IN ('active','output_candidate','terminal_candidate')").get().n, 0);
  } finally { db.close(); }

  const replacement = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const replacementProof = await proof(replacement.payload, claimed.privateKey, claimed.jkt,
    "agenthub-transfer-download+jws");
  const next = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: replacement.payload, proof: replacementProof, ipHash: "ip:pre-output-close" });
  await value.service.abortPlan(next);
});

test("abort during SQLite output admission contention commits no permit or writer effect", async (t) => {
  const value = await fixture({ policyOverrides: { maxStreams: 1 } });
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(64 * 1024, 0x4c);
  const claimed = await createClaimedTransfer(value, { owner: "device:admission-abort",
    name: "admission-abort.bin", bytes });
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:admission-abort" });

  const blocker = new DatabaseSync(path.join(value.dataDir, "runtime.sqlite"));
  blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  let authorizeEnteredResolve;
  const authorizeEntered = new Promise((resolve) => { authorizeEnteredResolve = resolve; });
  const authorizeBlockOutput = value.store.authorizeBlockOutput.bind(value.store);
  value.store.authorizeBlockOutput = async (...args) => {
    authorizeEnteredResolve();
    return authorizeBlockOutput(...args);
  };
  const controller = new AbortController();
  let writes = 0;
  let streamingSettled = false;
  const streaming = value.service.streamPlan(request, {
    write() { writes += 1; return true; },
    waitForDrain: async () => {},
    signal: controller.signal,
  });
  void streaming.then(() => { streamingSettled = true; }, () => { streamingSettled = true; });
  await authorizeEntered;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(streamingSettled, false, "external BEGIN IMMEDIATE must hold output admission pending");
  controller.abort();
  blocker.exec("COMMIT");
  blocker.close();
  await assert.rejects(streaming, /transfer-output-aborted/u);
  assert.equal(writes, 0);

  const db = new DatabaseSync(path.join(value.dataDir, "runtime.sqlite"));
  try {
    const states = db.prepare(`SELECT r.state request_state,r.bytes_authorized,r.bytes_enqueued,
      p.state plan_state,t.state share_state FROM transfer_requests r
      JOIN transfer_plans p ON p.id=r.plan_id JOIN transfer_sessions s ON s.id=r.session_id
      JOIN transfer_shares t ON t.id=s.share_id WHERE r.id=?`).get(request.id);
    assert.deepEqual({ ...states }, { request_state: "aborted", bytes_authorized: 0, bytes_enqueued: 0,
      plan_state: "aborted", share_state: "claimed" });
    assert.equal(db.prepare("SELECT count(*) n FROM transfer_requests WHERE state IN ('active','output_candidate','terminal_candidate')").get().n, 0);
  } finally { db.close(); }

  const replacement = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const replacementProof = await proof(replacement.payload, claimed.privateKey, claimed.jkt,
    "agenthub-transfer-download+jws");
  const next = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: replacement.payload, proof: replacementProof, ipHash: "ip:admission-abort" });
  await value.service.abortPlan(next);
});

test("cross-connection revoke fences the next block and permits at most one already authorized block", async (t) => {
  const value = await fixture();
  const second = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy });
  await second.initialize();
  t.after(async () => {
    await second.close();
    await value.service.close();
    await rm(value.root, { recursive: true, force: true });
  });
  const bytes = Buffer.alloc(128 * 1024, 0x73);
  const claimed = await createClaimedTransfer(value, { owner: "device:revoke", name: "revoke.bin", bytes });
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:revoke" });
  const output = [];
  const markerPath = path.join(value.root, "permit-committed.marker");
  const resultPath = path.join(value.root, "revoke-committed.json");
  const revokeChild = await startRevokeChild({ dataDir: value.dataDir, owner: "device:revoke",
    shareId: claimed.shareId, markerPath, resultPath, instanceId: "revoke-child" });
  await assert.rejects(value.store.authorizeBlockOutput(request.id, 0, bytes.subarray(0, 64 * 1024), (chunk) => {
    output.push(Buffer.from(chunk));
    writeFileSync(markerPath, "permit committed");
    const deadline = Date.now() + 5_000;
    while (!existsSync(resultPath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(existsSync(resultPath), true, "child revoke must commit inside the permit-to-writer window");
    return true;
  }), /transfer-output-accounting-conflict/u);
  const [childCode] = await new Promise((resolve) => revokeChild.child.once("close", (...args) => resolve(args)));
  assert.equal(childCode, 0, Buffer.concat(revokeChild.stderr).toString("utf8"));
  await assert.rejects(value.store.authorizeBlockOutput(request.id, 64 * 1024,
    bytes.subarray(64 * 1024), () => assert.fail("no post-revoke block may reach the writer")),
  /transfer-unavailable/u);
  assert.equal(Buffer.concat(output).length, 64 * 1024);
  await value.store.finishRequest(request.id, request.instanceId, false);
  const revoked = await second.revoke("device:revoke", claimed.shareId);
  assert.equal(revoked.state, "revoked");
});

test("stale boot epoch is recovered even when the old PID has been reused", async (t) => {
  let now = Date.now();
  const value = await fixture({ now: () => now, instanceId: "boot-before-restart" });
  const bytes = Buffer.alloc(64 * 1024, 0x28);
  const claimed = await createClaimedTransfer(value, { owner: "device:restart", name: "restart.bin", bytes });
  const plan = await value.service.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  const signed = await proof(plan.payload, claimed.privateKey, claimed.jkt, "agenthub-transfer-download+jws");
  await value.service.activatePlan({ credential: claimed.session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:restart" });
  await value.service.close();
  now += 31_000;
  const recoveredStore = new FileTransferStore({ dataDir: value.dataDir, policy: value.policy,
    now: () => now, instanceId: "boot-after-restart", isAlive: () => true });
  const recovered = new FileTransferService({ dataDir: value.dataDir, roots: [value.workspace],
    store: recoveredStore, policy: value.policy,
    keyring: { currentKid: "test-v1", keys: { "test-v1": value.key } } });
  t.after(async () => { await recovered.close(); await rm(value.root, { recursive: true, force: true }); });
  const status = await recovered.list("device:restart", claimed.source);
  assert.equal(status[0].state, "claimed");
  const resumed = await recovered.createPlan({ credential: claimed.session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: bytes.length - 1 });
  assert.match(resumed.payload, /"purpose":"download"/u);
});

test("preparation leases use boot epoch and release abandoned quota", async (t) => {
  let now = Date.now();
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-preparation-epoch-"));
  const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test", maxPreparations: 1 });
  const first = new FileTransferStore({ dataDir: root, policy, now: () => now,
    instanceId: "preparation-old", isAlive: () => true });
  const abandoned = await first.reserve({ owner: "device:epoch", sourceKey: "source:old",
    requestId: "epoch:old", name: "old.bin", size: 64 * 1024, availableBytes: 2 * 1024 ** 3 });
  await first.addBlocks(abandoned.id, [[0, createHash("sha256").update(Buffer.alloc(64 * 1024)).digest("hex")]], 64 * 1024);
  now += 20_000;
  await first.heartbeatPreparation(abandoned.id);
  await first.close();
  now += 20_000;
  const restarted = new FileTransferStore({ dataDir: root, policy, now: () => now,
    instanceId: "preparation-new", isAlive: () => true });
  t.after(async () => { await restarted.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await restarted.artifact("device:epoch", abandoned.id)).state, "preparing",
    "a live slow preparation heartbeat must survive beyond its original lease window");
  now += 31_000;
  assert.equal((await restarted.artifact("device:epoch", abandoned.id)).state, "failed");
  const replacement = await restarted.reserve({ owner: "device:epoch", sourceKey: "source:new",
    requestId: "epoch:new", name: "new.bin", size: 64 * 1024, availableBytes: 2 * 1024 ** 3 });
  assert.equal(replacement.state, "preparing");
});

test("stale and ordinary failed preparations are deleted before quota retry", async (t) => {
  const roots = [];
  t.after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
  });
  for (const failureKind of ["stale", "ordinary"]) {
    let now = Date.now();
    const root = await mkdtemp(path.join(os.tmpdir(), `agent-hub-failed-cleanup-${failureKind}-`));
    roots.push(root);
    const workspace = path.join(root, "workspace"), dataDir = path.join(root, "data");
    const artifacts = path.join(dataDir, "file-transfers", "artifacts");
    await mkdir(workspace, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const size = 64 * 1024;
    const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test",
      ownerBytes: size, storageBytes: size, maxArtifacts: 1, maxPreparations: 1, freeBytes: 0 });
    const oldStore = new FileTransferStore({ dataDir, policy, now: () => now,
      instanceId: `failed-cleanup-old-${failureKind}` });
    const old = await oldStore.reserve({ owner: "device:failed-cleanup", sourceKey: `source:${failureKind}`,
      requestId: `old:${failureKind}`, name: "old.bin", size, availableBytes: 2 * 1024 ** 3 });
    await writeFile(path.join(artifacts, `${old.id}.partial`), Buffer.alloc(size, 0x45));
    if (failureKind === "ordinary") await oldStore.failPreparation("device:failed-cleanup", old.id);
    await oldStore.close();
    if (failureKind === "stale") now += 31_000;

    const source = path.join(workspace, "new.bin");
    await writeFile(source, Buffer.alloc(size, 0x4e));
    const store = new FileTransferStore({ dataDir, policy, now: () => now,
      instanceId: `failed-cleanup-new-${failureKind}` });
    const service = new FileTransferService({ dataDir, roots: [workspace], store, policy,
      keyring: { currentKid: "cleanup-v1", keys: { "cleanup-v1": randomBytes(32) } } });
    const replacement = await service.prepare({ owner: "device:failed-cleanup", sourcePath: source,
      requestId: `new:${failureKind}` });
    assert.notEqual(replacement.id, old.id);
    assert.equal((await service.status("device:failed-cleanup", old.id)).state, "deleted");
    assert.equal(existsSync(path.join(artifacts, `${old.id}.partial`)), false);
    await service.waitForPreparation(replacement.id);
    await service.close();
  }
});

test("failed cleanup remains charged on unlink failure and resumes without double deletion", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-failed-cleanup-resume-"));
  const workspace = path.join(root, "workspace"), dataDir = path.join(root, "data");
  const artifacts = path.join(dataDir, "file-transfers", "artifacts");
  await mkdir(workspace, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const size = 64 * 1024;
  const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test",
    ownerBytes: size, storageBytes: size, maxArtifacts: 1, maxPreparations: 1, freeBytes: 0 });
  const store = new FileTransferStore({ dataDir, policy, instanceId: "cleanup-resume-owner" });
  const failed = await store.reserve({ owner: "device:cleanup-resume", sourceKey: "source:failed",
    requestId: "cleanup:failed", name: "failed.bin", size, availableBytes: 2 * 1024 ** 3 });
  await store.failPreparation("device:cleanup-resume", failed.id);
  const blockedPartial = path.join(artifacts, `${failed.id}.partial`);
  await mkdir(blockedPartial);
  const source = path.join(workspace, "replacement.bin");
  await writeFile(source, Buffer.alloc(size, 0x72));
  const service = new FileTransferService({ dataDir, roots: [workspace], store, policy,
    keyring: { currentKid: "cleanup-v1", keys: { "cleanup-v1": randomBytes(32) } } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(service.prepare({ owner: "device:cleanup-resume", sourcePath: source,
    requestId: "cleanup:replacement" }), /EISDIR|EPERM|operation not permitted|directory/iu);
  assert.equal((await service.status("device:cleanup-resume", failed.id)).state, "deleting");
  await assert.rejects(store.reserve({ owner: "device:cleanup-resume", sourceKey: "source:replacement",
    requestId: "cleanup:direct-retry", name: "replacement.bin", size, availableBytes: 2 * 1024 ** 3 }),
  /transfer-storage-quota/u);
  await rm(blockedPartial, { recursive: true, force: true });
  const secondStore = new FileTransferStore({ dataDir, policy, instanceId: "cleanup-resume-second" });
  const second = new FileTransferService({ dataDir, roots: [workspace], store: secondStore, policy,
    keyring: { currentKid: "cleanup-v1", keys: { "cleanup-v1": randomBytes(32) } } });
  await Promise.all([service.gc(), second.gc()]);
  const database = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  assert.equal(database.prepare("SELECT count(*) n FROM transfer_audit WHERE artifact_id=? AND event='gc-deleted'")
    .get(failed.id).n, 1, "concurrent cleanup must commit one durable deletion");
  database.close();
  const replacement = await service.prepare({ owner: "device:cleanup-resume", sourcePath: source,
    requestId: "cleanup:replacement" });
  await service.waitForPreparation(replacement.id);
  await second.close();
});

test("garbage collection never deletes a ready artifact with an active share", async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const source = path.join(value.workspace, "active-share.bin");
  await writeFile(source, Buffer.from("active share"));
  const artifact = await value.service.prepare({ owner: "device:active-share", sourcePath: source,
    requestId: "active:prepare" });
  await value.service.waitForPreparation(artifact.id);
  await value.service.createShare({ owner: "device:active-share", artifactId: artifact.id,
    requestId: "active:share", ttlMs: 3_600_000 });
  const database = new DatabaseSync(path.join(value.dataDir, "runtime.sqlite"));
  database.prepare("UPDATE transfer_artifacts SET expires_at=0 WHERE id=?").run(artifact.id);
  database.close();
  assert.deepEqual(await value.service.gc(), []);
  assert.equal(existsSync(value.service.artifactPath(artifact.id)), true);
  assert.equal((await value.service.status("device:active-share", artifact.id)).state, "ready");
});

test("physical capacity admission is atomic across child processes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-capacity-race-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const size = 2 * 1024 ** 3;
  const availableBytes = 3 * 1024 ** 3;
  const results = await Promise.all([0, 1].map((index) => childReserve({ dataDir: root,
    instanceId: `capacity-${index}`, owner: `device:capacity:${index}`, sourceKey: `source:${index}`,
    requestId: `capacity:${index}`, name: `${index}.bin`, size, availableBytes,
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && /transfer-storage-quota/u.test(result.message)).length, 1);
});

test("physical reservation never shrinks on progress and protects a zero-margin concurrent boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-capacity-progress-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test",
    freeBytes: 0, maxPreparations: 4 });
  const store = new FileTransferStore({ dataDir: root, policy, instanceId: "capacity-progress" });
  const first = await store.reserve({ owner: "device:capacity-progress", sourceKey: "source:first",
    requestId: "capacity:first", name: "first.bin", size: 600, availableBytes: 1_000 });
  const firstBytes = Buffer.alloc(600);
  const firstHash = createHash("sha256").update(firstBytes).digest("hex");
  await store.addBlocks(first.id, [[0, firstHash]], 600);
  await assert.rejects(store.reserve({ owner: "device:capacity-progress", sourceKey: "source:second",
    requestId: "capacity:second", name: "second.bin", size: 500, availableBytes: 1_000 }),
  /transfer-storage-quota/u);
  await store.publishing(first.id, firstHash);
  await store.ready(first.id, firstHash, { dev: "1", ino: "1", size: 600, mtimeNs: "1" });
  await assert.rejects(store.reserve({ owner: "device:capacity-progress", sourceKey: "source:after-ready",
    requestId: "capacity:after-ready", name: "after-ready.bin", size: 500, availableBytes: 1_000 }),
  /transfer-storage-quota/u, "READY transition must not release a physical reservation against stale statfs");
  await store.close();

  const size = 16 * 1024 ** 2;
  const results = await Promise.all([0, 1].map((index) => childReserve({ dataDir: root,
    instanceId: `zero-margin-${index}`, owner: `device:zero-margin:${index}`, sourceKey: `zero:${index}`,
    requestId: `zero:${index}`, name: `zero-${index}.bin`, size,
    availableBytes: 2 * size - 1, policyOverrides: { freeBytes: 0, maxPreparations: 4 },
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.code === "transfer-storage-quota").length, 1);
});

test("transfer audit rejects direct UPDATE and DELETE", async (t) => {
  const value = await fixture();
  const source = path.join(value.workspace, "audit.bin");
  await writeFile(source, Buffer.from("audit"));
  const artifact = await value.service.prepare({ owner: "device:audit", sourcePath: source,
    requestId: "audit:prepare" });
  await value.service.waitForPreparation(artifact.id);
  const database = new DatabaseSync(path.join(value.dataDir, "runtime.sqlite"));
  t.after(async () => {
    database.close(); await value.service.close(); await rm(value.root, { recursive: true, force: true });
  });
  const before = database.prepare("SELECT count(*) n FROM transfer_audit").get().n;
  assert.throws(() => database.exec("UPDATE transfer_audit SET event='tampered'"), /append only/u);
  assert.throws(() => database.exec("DELETE FROM transfer_audit"), /append only/u);
  assert.equal(database.prepare("SELECT count(*) n FROM transfer_audit").get().n, before);
});

test("publishing recovery handles exact crash windows fail closed", async (t) => {
  const cases = [
    { name: "partial-only", partial: true, completed: false, valid: true },
    { name: "completed-only", partial: false, completed: true, valid: true },
    { name: "both", partial: true, completed: true, valid: false },
    { name: "neither", partial: false, completed: false, valid: false },
    { name: "corrupt", partial: false, completed: true, valid: false, corrupt: true },
  ];
  for (const item of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `agent-hub-publish-${item.name}-`));
    const dataDir = path.join(root, "data"), workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://files.example.test" });
    const store = new FileTransferStore({ dataDir, policy, instanceId: `publish-${item.name}` });
    const bytes = Buffer.from("publish recovery bytes");
    const artifact = await store.reserve({ owner: "device:publish", sourceKey: item.name,
      requestId: item.name, name: `${item.name}.bin`, size: bytes.length, availableBytes: 2 * 1024 ** 3 });
    await store.addBlocks(artifact.id, [[0, createHash("sha256").update(bytes).digest("hex")]], bytes.length);
    const aggregate = createHash("sha256").update(bytes).digest("hex");
    await store.publishing(artifact.id, aggregate);
    await store.close();
    const artifacts = path.join(dataDir, "file-transfers", "artifacts");
    await mkdir(artifacts, { recursive: true });
    if (item.partial) await writeFile(path.join(artifacts, `${artifact.id}.partial`), bytes);
    if (item.completed) await writeFile(path.join(artifacts, `${artifact.id}.bin`), item.corrupt ? Buffer.alloc(bytes.length, 0x78) : bytes);
    const recoveredStore = new FileTransferStore({ dataDir, policy, instanceId: `recover-${item.name}` });
    const recovered = new FileTransferService({ dataDir, roots: [workspace], store: recoveredStore, policy,
      keyring: { currentKid: "test-v1", keys: { "test-v1": randomBytes(32) } } });
    await recovered.initialize();
    assert.equal((await recovered.status("device:publish", artifact.id)).state, item.valid ? "ready" : "failed", item.name);
    await recovered.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Range arithmetic remains exact above one GiB", () => {
  const size = 1024 ** 3 + 123;
  assert.deepEqual(transferRange("bytes=1073741824-1073741946", size), {
    start: 1024 ** 3, end: size - 1, partial: true,
  });
  assert.throws(() => transferRange("bytes=0-1,4-5", size), /transfer-invalid-range/u);
  assert.throws(() => transferRange("bytes=1073741947-", size), /transfer-invalid-range/u);
});

test("700 MiB sparse source prepares and streams with bounded process memory", {
  skip: process.env.AGENT_HUB_LARGE_TRANSFER_TEST !== "1",

}, async (t) => {
  const value = await fixture();
  t.after(async () => { await value.service.close(); await rm(value.root, { recursive: true, force: true }); });
  const size = 700 * 1024 ** 2;
  const source = path.join(value.workspace, "large-sparse.bin");
  const handle = await openFile(source, "w");
  await handle.truncate(size);
  await handle.close();
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const artifact = await value.service.prepare({ owner: "device:large", sourcePath: source,
    requestId: "large:prepare" });
  const earlyShare = await value.service.createShare({ owner: "device:large", sourcePath: source,
    artifactId: artifact.id,
    requestId: "large:share", ttlMs: 3_600_000 });
  assert.equal(earlyShare.state, "preparing");
  const earlyUrl = earlyShare.url;
  await value.service.waitForPreparation(artifact.id);
  const share = await value.service.createShare({ owner: "device:large", sourcePath: source,
    artifactId: artifact.id, requestId: "large:share", ttlMs: 3_600_000 });
  assert.equal(share.state, "ready");
  assert.equal(share.url, earlyUrl);
  const [, kid, shareId, secret] = /#v1\.([^.]+)\.([^.]+)\.(.+)$/u.exec(share.url);
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const challenge = await value.service.createClaimChallenge({ kid, shareId, secret,
    claimId: randomBytes(32).toString("base64url"), publicJwk });
  const claimProof = await proof(challenge.payload, privateKey, jkt, "agenthub-transfer-claim+jws");
  const session = await value.service.claim({ kid, shareId, secret, payload: challenge.payload,
    proof: claimProof, publicJwk });
  const plan = await value.service.createPlan({ credential: session.credential,
    requestId: randomBytes(32).toString("base64url"), start: 0, end: size - 1 });
  const signed = await proof(plan.payload, privateKey, jkt, "agenthub-transfer-download+jws");
  const request = await value.service.activatePlan({ credential: session.credential,
    payload: plan.payload, proof: signed, ipHash: "ip:large" });
  let streamed = 0;
  const finish = await value.service.streamPlan(request, {
    write(chunk) {
      streamed += chunk.length;
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      return true;
    },
    waitForDrain: async () => {},
  });
  await finish(true);
  assert.equal(streamed, size);
  assert.ok(rssPeak - rssBefore < 128 * 1024 ** 2,
    `RSS growth must stay below 128 MiB; observed ${rssPeak - rssBefore}`);
});
