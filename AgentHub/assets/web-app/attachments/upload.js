(() => {
  "use strict";
  const PROTOCOL = "agent-hub-attachment-upload-v1";
  const LEGACY_BYTES = 20 * 1024 * 1024;
  const CHUNK_BYTES = 1024 * 1024;

  function create({ request, trace = (_action, operation) => operation() }) {
    let limits;
    async function capabilities({ signal, ...identity } = {}) {
      signal?.throwIfAborted();
      if (limits) return limits;
      const response = await trace("capabilities", () => request("/api/attachment-upload",
        { method: "GET", signal, ...identity }), identity);
      signal?.throwIfAborted();
      if ([404, 405, 501].includes(response.status)) {
        return (limits = { protocol: "legacy", maxBytes: LEGACY_BYTES, maxTotalBytes: LEGACY_BYTES });
      }
      const value = await response.json();
      signal?.throwIfAborted();
      if (!response.ok || value.protocol !== PROTOCOL || value.chunkBytes !== CHUNK_BYTES
        || !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1
        || !Number.isSafeInteger(value.maxTotalBytes) || value.maxTotalBytes < 1) {
        throw new Error("Agent Hub не подтвердил протокол загрузки файлов");
      }
      limits = { ...value, maxBytes: Math.min(value.maxBytes, value.maxTotalBytes) };
      return limits;
    }

    async function json(path, init, action = "request", identity = {}) {
      const response = await trace(action, () => request(path, { ...init, ...identity }), identity);
      const value = await trace("response-json", () => response.json().catch(() => ({})), identity);
      if (!response.ok) {
        const message = value.error ?? `Загрузка: HTTP ${response.status}`;
        const error = new Error([404, 410].includes(response.status) ? `${message}. Выбери файл снова.` : message);
        error.attachmentUploadTerminal = [400, 404, 409, 410, 413, 422].includes(response.status);
        error.attachmentUploadStatus = response.status;
        error.attachmentUploadState = value.state;
        throw error;
      }
      return value;
    }

    async function validateBatch(attachments, { signal } = {}) {
      if (!attachments?.length) return;
      const policy = await capabilities({ signal });
      let total = 0;
      for (const attachment of attachments) {
        const size = Number(attachment?.size);
        if (!Number.isSafeInteger(size) || size <= 0 || size > policy.maxBytes) {
          const error = new Error("Файл превышает лимит текущего Agent Hub или имеет неверный размер");
          error.attachmentUploadTerminal = true;
          throw error;
        }
        total += size;
      }
      if (!Number.isSafeInteger(total) || total > policy.maxTotalBytes) {
        const error = new Error(`Общий лимит вложений текущего Agent Hub: ${Math.floor(policy.maxTotalBytes / 1024 / 1024)} МБ.`);
        error.attachmentUploadTerminal = true;
        throw error;
      }
    }

    async function upload(attachment, { signal, progress = () => {}, traceRequestId } = {}) {
      const identity = { traceUploadId: attachment?.uploadId, traceRequestId };
      const policy = await capabilities({ signal, ...identity });
      const file = globalThis.AgentHubComposerFiles.resolve(attachment);
      if (!file || file.size > policy.maxBytes) {
        const error = new Error(!file ? "Исходный файл недоступен. Выбери его снова." : "Файл превышает лимит текущего Agent Hub");
        error.attachmentUploadTerminal = true;
        throw error;
      }
      signal?.throwIfAborted();
      if (policy.protocol === "legacy") {
        const value = await json("/api/attachment", { method: "POST", signal,
          headers: { "Content-Type": file.type, "X-Agent-Hub-File-Name": encodeURIComponent(file.name) }, body: file.blob }, "legacy", identity);
        if (!value.path) throw new Error("Загрузка файла не подтверждена");
        progress(file.size, file.size);
        return value.path;
      }
      const path = `/api/attachment-upload?id=${encodeURIComponent(file.uploadId)}`;
      if (!file.uploadStarted) {
        // Commit the attempt before begin: a lost begin response must never
        // silently recreate an expired lease under a retained retry identity.
        await trace("attempt-persist", () => globalThis.AgentHubComposerFiles.markUploadStarted(file), identity);
        await json("/api/attachment-upload", { method: "POST", signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId: file.uploadId, name: file.name, type: file.type, size: file.size,
            attemptedAtMs: file.uploadAttemptedAt }) }, "begin", identity);
      }
      let status;
      try { status = await json(path, { method: "GET", signal }, "status", identity); }
      catch (error) {
        // An upgraded owner distinguishes never-created from expired/cancelled.
        // A generic 404 (including an old server) is not permission to re-begin.
        const expiryMs = Number(policy.expiresInMs ?? policy.ttlMs);
        if (error.attachmentUploadStatus !== 404 || error.attachmentUploadState !== "absent"
          || policy.supportsBeginRecovery !== true || !Number.isSafeInteger(expiryMs)
          || expiryMs < 1 || !Number.isSafeInteger(file.uploadAttemptedAt)
          || Date.now() < file.uploadAttemptedAt || Date.now() - file.uploadAttemptedAt >= expiryMs) throw error;
        status = await json("/api/attachment-upload", { method: "POST", signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId: file.uploadId, name: file.name, type: file.type, size: file.size,
            attemptedAtMs: file.uploadAttemptedAt }) }, "begin-recovery", identity);
      }
      if (status.uploadId !== file.uploadId || status.protocol !== PROTOCOL) throw new Error("Несовпадение загрузки файла");
      if (status.status === "cancelled") {
        const error = new Error("Загрузка удалена. Выбери файл снова.");
        error.attachmentUploadTerminal = true;
        throw error;
      }
      const received = new Map((status.received ?? []).map((chunk) => [chunk.index, chunk]));
      let acknowledged = 0;
      for (let index = 0; index < file.chunkHashes.length; index += 1) {
        signal?.throwIfAborted();
        const chunk = file.blob.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
        const previous = received.get(index);
        if (previous && (previous.sha256 !== file.chunkHashes[index] || previous.size !== chunk.size)) {
          throw new Error("Контрольная сумма сохранённой части не совпадает");
        }
        if (!previous) await json(`${path}&index=${index}`, { method: "PUT", signal,
          headers: { "Content-Type": "application/octet-stream", "X-Agent-Hub-Chunk-Sha256": file.chunkHashes[index] }, body: chunk },
        "chunk", { ...identity, traceChunkIndex: index });
        acknowledged += chunk.size;
        progress(acknowledged, file.size);
      }
      if (status.status === "ready" && status.path && /^[0-9a-f]{64}$/u.test(status.sha256 ?? "")) return status.path;
      const complete = await json(`${path}&complete=1`, { method: "POST", signal }, "complete", identity);
      if (complete.uploadId !== file.uploadId || complete.status !== "ready" || !complete.path
        || !/^[0-9a-f]{64}$/u.test(complete.sha256 ?? "")) throw new Error("Загрузка файла не подтверждена");
      return complete.path;
    }

    async function cancel(attachment) {
      if (!attachment?.uploadId || limits?.protocol !== PROTOCOL) return;
      await json(`/api/attachment-upload?id=${encodeURIComponent(attachment.uploadId)}`, { method: "DELETE" }, "cancel",
        { traceUploadId: attachment.uploadId });
    }
    return Object.freeze({ capabilities, validateBatch, upload, cancel });
  }
  globalThis.AgentHubAttachmentUpload = Object.freeze({ create });
})();
