import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { calculateJwkThumbprint, compactVerify, importJWK } from "jose";

import { pathInsideOrSame } from "./config.mjs";
import {
  equalTransferDigest,
  transferError,
  transferClaimPayload,
  transferFilename,
  transferHash,
  transferMac,
  transferSessionSelector,
  TRANSFER_BLOCK_BYTES,
  TRANSFER_ID,
} from "../../domain/file-transfer.mjs";

const PREPARE_BATCH_BLOCKS = 128;
const DRAIN_TIMEOUT_MS = 30_000;
const CLAIM_PROOF_TYPE = "agenthub-transfer-claim+jws";
const DOWNLOAD_PROOF_TYPE = "agenthub-transfer-download+jws";

function derivedSecret(key, domain, ...values) {
  return createHmac("sha256", key)
    .update(JSON.stringify(["agenthub-transfer-derived-v1", domain, ...values]))
    .digest("base64url");
}

function derivedUuid(key, domain, ...values) {
  const hex = createHmac("sha256", key)
    .update(JSON.stringify(["agenthub-transfer-derived-uuid-v1", domain, ...values])).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function canonicalPublicJwk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || "d" in value
    || value.kty !== "EC" || value.crv !== "P-256"
    || !/^[A-Za-z0-9_-]{43}$/u.test(String(value.x ?? ""))
    || !/^[A-Za-z0-9_-]{43}$/u.test(String(value.y ?? ""))) {
    throw transferError("transfer-invalid-proof-key", 400);
  }
  return Object.freeze({ kty: "EC", crv: "P-256", x: String(value.x), y: String(value.y) });
}

function exactBytes(left, right) {
  const a = typeof left === "string" ? Buffer.from(left) : Buffer.from(left);
  const b = typeof right === "string" ? Buffer.from(right) : Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function verifyProof({ proof, publicJwk, jkt, payload, type }) {
  let verified;
  try {
    verified = await compactVerify(String(proof), await importJWK(publicJwk, "ES256"), { algorithms: ["ES256"] });
  } catch {
    throw transferError("transfer-unavailable", 410);
  }
  const header = verified.protectedHeader;
  if (header.alg !== "ES256" || header.typ !== type || header.kid !== jkt
    || Object.keys(header).sort().join(",") !== "alg,kid,typ"
    || !exactBytes(verified.payload, payload)) {
    throw transferError("transfer-unavailable", 410);
  }
}

function identity(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mtimeNs: String(info.mtimeNs),
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function boundedDrain(waitForDrain, requestId) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => waitForDrain({ requestId, timeoutMs: DRAIN_TIMEOUT_MS })),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(transferError("transfer-output-drain-timeout", 503)), DRAIN_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertNoReparse(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw transferError("transfer-source-outside-workspace", 403);
  }
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor, { bigint: true });
    if (info.isSymbolicLink()) throw transferError("transfer-source-reparse-point", 403);
  }
}

export class FileTransferService {
  #artifactsDirectory;
  #keyring;
  #policy;
  #roots;
  #store;
  #preparations = new Map();
  #initializing;
  #gcTimer = null;

