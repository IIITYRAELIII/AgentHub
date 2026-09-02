import {
  generateKeyPairSync,
  randomUUID,
  randomBytes,
  sign as signWithKey,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  legacyUsageSyncDeviceId,
  normalizeDeviceLabel,
  normalizeUsageSyncIdentity,
  publicUsageSyncIdentity,
  USAGE_SYNC_IDENTITY_VERSION,
} from "../../domain/usage-sync-identity.mjs";
import {
  usageAuthFingerprint,
  usageRuntimeHomeId,
} from "../../domain/usage-account-identity.mjs";
import { writeTextAtomic } from "./state-store.mjs";

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function defaultKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: base64Url(publicKey.export({ type: "spki", format: "der" })),
    privateKey: base64Url(privateKey.export({ type: "pkcs8", format: "der" })),
  };
}

function defaultHomeSalt() {
  return randomBytes(32).toString("base64url");
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

/**
 * Owns the durable identity of this Agent Hub installation for usage sync:
 * an immutable device id, an editable signature label and an Ed25519 key pair.
 * The private key never leaves this file.
 */
export class UsageSyncIdentityStore {
  #file;
  #legacySource;
  #now;
  #createKeyPair;
  #createDeviceId;
  #createHomeSalt;
  #createInstallationInstanceId;
  #identity = null;
  #tail = Promise.resolve();

  constructor({
    file,
    dataDir = "",
    hostname = os.hostname(),
    platform = process.platform,
    now = () => new Date(),
    createKeyPair = defaultKeyPair,
    createDeviceId = randomUUID,
    createHomeSalt = defaultHomeSalt,
    createInstallationInstanceId = randomUUID,
  } = {}) {
    if (!file) throw new TypeError("UsageSyncIdentityStore requires a file");
    this.#file = path.resolve(file);
    this.#legacySource = {
      hostname: String(hostname ?? ""),
      dataDir: String(dataDir || path.dirname(this.#file)),
      platform: String(platform ?? ""),
    };
    this.#now = now;
    this.#createKeyPair = createKeyPair;
    this.#createDeviceId = createDeviceId;
    this.#createHomeSalt = createHomeSalt;
    this.#createInstallationInstanceId = createInstallationInstanceId;
  }

  get file() {
    return this.#file;
  }

  get identity() {
    if (!this.#identity) throw new Error("Usage sync identity is not loaded");
    return this.#identity;
  }

  get deviceId() {
    return this.identity.deviceId;
  }

  get label() {
    return this.identity.label;
  }

  get publicKey() {
    return this.identity.publicKey;
  }

  get legacyDeviceIds() {
    return [...this.identity.legacyDeviceIds];
  }

  get labelConfirmedAt() {
    return this.identity.labelConfirmedAt;
  }

  get installationInstanceId() {
    return this.identity.installationInstanceId;
  }

  runtimeHomeId(absolutePath) {
    return usageRuntimeHomeId(this.identity.homeSalt, absolutePath);
  }

  authFingerprint(fields) {
    return usageAuthFingerprint(this.identity.homeSalt, fields);
  }

  #enqueue(operation) {
    const next = this.#tail.catch(() => {}).then(operation);
    this.#tail = next;
    return next;
  }

  async #write(identity) {
    await mkdir(path.dirname(this.#file), { recursive: true });
    await writeTextAtomic(this.#file, `${JSON.stringify(identity, null, 2)}\n`);
    try {
      await chmod(this.#file, 0o600);
    } catch {
      // Windows and some network filesystems do not support POSIX modes; the
      // file still inherits the protected data directory permissions.
    }
  }

  #issue() {
    const timestamp = this.#now().toISOString();
    const { publicKey, privateKey } = this.#createKeyPair();
    return {
      version: USAGE_SYNC_IDENTITY_VERSION,
      deviceId: String(this.#createDeviceId()).toLowerCase(),
      label: normalizeDeviceLabel(this.#legacySource.hostname),
      platform: this.#legacySource.platform,
      publicKey,
      privateKey,
      homeSalt: this.#createHomeSalt(),
      installationInstanceId: String(this.#createInstallationInstanceId()).toLowerCase(),
      createdAt: timestamp,
      updatedAt: timestamp,
      legacyDeviceIds: [legacyUsageSyncDeviceId(this.#legacySource)],
    };
  }

  #completeLocalFields(identity) {
    const completed = {
      ...identity,
      homeSalt: identity.homeSalt || this.#createHomeSalt(),
      installationInstanceId: identity.installationInstanceId
        || String(this.#createInstallationInstanceId()).toLowerCase(),
    };
    return normalizeUsageSyncIdentity(completed, { now: this.#now });
  }

  /**
   * Loads the identity, issuing one on first use. An unreadable or invalid file
   * yields a fresh identity: a derived device id is never used as a fallback,
   * because that is exactly the unstable behaviour this store replaces.
   */
  load() {
    return this.#enqueue(async () => {
      if (this.#identity) return this.#identity;
      const stored = normalizeUsageSyncIdentity(await readJson(this.#file), { now: this.#now });
      if (stored) {
        const completed = this.#completeLocalFields(stored);
        if (!completed) throw new Error("Cannot upgrade usage sync identity");
        if (
          completed.homeSalt !== stored.homeSalt
          || completed.installationInstanceId !== stored.installationInstanceId
        ) {
          await this.#write(completed);
        }
        this.#identity = completed;
        return this.#identity;
      }
      const issued = this.#completeLocalFields(this.#issue());
      if (!issued) throw new Error("Cannot issue a usage sync identity");
      await this.#write(issued);
      this.#identity = issued;
      return this.#identity;
    });
  }

  setLabel(value, { confirmed = false } = {}) {
    return this.#enqueue(async () => {
      if (!this.#identity) throw new Error("Usage sync identity is not loaded");
      const label = normalizeDeviceLabel(value);
      const timestamp = this.#now().toISOString();
      const labelConfirmedAt = confirmed ? timestamp : this.#identity.labelConfirmedAt;
      if (label === this.#identity.label && labelConfirmedAt === this.#identity.labelConfirmedAt) {
        return this.#identity;
      }
      const next = {
        ...this.#identity,
        label,
        updatedAt: timestamp,
        labelConfirmedAt,
      };
      await this.#write(next);
      this.#identity = next;
      return this.#identity;
    });
  }

  /** Ed25519 signature over the exact bytes supplied by the transport layer. */
  sign(message) {
    const privateKey = createPrivateKey({
      key: Buffer.from(this.identity.privateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    return base64Url(signWithKey(null, Buffer.from(message), privateKey));
  }

  verificationKey() {
    return createPublicKey({
      key: Buffer.from(this.identity.publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
  }

  toPublic() {
    return publicUsageSyncIdentity(this.identity);
  }
}
