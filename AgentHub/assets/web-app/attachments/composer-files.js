(() => {
  "use strict";
  const CHUNK_BYTES = 1024 * 1024;
  const MAX_BYTES = 256 * 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  const HASH = /^[0-9a-f]{64}$/u;
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const STORE_MAX_BYTES = 512 * 1024 * 1024;
  const STORE_MAX_FILES = 128;
  const STORAGE_TIMEOUT_MS = 5_000;
  const entries = new Map();
  const staged = new Set();
  let preparingBytes = 0;
  let preparingFiles = 0;
  let database;
  let openingDatabase;

  const storageFailures = Object.freeze({
    unavailable: ["локальное хранилище недоступно в этом браузере", "Проверь разрешение на хранение данных для этого сайта."],
    blocked: ["другая вкладка блокирует локальное хранилище", "Закрой другие вкладки Agent Hub и добавь файл повторно."],
    quota: ["браузеру не хватает места для сохранения файла", "Освободи место на устройстве и добавь файл повторно."],
    capacity: ["локальный архив вложений достиг лимита 128 файлов или 512 МБ", "Отправь файл сейчас; записи старше 7 дней удаляются при следующем сохранении."],
    timeout: ["локальное хранилище не ответило за 5 секунд", "Можно отправить файл сейчас или добавить его повторно позже."],
    verification: ["сохранённая копия файла не прошла проверку", "Можно отправить исходный файл сейчас или добавить его повторно."],
    failed: ["браузер не смог сохранить файл", "Можно отправить файл сейчас или добавить его повторно."],
  });

  function storageError(code, cause) {
    const error = new Error(storageFailures[code][0]);
    error.attachmentStorageCode = code;
    if (cause) error.cause = cause;
    return error;
  }

  function storageFailureFrom(error) {
    const code = error?.attachmentStorageCode
      ?? (error?.name === "QuotaExceededError" ? "quota"
        : ["SecurityError", "NotAllowedError"].includes(error?.name) ? "unavailable" : "failed");
    const [reason, action] = storageFailures[code] ?? storageFailures.failed;
    return { code, reason: `${reason}.`, action };
  }

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
    if (openingDatabase) return openingDatabase;
    if (!globalThis.indexedDB) throw storageError("unavailable");
    const pending = new Promise((resolve, reject) => {
      let finished = false;
      const fail = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(storageError("timeout")), STORAGE_TIMEOUT_MS);
      let request;
      try { request = indexedDB.open("agent-hub-composer-files-v1", 1); }
      catch (error) { fail(error); return; }
      request.onupgradeneeded = () => {
        if (finished) { request.transaction?.abort(); return; }
        if (!request.result.objectStoreNames.contains("files")) request.result.createObjectStore("files", { keyPath: "blobId" });
      };
      request.onsuccess = () => {
        const opened = request.result;
        if (finished) { opened.close(); return; }
        finished = true;
        clearTimeout(timer);
        database = opened;
        const discard = () => { if (database === opened) database = null; };
        opened.onversionchange = () => { opened.close(); discard(); };
        opened.onclose = discard;
        resolve(opened);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(storageError("blocked"));
    });
    openingDatabase = pending;
    try { return await pending; }
    finally { if (openingDatabase === pending) openingDatabase = null; }
  }

  async function storageTransaction(db, mode, operation, deadline = Date.now() + STORAGE_TIMEOUT_MS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw storageError("timeout");
    return new Promise((resolve, reject) => {
      let transaction;
      let failure;
      let result;
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const abort = (error) => {
        failure = error;
        try { transaction?.abort(); } catch { /* It may already have committed. */ }
        finish(error);
      };
      const timer = setTimeout(() => abort(storageError("timeout")), remaining);
      try {
        transaction = db.transaction("files", mode);
        transaction.oncomplete = () => finish(failure);
        transaction.onabort = transaction.onerror = () => finish(failure ?? transaction.error ?? storageError("failed"));
        operation(transaction.objectStore("files"), (value) => { result = value; }, abort);
      } catch (error) {
        if (error?.name === "InvalidStateError" && database === db) { db.close(); database = null; }
        abort(error);
      }
    });
  }

  function readStoredRecord(db, blobId, deadline) {
    return storageTransaction(db, "readonly", (store, setResult, abort) => {
      const request = store.get(blobId);
      request.onsuccess = () => setResult(request.result);
      request.onerror = () => abort(request.error ?? storageError("failed"));
    }, deadline);
  }

  async function verifiedRecord(record, manifest) {
    return Boolean(record && Number(record.storedAt) + RETENTION_MS >= Date.now()
      && record.blob instanceof Blob && record.blob.size === manifest.size
      && (record.blob.type || "application/octet-stream") === manifest.type
      && JSON.stringify(descriptor(record)) === JSON.stringify(manifest)
      && JSON.stringify(await hashesFor(record.blob)) === JSON.stringify(manifest.chunkHashes));
  }

  async function storeFile(record) {
    const deadline = Date.now() + STORAGE_TIMEOUT_MS;
    const db = await openDatabase();
    await storageTransaction(db, "readwrite", (store, _setResult, abort) => {
      const cursor = store.openCursor();
      let retainedBytes = 0;
      let retainedFiles = 0;
      cursor.onsuccess = () => {
        try {
          const item = cursor.result;
          if (!item) {
            if (retainedBytes + record.size > STORE_MAX_BYTES || retainedFiles >= STORE_MAX_FILES) abort(storageError("capacity"));
            else store.put(record);
            return;
          }
          if (Number(item.value.storedAt) + RETENTION_MS < Date.now()) item.delete();
          else if (item.value.blobId !== record.blobId) {
            retainedBytes += Number(item.value.size) || 0;
            retainedFiles += 1;
          }
          item.continue();
        } catch (error) { abort(error); }
      };
      cursor.onerror = () => abort(cursor.error ?? storageError("failed"));
    }, deadline);
    const stored = await readStoredRecord(db, record.blobId, deadline);
    if (!await verifiedRecord(stored, descriptor(record)) || Boolean(stored.uploadStarted) !== Boolean(record.uploadStarted)) {
      throw storageError("verification");
    }
    if (Date.now() >= deadline) throw storageError("timeout");
  }

  function remember(record, durable, storageFailure = null) {
    const value = { ...record, durable, storageFailure, dataUrl: URL.createObjectURL(record.blob) };
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
      let failure = null;
      try { await storeFile(record); } catch (error) { durable = false; failure = storageFailureFrom(error); }
      staged.add(uploadId);
      return remember(record, durable, failure);
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
        const record = await readStoredRecord(db, manifest.blobId);
        if (!await verifiedRecord(record, manifest)) continue;
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
  function storageFailure(value) { return resolve(value)?.storageFailure ?? null; }
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
    try { await storeFile({ ...record, dataUrl: undefined, durable: undefined, storageFailure: undefined }); }
    catch (error) { record.durable = false; record.storageFailure = storageFailureFrom(error); }
  }

  globalThis.AgentHubComposerFiles = Object.freeze({ prepare, resolve, hydrate, serialized, durable, storageFailure, hashesFor, markUploadStarted, settle, prune });
})();
