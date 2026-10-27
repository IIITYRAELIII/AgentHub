import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, open, link, opendir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { attachmentContentType, createAttachmentStorageName, imageMatchesContentType } from "../../domain/attachment-files.mjs";
import { attachmentUploadLimits } from "../../domain/attachment-upload-policy.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;
function failure(message, statusCode = 400, state = null) {
  return Object.assign(new Error(message), { statusCode, ...(state ? { state } : {}) });
}
const digest = (body) => createHash("sha256").update(body).digest("hex");
const owners = new Map();
const observations = new AsyncLocalStorage();
function observe(key, duration) {
  const timings = observations.getStore();
  if (timings) timings[key] = (timings[key] ?? 0) + Math.max(0, duration);
}
async function measured(key, operation) {
  if (!observations.getStore()) return operation();
  const started = performance.now();
  try { return await operation(); }
  finally { observe(key, performance.now() - started); }
}
async function* measuredRead(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await measured("storageRead", () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } finally { await iterator.return?.(); }
}

// Local and tunnel HTTP listeners share one owner and its per-user mutation queues.
export async function acquireAttachmentUploadService(options) {
  const key = path.resolve(options.attachmentDirectory);
  let entry = owners.get(key);
  if (entry?.closing) { await entry.closing; entry = owners.get(key); }
  if (!entry) {
    entry = { service: new AttachmentUploadService(options), references: 0, closing: null };
    owners.set(key, entry);
  } else if (JSON.stringify(entry.service.capabilities()) !== JSON.stringify(options.limits ?? attachmentUploadLimits())) {
    throw new Error("Attachment listeners must share one upload policy");
  }
  entry.references++;
  let released = false;
  return { service: entry.service, release: async () => {
    if (released) return;
    released = true;
    if (--entry.references === 0) {
      entry.closing = entry.service.close().finally(() => owners.delete(key));
      await entry.closing;
    }
  } };
}

async function durableWrite(file, body) {
  const handle = await measured("storageOpen", () => open(file, "w", 0o600));
  try {
    await measured("storageWrite", () => handle.writeFile(body));
    await measured("storageSync", () => handle.sync());
  } finally { await measured("storageClose", () => handle.close()); }
}

/** Owns only upload receipts and staging parts; published files belong to commands/history. */
export class AttachmentUploadService {
  #root;
  #staging;
  #limits;
  #now;
  #queues = new Map();
  #cleanupPending = null;
  #readStream;
  #timer;
  #cursor = null;
  #closed = false;

