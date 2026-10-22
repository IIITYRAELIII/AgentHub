(() => {
  "use strict";
  const PROTOCOL = "agent-hub-attachment-upload-v1";
  const LEGACY_BYTES = 20 * 1024 * 1024;
  const CHUNK_BYTES = 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

  function create({ request, trace = (_action, operation) => operation() }) {
    let limits;
    function httpError(status, value, action) {
      const error = new Error(value?.error ?? `Загрузка: HTTP ${status}`);
      error.attachmentUploadTerminal = [400, 404, 409, 410, 413, 422].includes(status);
      error.attachmentUploadStatus = status;
      error.attachmentUploadState = value?.state;
      error.attachmentUploadAction = action;
      if ([502, 503, 504].includes(status)) {
        const stage = { capabilities: "согласование загрузки", status: "проверка состояния", begin: "начало",
          "begin-recovery": "восстановление начала", chunk: "передача части", complete: "подтверждение", cancel: "отмена" }[action] ?? "запрос";
        const recovery = ["capabilities", "cancel"].includes(action) ? "Результат запроса не подтверждён."
          : "Файл сохранён в черновике; продолжите загрузку.";
        error.message = `Загрузка: ${stage}, HTTP ${status}. ${recovery}`;
      }
      return error;
    }
    async function exchange(path, init, action, identity) {
      const traceHttpRequestId = crypto.randomUUID();
      const correlation = { ...identity, traceHttpRequestId };
      const headers = { ...init.headers, "X-Agent-Hub-Upload-Request-Id": traceHttpRequestId };
      for (const [key, header] of [["traceUploadId", "X-Agent-Hub-Upload-Id"],
        ["traceAttemptId", "X-Agent-Hub-Upload-Attempt-Id"], ["traceRequestId", "X-Agent-Hub-Message-Request-Id"]]) {
        if (UUID.test(correlation[key] ?? "")) headers[header] = correlation[key];
      }
      return trace(action, () => request(path, { ...init, ...correlation, headers }), correlation);
    }
    async function capabilities({ signal, ...identity } = {}) {
      signal?.throwIfAborted();
      if (limits) return limits;
      const response = await exchange("/api/attachment-upload", { method: "GET", signal }, "capabilities", identity);
      signal?.throwIfAborted();
      if ([404, 405, 501].includes(response.status)) {
        return (limits = { protocol: "legacy", maxBytes: LEGACY_BYTES, maxTotalBytes: LEGACY_BYTES });
      }
      const value = await response.json().catch(() => ({}));
      signal?.throwIfAborted();
      if (!response.ok) throw httpError(response.status, value, "capabilities");
      if (!response.ok || value.protocol !== PROTOCOL || value.chunkBytes !== CHUNK_BYTES
        || !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1
        || !Number.isSafeInteger(value.maxTotalBytes) || value.maxTotalBytes < 1) {
        throw new Error("Agent Hub не подтвердил протокол загрузки файлов");
      }
      limits = { ...value, maxBytes: Math.min(value.maxBytes, value.maxTotalBytes) };
      return limits;
    }

    async function json(path, init, action = "request", identity = {}) {
      const response = await exchange(path, init, action, identity);
      const value = await trace("response-json", () => response.json().catch(() => ({})), identity);
      return trace("receipt", () => {
        if (!response.ok) {
          throw httpError(response.status, value, action);
        }
        return value;
      }, identity);
    }

    async function validateBatch(attachments, { signal, traceRequestId } = {}) {
      if (!attachments?.length) return;
      const policy = await capabilities({ signal, traceUploadId: attachments[0]?.uploadId, traceRequestId });
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
      async function transfer(forceBegin = false) {
        signal?.throwIfAborted();
        const needsBegin = forceBegin || !file.uploadStarted || Boolean(file.pendingUploadAttempt);
        if (!file.uploadStarted || file.pendingUploadAttempt) {
          await trace("attempt-persist", () => globalThis.AgentHubComposerFiles.markUploadStarted(file), identity);
        }
        signal?.throwIfAborted();
        const attemptId = file.uploadAttemptId ?? file.uploadId;
        const attemptIdentity = { ...identity, traceAttemptId: attemptId };
        const path = `/api/attachment-upload?id=${encodeURIComponent(attemptId)}`;
        let status;
        if (needsBegin) {
          // Commit the attempt before begin: a lost begin response must never
          // silently recreate an expired lease under a retained retry identity.
          status = await json("/api/attachment-upload", { method: "POST", signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadId: attemptId, name: file.name, type: file.type, size: file.size,
              attemptedAtMs: file.uploadAttemptedAt }) }, "begin", attemptIdentity);
        }
        // An acknowledged begin already supplies the owner's exact receipt.
        // Only an existing/lost attempt needs a separate status read.
        try { status ??= await json(path, { method: "GET", signal }, "status", attemptIdentity); }
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
            body: JSON.stringify({ uploadId: attemptId, name: file.name, type: file.type, size: file.size,
              attemptedAtMs: file.uploadAttemptedAt }) }, "begin-recovery", attemptIdentity);
        }
        if (status.uploadId !== attemptId || status.protocol !== PROTOCOL) throw new Error("Несовпадение загрузки файла");
        if (status.status === "cancelled") {
          const error = new Error("Загрузка удалена. Исходный файл сохранён в черновике.");
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
          "chunk", { ...attemptIdentity, traceChunkIndex: index });
          acknowledged += chunk.size;
          progress(acknowledged, file.size);
        }
        if (status.status === "ready" && status.path && /^[0-9a-f]{64}$/u.test(status.sha256 ?? "")) return status.path;
        const complete = await json(`${path}&complete=1`, { method: "POST", signal }, "complete", attemptIdentity);
        if (complete.uploadId !== attemptId || complete.status !== "ready" || !complete.path
          || !/^[0-9a-f]{64}$/u.test(complete.sha256 ?? "")) throw new Error("Загрузка файла не подтверждена");
        return complete.path;
      }
      const retainedFailure = (error) => {
        if ([404, 410].includes(error.attachmentUploadStatus)) {
          error.message += ". Исходный файл сохранён в черновике для повтора.";
        }
        throw error;
      };
      try { return await transfer(); }
      catch (error) {
        const now = Date.now();
        const expiryMs = Number(policy.expiresInMs ?? policy.ttlMs);
        const attempted = file.uploadAttemptedAt;
        const absent = error.attachmentUploadStatus === 404 && error.attachmentUploadState === "absent";
        const expired = error.attachmentUploadStatus === 410 && error.attachmentUploadState === "expired";
        const oldOrUnknownAttempt = !Number.isSafeInteger(attempted)
          || Number.isSafeInteger(expiryMs) && expiryMs > 0 && now >= attempted + expiryMs;
        if (policy.supportsBeginRecovery !== true || signal?.aborted
          || !(expired || absent && oldOrUnknownAttempt)
          || Number.isSafeInteger(attempted) && now < attempted) return retainedFailure(error);
        const attemptId = file.uploadAttemptId ?? file.uploadId;
        await trace("attempt-renewal", () => globalThis.AgentHubComposerFiles.restartUploadAttempt(file, attemptId),
          { ...identity, traceAttemptId: attemptId });
        progress(0, file.size, { restarted: true, reason: expired ? "expired" : "absent" });
        // One fresh transport attempt per explicit upload call, never a loop or
        // extension of the expired ID. A lost response resumes this saved ID.
        return transfer(true).catch(retainedFailure);
      }
    }

    async function cancel(attachment) {
      if (!attachment?.uploadId || limits?.protocol !== PROTOCOL) return;
      const file = globalThis.AgentHubComposerFiles.resolve(attachment);
      const attemptId = file?.uploadAttemptId ?? attachment.uploadId;
      await json(`/api/attachment-upload?id=${encodeURIComponent(attemptId)}`, { method: "DELETE" }, "cancel",
        { traceUploadId: attachment.uploadId, traceAttemptId: attemptId });
    }
    return Object.freeze({ capabilities, validateBatch, upload, cancel });
  }
  globalThis.AgentHubAttachmentUpload = Object.freeze({ create });
})();
