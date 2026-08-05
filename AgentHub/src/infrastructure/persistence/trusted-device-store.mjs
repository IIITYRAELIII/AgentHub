import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { readJsonWithBackup, writeTextAtomic } from "./state-store.mjs";

const DEVICE_PAIRING_EXPIRY_MS = 10 * 60 * 1_000;
const DEVICE_CHALLENGE_EXPIRY_MS = 2 * 60 * 1_000;
const DEVICE_SESSION_EXPIRY_MS = 12 * 60 * 60 * 1_000;
const DEVICE_NAME_MAX_CHARS = 80;
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEVICE_CODE_PATTERN = /^[A-Z2-7]{20}$/u;
const DEVICE_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{80,256}$/u;
const DEVICE_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function randomPairingCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return [...randomBytes(20)].map((value) => alphabet[value & 31]).join("");
}

function normalizedDeviceCode(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z2-7]/gu, "");
}

function normalizedDeviceName(value) {
  const name = String(value ?? "").trim().replace(/\s+/gu, " ");
  if (!name || name.length > DEVICE_NAME_MAX_CHARS) throw new Error("invalid device name");
  return name;
}

function deviceSessionMessage({ deviceId, challengeId, challenge }) {
  return ["agent-hub-device-session-v1", deviceId, challengeId, challenge].join("\n");
}