  constructor({ attachmentDirectory, limits = attachmentUploadLimits(), now = Date.now, cleanupIntervalMs = 60_000, readStream = createReadStream }) {
    this.#root = path.resolve(attachmentDirectory);
    this.#staging = path.join(this.#root, ".uploads");
    this.#limits = { ...limits };
    this.#now = now;
    this.#readStream = readStream;
    this.#timer = setInterval(() => {
      if (this.#closed || this.#cleanupPending) return;
      this.#cleanupPending = this.#cleanupNextUser().catch(() => {}).finally(() => { this.#cleanupPending = null; });
    }, cleanupIntervalMs);
    this.#timer.unref?.();
  }

  capabilities() { return { ...this.#limits }; }
  #run(user, action, timings = null) {
    if (this.#closed) return Promise.reject(failure("Upload service closed", 503));
    const started = performance.now();
    const loop = timings ? monitorEventLoopDelay({ resolution: 20 }) : null;
    loop?.enable();
    const result = (this.#queues.get(user) ?? Promise.resolve()).then(() => observations.run(timings, () => {
      observe("ownerQueue", performance.now() - started);
      return action();
    })).finally(() => {
      if (loop) { loop.disable(); timings.ownerLoopMax = loop.max / 1e6; }
    });
    const tail = result.catch(() => {}).then(() => {
      if (this.#queues.get(user) === tail) this.#queues.delete(user);
    });
    this.#queues.set(user, tail);
    return result;
  }
  #user(userId) {
    if (!String(userId ?? "")) throw failure("Missing upload owner", 401);
    return digest(String(userId));
  }
  #id(value) {
    const id = String(value ?? "").toLowerCase();
    if (!UUID.test(id)) throw failure("Invalid upload id");
    return id;
  }
  #directory(user) { return path.join(this.#staging, user); }
  async #load(user) {
    try { return JSON.parse(await measured("storageRead", () => readFile(path.join(this.#directory(user), "index.json"), "utf8"))); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async #save(user, records) {
    const directory = this.#directory(user);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, "index.tmp");
    await durableWrite(temporary, JSON.stringify(records));
    await measured("storageRename", () => rename(temporary, path.join(directory, "index.json")));
  }
  async #expire(user, records) {
    const now = this.#now();
    const expired = records.filter((record) => record.status !== "expired" && record.expiresAt <= now);
    const purged = records.filter((record) => record.status === "expired" && record.tombstoneUntil <= now);
    if (!expired.length && !purged.length) return records;
    for (const record of expired) {
      await measured("storageCleanup", () => rm(path.join(this.#directory(user), this.#id(record.uploadId)), { recursive: true, force: true }));
    }
    const retained = records.filter((record) => record.expiresAt > now || record.status === "expired" && record.tombstoneUntil > now)
      .map((record) => record.expiresAt > now ? record : {
        uploadId: record.uploadId, status: "expired", received: [], expiresAt: record.expiresAt,
        tombstoneUntil: record.tombstoneUntil ?? now + TOMBSTONE_MS,
      });
    retained.push(...expired.map((record) => ({ uploadId: record.uploadId, status: "expired", received: [],
      expiresAt: record.expiresAt, tombstoneUntil: now + TOMBSTONE_MS })));
    await this.#save(user, retained);
    return retained;
  }
  async #cleanupNextUser() {
    if (!this.#cursor) {
      try { this.#cursor = await opendir(this.#staging); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
    }
    const entry = await this.#cursor.read();
    if (!entry) { await this.#cursor.close(); this.#cursor = null; return; }
    if (entry.isDirectory() && HASH.test(entry.name)) {
      await this.#run(entry.name, async () => this.#expire(entry.name, await this.#load(entry.name)));
    }
  }
  #view(record) {
    return { ...this.capabilities(), ...record, received: record.received.map((part) => ({ ...part })) };
  }
  #target(user, record) {
    return path.join(this.#root, createAttachmentStorageName(record.name, `${this.#id(record.uploadId)}-${user.slice(0, 16)}`));
  }
  async #verifiedView(user, record) {
    if (record.status !== "ready") return this.#view(record);
    try {
      const target = this.#target(user, record);
      if (record.path !== target || !HASH.test(record.sha256) || !Number.isSafeInteger(record.size)
        || record.size < 1 || record.size > this.#limits.maxBytes) throw new Error("Invalid ready receipt");
      const info = await stat(target);
      if (!info.isFile() || info.size !== record.size) throw new Error("Ready size changed");
      const hash = createHash("sha256");
      let size = 0;
      for await (const buffer of measuredRead(this.#readStream(target, { start: 0, end: record.size, highWaterMark: this.#limits.chunkBytes }))) {
        size += buffer.length;
        if (size > record.size) throw new Error("Ready size changed");
        hash.update(buffer);
      }
      if (size !== record.size || hash.digest("hex") !== record.sha256) throw new Error("Ready content changed");
    } catch {
      throw failure("Published attachment unavailable or changed; upload cannot be reused", 409);
    }
    return this.#view(record);
  }
  async #record(user, id) {
    const records = await this.#expire(user, await this.#load(user));
    const record = records.find((item) => item.uploadId === id);
    if (!record) throw failure("Upload not found or expired", 404);
    if (record.status === "expired") throw failure("Upload expired", 410, "expired");
    return { records, record };
  }
  begin(userId, metadata, timings = null) {
    return this.#run(this.#user(userId), async () => {
      const user = this.#user(userId);
      const uploadId = this.#id(metadata?.uploadId);
      const name = String(metadata?.name ?? "");
      const type = attachmentContentType(name, metadata?.type);
      const size = Number(metadata?.size);
      const attemptedAtMs = metadata?.attemptedAtMs;
      if (!name || name.length > 1024 || !Number.isSafeInteger(size) || size < 1) throw failure("Invalid upload metadata");
      if (size > this.#limits.maxBytes) throw failure("Attachment exceeds upload limit", 413);
      const now = this.#now();
      if (attemptedAtMs !== undefined && (!Number.isSafeInteger(attemptedAtMs) || attemptedAtMs < 1
        || attemptedAtMs > now + 5 * 60_000)) throw failure("Invalid upload attempt time");
      const records = await this.#expire(user, await this.#load(user));
      const previous = records.find((record) => record.uploadId === uploadId);
      if (previous) {
        if (["expired", "cancelled"].includes(previous.status)) throw failure("Upload no longer available", 410, previous.status);
        if (previous.name !== name || previous.type !== type || previous.size !== size) throw failure("Upload metadata conflict", 409);
        if (previous.attemptedAtMs !== attemptedAtMs) throw failure("Upload attempt conflict", 409);
        return this.#verifiedView(user, previous);
      }
      if (attemptedAtMs !== undefined && now >= attemptedAtMs + this.#limits.ttlMs) throw failure("Upload attempt expired", 410, "expired");
      const active = records.filter((item) => item.status === "uploading" || item.status === "ready");
      if (active.length >= this.#limits.maxUploads || active.reduce((total, item) => total + item.size, 0) + size > this.#limits.maxTotalBytes) {
        throw failure("Upload quota exceeded", 429);
      }
      const record = { uploadId, name, type, size, status: "uploading", received: [], attemptedAtMs,
        expiresAt: Math.min(now + this.#limits.ttlMs,
          attemptedAtMs === undefined ? Infinity : attemptedAtMs + this.#limits.ttlMs) };
      records.push(record);
      await this.#save(user, records);
      return this.#view(record);
    }, timings);
  }
  status(userId, uploadId, timings = null) {
    const user = this.#user(userId);
    return this.#run(user, async () => this.#verifiedView(user, (await this.#record(user, this.#id(uploadId))).record), timings);
  }
  putChunk(userId, uploadId, index, body, sha256, timings = null) {
    return this.#run(this.#user(userId), async () => {
      const user = this.#user(userId), id = this.#id(uploadId);
      const { records, record } = await this.#record(user, id);
      if (record.status !== "uploading") throw failure("Upload is not writable", 409);
      const expected = Math.min(this.#limits.chunkBytes, record.size - index * this.#limits.chunkBytes);
      if (!Number.isSafeInteger(index) || index < 0 || expected < 1 || body.length !== expected || !HASH.test(sha256) || digest(body) !== sha256) throw failure("Invalid upload chunk or hash");
      const previous = record.received.find((part) => part.index === index);
      if (previous) {
        if (previous.sha256 !== sha256 || previous.size !== body.length) throw failure("Upload chunk conflict", 409);
        return this.#view(record);
      }
      const directory = path.join(this.#directory(user), id);
      await mkdir(directory, { recursive: true });
      await durableWrite(path.join(directory, `${index}.tmp`), body);
      await measured("storageRename", () => rename(path.join(directory, `${index}.tmp`), path.join(directory, `${index}.part`)));
      record.received.push({ index, size: body.length, sha256 });
      record.received.sort((a, b) => a.index - b.index);
      await this.#save(user, records);
      return this.#view(record);
    }, timings);
  }
  complete(userId, uploadId, timings = null) {
    return this.#run(this.#user(userId), async () => {
      const user = this.#user(userId), id = this.#id(uploadId);
      const { records, record } = await this.#record(user, id);
      if (record.status === "ready") return this.#verifiedView(user, record);
      if (record.status !== "uploading" || record.received.length !== Math.ceil(record.size / this.#limits.chunkBytes)) throw failure("Upload is incomplete", 409);
      const directory = path.join(this.#directory(user), id);
      const temporary = path.join(directory, "assembled.tmp");
      const output = await measured("storageOpen", () => open(temporary, "w", 0o600));
      const hash = createHash("sha256");
      let size = 0;
      let prefix = Buffer.alloc(0);
      try {
        for (const part of record.received) {
          const partHash = createHash("sha256");
          let partSize = 0;
          for await (const buffer of measuredRead(this.#readStream(path.join(directory, `${part.index}.part`), { highWaterMark: this.#limits.chunkBytes }))) {
            if (prefix.length < 12) prefix = Buffer.concat([prefix, buffer.subarray(0, 12 - prefix.length)]);
            partHash.update(buffer); hash.update(buffer); partSize += buffer.length; size += buffer.length;
            if (partSize > part.size || size > record.size) throw failure("Upload part is corrupt", 409);
            let offset = 0;
            while (offset < buffer.length) offset += (await measured("storageWrite", () => output.write(buffer, offset, buffer.length - offset))).bytesWritten;
          }
          if (partSize !== part.size || partHash.digest("hex") !== part.sha256) throw failure("Upload part is corrupt", 409);
        }
        if (size !== record.size) throw failure("Upload size mismatch", 409);
        if (record.type.startsWith("image/") && !imageMatchesContentType(prefix, record.type)) {
          throw failure("Attachment content does not match its image type", 400);
        }
        await measured("storageSync", () => output.sync());
      } finally { await measured("storageClose", () => output.close()); }
      const sha256 = hash.digest("hex");
      const target = this.#target(user, record);
      try { await measured("storagePublish", () => link(temporary, target)); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        await this.#verifiedView(user, { ...record, status: "ready", path: target, sha256 });
      }
      record.status = "ready"; record.path = target; record.sha256 = sha256;
      await this.#save(user, records);
      await measured("storageCleanup", () => rm(directory, { recursive: true, force: true }));
      return this.#view(record);
    }, timings);
  }
  cancel(userId, uploadId, timings = null) {
    return this.#run(this.#user(userId), async () => {
      const user = this.#user(userId), id = this.#id(uploadId);
      const { records, record } = await this.#record(user, id);
      record.status = "cancelled";
      delete record.path; delete record.sha256;
      await this.#save(user, records);
      await measured("storageCleanup", () => rm(path.join(this.#directory(user), id), { recursive: true, force: true }));
      return this.#view(record);
    }, timings);
  }
  async close() {
    clearInterval(this.#timer);
    this.#closed = true;
    await Promise.allSettled([...this.#queues.values(), this.#cleanupPending]);
    await this.#cursor?.close();
    this.#cursor = null;
  }
}
