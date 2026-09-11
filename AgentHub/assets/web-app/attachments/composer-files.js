(() => {
  "use strict";
  const CHUNK_BYTES = 1024 * 1024;
  const MAX_BYTES = 256 * 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  const HASH = /^[0-9a-f]{64}$/u;
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const STORE_MAX_BYTES = 512 * 1024 * 1024;
  const STORE_MAX_FILES = 128;
  const entries = new Map();
  const staged = new Set();
  let preparingBytes = 0;
  let preparingFiles = 0;
  let database;

  function descriptor(value) {
    const size = Number(value?.size);
    const hashes = value?.chunkHashes;
    if (!UUID.test(String(value?.uploadId ?? "")) || value?.blobId !== value.uploadId
      || value.chunkBytes !== CHUNK_BYTES || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES
      || !Array.isArray(hashes) || hashes.length !== Math.ceil(size / CHUNK_BYTES)
      || !hashes.every((hash) => HASH.test(hash))) return null;
    return { name: value.name, type: value.type, size, uploadId: value.uploadId, blobId: value.blobId,
      chunkBytes: CHUNK_BYTES, chunkHashes: hashes.slice() };
  }

  async function hashesFor(blob) {
    const hashes = [];
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      hashes.push(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    }
    return hashes;
  }

  async function openDatabase() {
    if (database) return database;
    if (!globalThis.indexedDB) throw new Error("IndexedDB unavailable");
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("agent-hub-composer-files-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath: "blobId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Attachment storage blocked"));
    });
    database.onversionchange = () => { database.close(); database = null; };
    return database;
  }

  async function storeFile(record) {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("files", "readwrite");
      const store = transaction.objectStore("files");
      const cursor = store.openCursor();
      let retainedBytes = 0;
      let retainedFiles = 0;
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) {
          if (retainedBytes + record.size > STORE_MAX_BYTES || retainedFiles >= STORE_MAX_FILES) transaction.abort();
          else store.put(record);
          return;
        }
        if (Number(item.value.storedAt) + RETENTION_MS < Date.now()) item.delete();
        else if (item.value.blobId !== record.blobId) {
          retainedBytes += Number(item.value.size) || 0;
          retainedFiles += 1;
        }
        item.continue();
      };
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Attachment storage failed"));
    });
  }

  function remember(record, durable) {
    const value = { ...record, durable, dataUrl: URL.createObjectURL(record.blob) };
    entries.set(record.blobId, value);
    return value;
  }

  async function prepare(file, metadata) {
    const retainedBytes = [...entries.values()].reduce((total, record) => total + record.size, 0);
    if (retainedBytes + preparingBytes + file.size > STORE_MAX_BYTES || entries.size + preparingFiles >= STORE_MAX_FILES) throw new Error("Локальный лимит вложений исчерпан. Удали ненужные вложения из черновиков.");
    preparingBytes += file.size;
    preparingFiles += 1;
    try {
      const uploadId = crypto.randomUUID();
      const record = { ...metadata, uploadId, blobId: uploadId, chunkBytes: CHUNK_BYTES,
        chunkHashes: await hashesFor(file), blob: file, storedAt: Date.now() };
      let durable = true;
      try { await storeFile(record); } catch { durable = false; }
      staged.add(uploadId);
      return remember(record, durable);
    } finally { preparingBytes -= file.size; preparingFiles -= 1; }
  }

  function resolve(value) {
    const manifest = descriptor(value);
    const record = manifest && entries.get(manifest.blobId);
    return record && JSON.stringify(descriptor(record)) === JSON.stringify(manifest) ? record : null;
  }

  async function hydrate(values) {
    for (const value of values ?? []) {
      const manifest = descriptor(value);
      if (!manifest || resolve(manifest)) continue;
      if ([...entries.values()].reduce((sum, entry) => sum + entry.size, 0) + manifest.size > STORE_MAX_BYTES) continue;
      try {
        const db = await openDatabase();
        const record = await new Promise((resolve, reject) => {
          const request = db.transaction("files", "readonly").objectStore("files").get(manifest.blobId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!record || Number(record.storedAt) + RETENTION_MS < Date.now()
          || !(record.blob instanceof Blob) || record.blob.size !== manifest.size
          || (record.blob.type || "application/octet-stream") !== manifest.type
          || JSON.stringify(descriptor(record)) !== JSON.stringify(manifest)
          || JSON.stringify(await hashesFor(record.blob)) !== JSON.stringify(manifest.chunkHashes)) continue;
        remember(record, true);
      } catch { /* Missing or unverified bytes cannot restore retry authority. */ }
    }
  }

  function serialized(value) { return value?.blobId ? descriptor(value) : value; }
  function durable(value) {
    if (!value?.blobId) return true;
    const record = resolve(value);
    return record?.durable === true && Number(record.storedAt) + RETENTION_MS >= Date.now();
  }
  function settle(values) { for (const value of values) staged.delete(value?.blobId); }
  function prune(retainedIds) {
    const retained = new Set(retainedIds);
    for (const [id, record] of entries) {
      if (retained.has(id) || staged.has(id)) continue;
      if (record.dataUrl) URL.revokeObjectURL(record.dataUrl);
      entries.delete(id);
    }
  }
  async function markUploadStarted(value) {
    const record = resolve(value);
    if (!record || record.uploadStarted) return;
    record.uploadStarted = true;
    try { await storeFile({ ...record, dataUrl: undefined, durable: undefined }); }
    catch { record.durable = false; }
  }

  globalThis.AgentHubComposerFiles = Object.freeze({ prepare, resolve, hydrate, serialized, durable, hashesFor, markUploadStarted, settle, prune });
})();