async function importDevicePublicKey(value) {
  if (!DEVICE_PUBLIC_KEY_PATTERN.test(value)) throw new Error("invalid device public key");
  try {
    return await webcrypto.subtle.importKey(
      "spki",
      Buffer.from(value, "base64url"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new Error("invalid device public key");
  }
}

function emptyState() {
  return { version: 1, pairings: {}, devices: {}, challenges: {}, sessions: {} };
}

export class TrustedDeviceStore {
  #filePath;
  #now;
  #state = emptyState();
  #loaded = false;
  #writeQueue = Promise.resolve();

  constructor({ filePath, now = () => Date.now() } = {}) {
    if (!filePath) throw new Error("TrustedDeviceStore filePath is required");
    this.#filePath = path.resolve(filePath);
    this.#now = now;
  }

  async load() {
    if (this.#loaded) return;
    const loaded = await readJsonWithBackup(this.#filePath);
    if (loaded.value && typeof loaded.value === "object" && !Array.isArray(loaded.value)) {
      this.#state = {
        ...emptyState(),
        ...loaded.value,
        pairings: loaded.value.pairings ?? {},
        devices: loaded.value.devices ?? {},
        challenges: loaded.value.challenges ?? {},
        sessions: loaded.value.sessions ?? {},
      };
    }
    this.#loaded = true;
    await this.#mutate(() => this.#cleanup(this.#now()), { persistWhenUnchanged: false });
  }

  #publicDevice(record) {
    return {
      id: record.id,
      name: record.name,
      platform: record.platform,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt ?? null,
      revokedAt: record.revokedAt ?? null,
    };
  }

  #cleanup(now) {
    let changed = false;
    for (const field of ["pairings", "challenges", "sessions"]) {
      for (const [key, value] of Object.entries(this.#state[field])) {
        if (Number(value?.expiresAt ?? 0) > now) continue;
        delete this.#state[field][key];
        changed = true;
      }
    }
    return changed;
  }

  async #persist() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const previous = await readJsonWithBackup(this.#filePath).catch(() => ({ value: null }));
    if (previous.value) {
      await writeTextAtomic(`${this.#filePath}.bak`, `${JSON.stringify(previous.value, null, 2)}\n`);
    }
    await writeTextAtomic(this.#filePath, `${JSON.stringify(this.#state, null, 2)}\n`);
  }

  #mutate(callback, { persistWhenUnchanged = true } = {}) {
    const operation = this.#writeQueue.then(async () => {
      if (!this.#loaded) throw new Error("TrustedDeviceStore is not loaded");
      const result = await callback();
      if (persistWhenUnchanged || result === true || result?.changed === true) await this.#persist();
      return result?.value ?? result;
    });
    this.#writeQueue = operation.catch(() => {});
    return operation;
  }

  async createPairing(userId) {
    const normalizedUserId = String(userId ?? "").trim();
    if (!normalizedUserId) throw new Error("invalid device user");
    return this.#mutate(() => {
      const now = this.#now();
      this.#cleanup(now);
      const code = randomPairingCode();
      const expiresAt = now + DEVICE_PAIRING_EXPIRY_MS;
      this.#state.pairings[sha256(code)] = { userId: normalizedUserId, createdAt: now, expiresAt };
      return { value: { code: code.match(/.{1,5}/gu).join("-"), expiresAt }, changed: true };
    });
  }

  async pair(payload) {
    const code = normalizedDeviceCode(payload?.code);
    if (!DEVICE_CODE_PATTERN.test(code)) throw new Error("invalid pairing code");
    const name = normalizedDeviceName(payload?.name);
    const platform = String(payload?.platform ?? "Android").trim().slice(0, 40) || "Android";
    const publicKey = String(payload?.publicKey ?? "").trim();
    await importDevicePublicKey(publicKey);
    return this.#mutate(() => {
      const now = this.#now();
      this.#cleanup(now);
      const pairingKey = sha256(code);
      const pairing = this.#state.pairings[pairingKey];
      if (!pairing) throw new Error("pairing code is invalid or expired");
      const id = randomUUID().toLowerCase();
      const record = {
        id,
        userId: String(pairing.userId),
        name,
        platform,
        publicKey,
        createdAt: now,
        lastSeenAt: null,
        revokedAt: null,
      };
      this.#state.devices[id] = record;
      delete this.#state.pairings[pairingKey];
      return { value: { device: this.#publicDevice(record) }, changed: true };
    });
  }

  async createChallenge(payload) {
    const deviceId = String(payload?.deviceId ?? "").trim().toLowerCase();
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("invalid device id");
    return this.#mutate(() => {
      const record = this.#state.devices[deviceId];
      if (!record || record.revokedAt) throw new Error("device is not trusted");
      const now = this.#now();
      this.#cleanup(now);
      const challengeId = randomUUID().toLowerCase();
      const challenge = base64Url(randomBytes(32));
      const expiresAt = now + DEVICE_CHALLENGE_EXPIRY_MS;
      this.#state.challenges[challengeId] = { deviceId, challenge, expiresAt };
      return { value: { challengeId, challenge, expiresAt }, changed: true };
    });
  }

  async createSession(payload) {
    const deviceId = String(payload?.deviceId ?? "").trim().toLowerCase();
    const challengeId = String(payload?.challengeId ?? "").trim().toLowerCase();
    const signature = String(payload?.signature ?? "").trim();
    if (!DEVICE_ID_PATTERN.test(deviceId) || !DEVICE_ID_PATTERN.test(challengeId)) {
      throw new Error("invalid device challenge");
    }
    if (!DEVICE_SIGNATURE_PATTERN.test(signature)) throw new Error("invalid device signature");
    const snapshot = await this.#writeQueue.then(() => ({
      record: this.#state.devices[deviceId],
      challenge: this.#state.challenges[challengeId],
    }));
    if (!snapshot.record || snapshot.record.revokedAt) throw new Error("device is not trusted");
    if (!snapshot.challenge || snapshot.challenge.deviceId !== deviceId
      || Number(snapshot.challenge.expiresAt ?? 0) <= this.#now()) {
      throw new Error("device challenge is invalid or expired");
    }
    const key = await importDevicePublicKey(snapshot.record.publicKey);
    const valid = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signature, "base64url"),
      Buffer.from(deviceSessionMessage({ deviceId, challengeId, challenge: snapshot.challenge.challenge })),
    );
    if (!valid) throw new Error("invalid device signature");
    return this.#mutate(() => {
      const challenge = this.#state.challenges[challengeId];
      const record = this.#state.devices[deviceId];
      if (!record || record.revokedAt) throw new Error("device is not trusted");
      if (!challenge || challenge.deviceId !== deviceId || Number(challenge.expiresAt ?? 0) <= this.#now()) {
        throw new Error("device challenge is invalid or expired");
      }
      delete this.#state.challenges[challengeId];
      const now = this.#now();
      const token = base64Url(randomBytes(32));
      const expiresAt = now + DEVICE_SESSION_EXPIRY_MS;
      record.lastSeenAt = now;
      this.#state.sessions[sha256(token)] = {
        deviceId,
        userId: String(record.userId),
        createdAt: now,
        expiresAt,
      };
      return { value: { token, expiresAt, device: this.#publicDevice(record) }, changed: true };
    });
  }

  async resolveSession(token) {
    const normalizedToken = String(token ?? "").trim();
    if (!SESSION_TOKEN_PATTERN.test(normalizedToken)) throw new Error("invalid device session");
    return this.#mutate(() => {
      const now = this.#now();
      const tokenHash = sha256(normalizedToken);
      const session = this.#state.sessions[tokenHash];
      if (!session || Number(session.expiresAt ?? 0) <= now) {
        if (session) delete this.#state.sessions[tokenHash];
        throw new Error("device session is invalid or expired");
      }
      const record = this.#state.devices[session.deviceId];
      if (!record || record.revokedAt) {
        delete this.#state.sessions[tokenHash];
        throw new Error("device is not trusted");
      }
      const changed = !record.lastSeenAt || now - record.lastSeenAt >= 5 * 60 * 1_000;
      if (changed) record.lastSeenAt = now;
      return {
        value: { id: String(session.userId), deviceId: record.id, deviceName: record.name },
        changed,
      };
    }, { persistWhenUnchanged: false });
  }

  async list(userId) {
    const normalizedUserId = String(userId ?? "").trim();
    if (!normalizedUserId) throw new Error("invalid device user");
    await this.#writeQueue;
    return {
      devices: Object.values(this.#state.devices)
        .filter((record) => String(record.userId) === normalizedUserId)
        .sort((left, right) => Number(right.lastSeenAt ?? right.createdAt ?? 0)
          - Number(left.lastSeenAt ?? left.createdAt ?? 0))
        .map((record) => this.#publicDevice(record)),
    };
  }

  async revoke(userId, deviceId) {
    const normalizedUserId = String(userId ?? "").trim();
    const normalizedDeviceId = String(deviceId ?? "").trim().toLowerCase();
    if (!normalizedUserId || !DEVICE_ID_PATTERN.test(normalizedDeviceId)) {
      throw new Error("invalid device revoke request");
    }
    return this.#mutate(() => {
      const record = this.#state.devices[normalizedDeviceId];
      if (!record || String(record.userId) !== normalizedUserId) throw new Error("device not found");
      record.revokedAt = this.#now();
      for (const [tokenHash, session] of Object.entries(this.#state.sessions)) {
        if (session.deviceId === normalizedDeviceId) delete this.#state.sessions[tokenHash];
      }
      return { value: { device: this.#publicDevice(record) }, changed: true };
    });
  }
}