  constructor({ dataDir, roots, store, policy, keyring }) {
    this.#artifactsDirectory = path.join(path.resolve(dataDir), "file-transfers", "artifacts");
    this.#roots = (roots ?? []).map((root) => path.resolve(root));
    this.#store = store;
    this.#policy = policy;
    const entries = Object.entries(keyring?.keys ?? {}).map(([kid, value]) => {
      const structured = value && typeof value === "object" && !Buffer.isBuffer(value) && "secret" in value;
      const secret = Buffer.from(structured ? value.secret : value);
      const status = structured ? String(value.status ?? "verify_only") : (kid === keyring?.currentKid ? "active" : "verify_only");
      return [kid, { secret, status }];
    });
    const currentKid = String(keyring?.currentKid ?? "");
    if (!currentKid || !/^[A-Za-z0-9_-]{1,32}$/u.test(currentKid)
      || !entries.some(([kid, value]) => kid === currentKid && value.status === "active")
      || entries.some(([kid, value]) => !/^[A-Za-z0-9_-]{1,32}$/u.test(kid)
        || value.secret.length < 32 || !["active", "verify_only"].includes(value.status))) {
      throw new Error("File transfer keyring requires a current 256-bit key");
    }
    this.#keyring = Object.freeze({ currentKid,
      keys: new Map(entries.map(([kid, value]) => [kid, value.secret])),
      statuses: new Map(entries.map(([kid, value]) => [kid, value.status])) });
  }

  async initialize() {
    this.#initializing ??= (async () => {
      await mkdir(this.#artifactsDirectory, { recursive: true, mode: 0o700 });
      await this.#store.initialize();
      for (const artifact of await this.#store.publishingArtifacts()) {
        await this.#recoverPublishing(artifact);
      }
    })();
    await this.#initializing;
  }

  async #resolveSourcePath(sourcePath) {
    const candidate = path.resolve(String(sourcePath ?? ""));
    const configuredRoot = this.#roots.find((root) => pathInsideOrSame(candidate, root));
    if (!configuredRoot) throw transferError("transfer-source-outside-workspace", 403);
    await assertNoReparse(configuredRoot, candidate);
    const target = await realpath(candidate);
    const containingRoot = await realpath(configuredRoot);
    if (!pathInsideOrSame(target, containingRoot)) throw transferError("transfer-source-outside-workspace", 403);
    return { candidate, configuredRoot, target };
  }

  #sourceAliases(target) {
    return [...this.#keyring.keys].map(([kid, key]) => `${kid}.${transferMac(key, "source", target)}`);
  }

  async #recoverPublishing(artifact) {
    const partial = path.join(this.#artifactsDirectory, `${artifact.id}.partial`);
    const completed = this.artifactPath(artifact.id);
    try {
      let partialExists = true;
      let completedExists = true;
      try { await stat(partial); } catch (error) { if (error?.code === "ENOENT") partialExists = false; else throw error; }
      try { await stat(completed); } catch (error) { if (error?.code === "ENOENT") completedExists = false; else throw error; }
      if (partialExists === completedExists) throw transferError("transfer-publish-recovery-failed", 500);
      if (partialExists) await rename(partial, completed);
      const snapshot = await this.#verifyPublishedArtifact(artifact);
      await this.#store.ready(artifact.id, artifact.sha256, snapshot);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      await rm(completed, { force: true }).catch(() => {});
      await this.#store.failPreparation(artifact.owner, artifact.id).catch(() => {});
    }
  }

  async #verifyPublishedArtifact(artifact) {
    const completed = this.artifactPath(artifact.id);
    const handle = await open(completed, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const snapshot = identity(await handle.stat({ bigint: true }));
      if (snapshot.size !== artifact.size) throw transferError("transfer-snapshot-mismatch", 500);
      const lastBlock = Math.floor((artifact.size - 1) / TRANSFER_BLOCK_BYTES);
      const hashes = await this.#store.blockHashes(artifact.id, 0, lastBlock);
      const aggregate = createHash("sha256");
      const buffer = Buffer.allocUnsafe(TRANSFER_BLOCK_BYTES);
      for (let block = 0; block <= lastBlock; block += 1) {
        const offset = block * TRANSFER_BLOCK_BYTES;
        const expectedBytes = Math.min(TRANSFER_BLOCK_BYTES, artifact.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, expectedBytes, offset);
        if (bytesRead !== expectedBytes) throw transferError("transfer-snapshot-mismatch", 500);
        const chunk = buffer.subarray(0, bytesRead);
        aggregate.update(chunk);
        if (createHash("sha256").update(chunk).digest("hex") !== hashes.get(block)) {
          throw transferError("transfer-snapshot-mismatch", 500);
        }
      }
      if (aggregate.digest("hex") !== artifact.sha256) throw transferError("transfer-snapshot-mismatch", 500);
      return snapshot;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async prepare({ owner, sourcePath, requestId }) {
    await this.initialize();
    const { candidate, configuredRoot, target } = await this.#resolveSourcePath(sourcePath);
    const source = await open(target, constants.O_RDONLY);
    let sourceInfo;
    let availableBytes;
    try {
      sourceInfo = await source.stat({ bigint: true });
      if (!sourceInfo.isFile() || sourceInfo.size < 1n || sourceInfo.size > BigInt(this.#policy.maxBytes)) {
        throw transferError("transfer-invalid-source", 400);
      }
      await assertNoReparse(configuredRoot, candidate);
      if (await realpath(candidate) !== target || !sameIdentity(identity(sourceInfo), identity(await stat(candidate, { bigint: true })))) {
        throw transferError("transfer-source-changed", 409);
      }
      const capacity = await statfs(this.#artifactsDirectory, { bigint: true });
      const free = capacity.bavail * capacity.bsize;
      if (free < sourceInfo.size + BigInt(this.#policy.freeBytes)) throw transferError("transfer-storage-quota", 429);
      availableBytes = Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free);
    } catch (error) {
      await source.close();
      throw error;
    }
    const sourceAliases = this.#sourceAliases(target);
    const sourceKey = sourceAliases.find((alias) => alias.startsWith(`${this.#keyring.currentKid}.`));
    const reservation = {
      owner: String(owner), sourceKey, sourceAliases, sourceKids: [...this.#keyring.keys.keys()],
      requestId: String(requestId), name: transferFilename(path.basename(target)),
      size: Number(sourceInfo.size), availableBytes,
    };
    let artifact;
    try {
      artifact = await this.#store.reserve(reservation);
    } catch (error) {
      if (error?.code !== "transfer-storage-quota") {
        await source.close();
        throw error;
      }
      try {
        // FAILED/DELETING artifacts remain charged until both managed paths are gone and gcDeleted commits.
        await this.gc();
        artifact = await this.#store.reserve(reservation);
      } catch (retryError) {
        await source.close();
        throw retryError;
      }
    }
    if (!artifact.reserved) {
      await source.close();
      return artifact;
    }
    const preparation = this.#copy({ artifact, owner: String(owner), source, sourceIdentity: identity(sourceInfo) })
      .finally(() => this.#preparations.delete(artifact.id));
    this.#preparations.set(artifact.id, preparation);
    return artifact;
  }

  async waitForPreparation(artifactId) {
    await this.#preparations.get(String(artifactId));
  }

  async #copy({ artifact, owner, source, sourceIdentity }) {
    const partial = path.join(this.#artifactsDirectory, `${artifact.id}.partial`);
    const completed = path.join(this.#artifactsDirectory, `${artifact.id}.bin`);
    let output;
    try {
      output = await open(partial, "wx", 0o600);
      // Convert the optimistic statfs observation into an allocated managed
      // file before reading the source. Later copy writes replace these exact
      // extents, so an unrelated filesystem consumer cannot turn a fully read
      // source into an unaccounted partial snapshot merely by winning the
      // statfs-to-first-write window.
      const allocation = Buffer.alloc(TRANSFER_BLOCK_BYTES);
      for (let offset = 0; offset < artifact.size; offset += allocation.length) {
        if (offset % (PREPARE_BATCH_BLOCKS * TRANSFER_BLOCK_BYTES) === 0) {
          await this.#store.heartbeatPreparation(artifact.id);
          const capacity = await statfs(this.#artifactsDirectory, { bigint: true });
          const free = capacity.bavail * capacity.bsize;
          const batchBytes = BigInt(Math.min(artifact.size - offset,
            PREPARE_BATCH_BLOCKS * TRANSFER_BLOCK_BYTES));
          if (free < BigInt(this.#policy.freeBytes) + batchBytes) {
            throw transferError("transfer-storage-quota", 429);
          }
        }
        const length = Math.min(allocation.length, artifact.size - offset);
        let allocated = 0;
        while (allocated < length) {
          const result = await output.write(allocation, allocated, length - allocated, offset + allocated);
          if (!result.bytesWritten) throw transferError("transfer-storage-write-failed", 500);
          allocated += result.bytesWritten;
        }
      }
      await output.sync();
      const allocatedCapacity = await statfs(this.#artifactsDirectory, { bigint: true });
      if (allocatedCapacity.bavail * allocatedCapacity.bsize < BigInt(this.#policy.freeBytes)) {
        throw transferError("transfer-storage-quota", 429);
      }
      const aggregate = createHash("sha256");
      const buffer = Buffer.allocUnsafe(TRANSFER_BLOCK_BYTES);
      let offset = 0;
      let block = 0;
      let pending = [];
      while (offset < artifact.size) {
        const expected = Math.min(buffer.length, artifact.size - offset);
        if (block % PREPARE_BATCH_BLOCKS === 0) {
          const capacity = await statfs(this.#artifactsDirectory, { bigint: true });
          const free = capacity.bavail * capacity.bsize;
          const batchBytes = BigInt(Math.min(artifact.size - offset, PREPARE_BATCH_BLOCKS * TRANSFER_BLOCK_BYTES));
          if (free < BigInt(this.#policy.freeBytes) + batchBytes) throw transferError("transfer-storage-quota", 429);
        }
        const { bytesRead } = await source.read(buffer, 0, expected, offset);
        if (bytesRead !== expected) throw transferError("transfer-source-changed", 409);
        const chunk = buffer.subarray(0, bytesRead);
        aggregate.update(chunk);
        pending.push([block, createHash("sha256").update(chunk).digest("hex")]);
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(chunk, written, bytesRead - written, offset + written);
          if (!result.bytesWritten) throw transferError("transfer-storage-write-failed", 500);
          written += result.bytesWritten;
        }
        offset += bytesRead;
        block += 1;
        if (pending.length >= PREPARE_BATCH_BLOCKS || offset === artifact.size) {
          await this.#store.addBlocks(artifact.id, pending, offset);
          pending = [];
        }
      }
      await output.sync();
      const finalSource = identity(await source.stat({ bigint: true }));
      if (!sameIdentity(sourceIdentity, finalSource)) throw transferError("transfer-source-changed", 409);
      const sha256 = aggregate.digest("hex");
      await output.close();
      output = null;
      await this.#store.publishing(artifact.id, sha256);
      await rename(partial, completed);
      const snapshot = await this.#verifyPublishedArtifact({ ...artifact, sha256 });
      await this.#store.ready(artifact.id, sha256, snapshot);
    } catch (error) {
      await output?.close().catch(() => {});
      await rm(partial, { force: true }).catch(() => {});
      await rm(completed, { force: true }).catch(() => {});
      await this.#store.failPreparation(owner, artifact.id).catch(() => {});
      throw error;
    } finally {
      await source.close().catch(() => {});
    }
  }

  artifactPath(artifactId) {
    const id = String(artifactId);
    if (!TRANSFER_ID.test(id)) throw transferError("transfer-artifact-not-found", 404);
    return path.join(this.#artifactsDirectory, `${id}.bin`);
  }

  status(owner, artifactId) {
    return this.#store.artifact(String(owner), String(artifactId));
  }

  async createShare({ owner, artifactId, requestId, ttlMs }) {
    const ownerId = String(owner), artifactKey = String(artifactId), requestKey = String(requestId);
    const issuanceKid = this.#keyring.currentKid;
    const issuanceKey = this.#keyring.keys.get(issuanceKid);
    const issuanceSecret = derivedSecret(issuanceKey, "share", ownerId, artifactKey, requestKey, ttlMs);
    const secretHash = transferMac(issuanceKey, "share", issuanceSecret);
    const share = await this.#store.create({ owner: ownerId, artifactId: artifactKey,
      requestId: requestKey, kid: issuanceKid, secretHash, ttlMs });
    const persistedKey = this.#keyring.keys.get(share.kid);
    if (!persistedKey) throw transferError("transfer-unavailable", 410);
    const secret = derivedSecret(persistedKey, "share", ownerId, artifactKey, requestKey, ttlMs);
    const expected = transferMac(persistedKey, "share", secret);
    if (!equalTransferDigest(expected, share.secretHash)) throw transferError("transfer-unavailable", 410);
    const result = { ...share };
    delete result.kid;
    delete result.requestId;
    delete result.secretHash;
    if (result.state === "ready") {
      result.url = `${this.#policy.publicBaseUrl}/transfer/#v1.${share.kid}.${share.id}.${secret}`;
    }
    return result;
  }

  inspect({ kid, shareId, secret }) {
    const key = this.#keyring.keys.get(String(kid));
    if (!key) throw transferError("transfer-unavailable", 410);
    return this.#store.inspect(transferMac(key, "share", String(secret)), String(kid), String(shareId));
  }

  async createClaimChallenge({ kid, shareId, secret, claimId, publicJwk }) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(String(claimId))) throw transferError("transfer-unavailable", 410);
    const key = this.#keyring.keys.get(String(kid));
    if (!key) throw transferError("transfer-unavailable", 410);
    const jwk = canonicalPublicJwk(publicJwk);
    const jkt = await calculateJwkThumbprint(jwk, "sha256");
    const nonce = derivedSecret(key, "claim-nonce", shareId, claimId, jkt);
    const challenge = await this.#store.issueClaimChallenge({
      secretHash: transferMac(key, "share", String(secret)), kid: String(kid), shareId: String(shareId),
      claimId: String(claimId), jkt, publicJwk: JSON.stringify(jwk), nonce,
    });
    return { payload: transferClaimPayload(challenge), expiresAt: challenge.expiresAt };
  }

  async claim({ kid, shareId, secret, payload, proof, publicJwk }) {
    const key = this.#keyring.keys.get(String(kid));
    if (!key) throw transferError("transfer-unavailable", 410);
    let challenge;
    try { challenge = JSON.parse(String(payload)); } catch { throw transferError("transfer-unavailable", 410); }
    if (transferClaimPayload(challenge) !== payload || challenge.shareId !== String(shareId)) {
      throw transferError("transfer-unavailable", 410);
    }
    const jwk = canonicalPublicJwk(publicJwk);
    const jkt = await calculateJwkThumbprint(jwk, "sha256");
    if (challenge.jkt !== jkt) throw transferError("transfer-unavailable", 410);
    await verifyProof({ proof, publicJwk: jwk, jkt, payload, type: CLAIM_PROOF_TYPE });
    const claimHash = transferHash(payload);
    const requestedSessionId = randomUUID();
    const sessionKid = this.#keyring.currentKid;
    const sessionKey = this.#keyring.keys.get(sessionKid);
    const requestedSecret = derivedSecret(sessionKey, "session", requestedSessionId, claimHash);
    const session = await this.#store.claim({
      secretHash: transferMac(key, "share", String(secret)), kid: String(kid), challenge, claimHash,
      sessionId: requestedSessionId, sessionKid,
      sessionHash: transferMac(sessionKey, "session", requestedSecret),
    });
    const persistedSessionKey = this.#keyring.keys.get(session.kid);
    if (!persistedSessionKey) throw transferError("transfer-unavailable", 410);
    const sessionSecret = derivedSecret(persistedSessionKey, "session", session.id, claimHash);
    const credential = `v1.${session.kid}.${session.id}.${sessionSecret}`;
    return { id: session.id, expiresAt: session.expiresAt, credential,
      selector: transferSessionSelector(credential), replay: session.replay === true };
  }

  #sessionParts(credential) {
    const match = /^v1\.([A-Za-z0-9_-]{1,32})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(String(credential));
    if (!match) throw transferError("transfer-unavailable", 410);
    const [, kid, sessionId, secret] = match;
    const key = this.#keyring.keys.get(kid);
    if (!key) throw transferError("transfer-unavailable", 410);
    return { kid, sessionId, secretHash: transferMac(key, "session", secret),
      sessionSelector: transferSessionSelector(credential) };
  }

  createPlan({ credential, requestId, start, end }) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(String(requestId))) throw transferError("transfer-invalid-request", 400);
    const session = this.#sessionParts(credential);
    const key = this.#keyring.keys.get(session.kid);
    const planId = derivedUuid(key, "plan", session.sessionId, requestId);
    const nonce = derivedSecret(key, "plan-nonce", session.sessionId, requestId);
    return this.#store.issuePlan({ ...session, clientRequestId: String(requestId), planId, nonce, start, end });
  }

  async activatePlan({ credential, payload, proof, ipHash }) {
    let plan;
    try { plan = JSON.parse(String(payload)); } catch { throw transferError("transfer-unavailable", 410); }
    const session = this.#sessionParts(credential);
    if (plan.sessionId !== session.sessionId
      || plan.path !== `/transfer/api/session/${session.sessionSelector}/download`) {
      throw transferError("transfer-unavailable", 410);
    }
    const material = await this.#store.planForVerification({ ...session, planId: String(plan.planId) });
    if (material.payloadHash !== transferHash(payload)) throw transferError("transfer-unavailable", 410);
    const publicJwk = JSON.parse(material.publicJwk);
    await verifyProof({ proof, publicJwk, jkt: material.jkt, payload, type: DOWNLOAD_PROOF_TYPE });
    return this.#store.activatePlan({ ...session, planId: String(plan.planId), payload,
      proofHash: transferHash(String(proof)), ipHash: String(ipHash) });
  }

  async streamPlan(request, { write, waitForDrain, signal } = {}) {
    if (!request || !TRANSFER_ID.test(String(request.artifactId)) || typeof write !== "function"
      || typeof waitForDrain !== "function" || (signal !== undefined && typeof signal?.aborted !== "boolean")) {
      throw transferError("transfer-unavailable", 410);
    }
    let handle = null;
    let settled = false;
    const throwIfAborted = () => {
      if (signal?.aborted) throw transferError("transfer-output-aborted", 410);
    };
    try {
      throwIfAborted();
      handle = await open(this.artifactPath(request.artifactId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      throwIfAborted();
      const observed = identity(await handle.stat({ bigint: true }));
      if (!sameIdentity(observed, request.identity) || observed.size !== request.size) {
        await this.#store.failArtifact(request.artifactId);
        throw transferError("transfer-artifact-mismatch", 410);
      }
      const firstBlock = Math.floor(request.start / TRANSFER_BLOCK_BYTES);
      const lastBlock = Math.floor(request.end / TRANSFER_BLOCK_BYTES);
      const hashes = await this.#store.blockHashes(request.artifactId, firstBlock, lastBlock);
      throwIfAborted();
      const buffer = Buffer.allocUnsafe(TRANSFER_BLOCK_BYTES);
      for (let block = firstBlock; block <= lastBlock; block += 1) {
        const blockStart = block * TRANSFER_BLOCK_BYTES;
        const blockBytes = Math.min(TRANSFER_BLOCK_BYTES, request.size - blockStart);
        const { bytesRead } = await handle.read(buffer, 0, blockBytes, blockStart);
        const expected = hashes.get(block);
        const observedHash = bytesRead === blockBytes
          ? createHash("sha256").update(buffer.subarray(0, blockBytes)).digest("hex")
          : "";
        if (!expected || observedHash !== expected) {
          await this.#store.failArtifact(request.artifactId);
          throw transferError("transfer-artifact-mismatch", 410);
        }
        const blockBuffer = Buffer.from(buffer.subarray(0, blockBytes));
        throwIfAborted();
        let needsDrain = false;
        await this.#store.authorizeBlockOutput(request.id, blockStart, blockBuffer, (authorized) => {
          needsDrain = write(authorized) === false;
        }, { signal });
        if (needsDrain) await boundedDrain(waitForDrain, request.id);
      }
      return async (delivered) => {
        if (settled) return;
        settled = true;
        await this.#store.finishRequest(request.id, request.instanceId, delivered === true);
      };
    } catch (error) {
      if (!settled) {
        settled = true;
        await this.#store.finishRequest(request.id, request.instanceId, false).catch(() => {});
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async abortPlan(request) {
    if (!request || !TRANSFER_ID.test(String(request.artifactId)) || !TRANSFER_ID.test(String(request.id))) {
      throw transferError("transfer-unavailable", 410);
    }
    await this.#store.finishRequest(request.id, request.instanceId, false);
  }

  async list(owner, sourcePath) {
    const { target } = await this.#resolveSourcePath(sourcePath);
    return this.#store.list(String(owner), this.#sourceAliases(target));
  }

  async ownerStatus(owner, sourcePath) {
    await this.initialize();
    const { target } = await this.#resolveSourcePath(sourcePath);
    const info = await stat(target, { bigint: true });
    if (!info.isFile() || info.size < 1n || info.size > BigInt(this.#policy.maxBytes)) {
      throw transferError("transfer-invalid-source", 400);
    }
    const result = await this.#store.ownerFile(String(owner), this.#sourceAliases(target));
    let share = result?.share ?? null;
    if (share?.state === "ready") {
      const key = this.#keyring.keys.get(share.kid);
      if (key) {
        const ttlMs = share.expiresAt - share.createdAt;
        const secret = derivedSecret(key, "share", String(owner), share.artifactId, share.requestId, ttlMs);
        const expected = transferMac(key, "share", secret);
        if (equalTransferDigest(expected, share.secretHash)) {
          share = { ...share, url: `${this.#policy.publicBaseUrl}/transfer/#v1.${share.kid}.${share.id}.${secret}` };
        }
      }
    }
    if (share) {
      delete share.kid;
      delete share.requestId;
      delete share.secretHash;
    }
    return {
      file: { name: transferFilename(path.basename(target)), size: Number(info.size) },
      artifact: result?.artifact ?? null,
      share,
    };
  }

  async publicGate(clientAddress, action) {
    const key = this.#keyring.keys.get(this.#keyring.currentKid);
    const ipHash = transferMac(key, "client-ip", String(clientAddress));
    await this.#store.rate(ipHash, String(action));
    return ipHash;
  }

  revoke(owner, shareId) { return this.#store.revoke(String(owner), String(shareId)); }
  audit(owner, shareId) { return this.#store.audit(String(owner), String(shareId)); }

  async gc() {
    await this.initialize();
    const removed = [];
    for (const artifactId of await this.#store.gcCandidates()) {
      await rm(path.join(this.#artifactsDirectory, `${artifactId}.partial`), { force: true });
      await rm(this.artifactPath(artifactId), { force: true });
      await this.#store.gcDeleted(artifactId);
      removed.push(artifactId);
    }
    return removed;
  }

  startOperationalGc(intervalMs = 15 * 60_000) {
    if (this.#gcTimer) return;
    const collect = () => { void this.gc().catch(() => {}); };
    collect();
    this.#gcTimer = setInterval(collect, Math.max(60_000, Number(intervalMs) || 0));
    this.#gcTimer.unref?.();
  }

  async close() {
    if (this.#gcTimer) clearInterval(this.#gcTimer);
    this.#gcTimer = null;
    await Promise.allSettled(this.#preparations.values());
    await this.#store.close();
  }
}
