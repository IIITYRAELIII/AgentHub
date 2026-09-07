"use strict";

(() => {
  const outcomes = new Set(["accepted", "rejected", "unknown"]);
  const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  const SHA256_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function requestId(value) {
    return String(value ?? "").trim();
  }

  function emptyDraft() {
    return { text: "", attachments: [], taskReferences: [], annotations: [] };
  }

  function safeAttachmentMetadata(attachment, { maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES } = {}) {
    const name = String(attachment?.name ?? "");
    const type = String(attachment?.type ?? "");
    const size = Number(attachment?.size);
    const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
    if (!name || name !== name.trim() || name.length > 255 || name === "." || name === ".."
      || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/u.test(name)
      || /[. ]$/u.test(name) || reserved.test(name)) return null;
    if (!type || type !== type.toLowerCase() || type.length > 255
      || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(type)) return null;
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) return null;
    return { name, type, size };
  }

  function base64Value(character) {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    if (character === "+") return 62;
    if (character === "/") return 63;
    return -1;
  }

  function canonicalBase64Size(value) {
    const body = String(value ?? "");
    if (!body || body.length % 4 !== 0) return -1;
    let padding = 0;
    if (body.endsWith("==")) padding = 2;
    else if (body.endsWith("=")) padding = 1;
    const contentLength = body.length - padding;
    if (contentLength % 4 === 1) return -1;
    for (let index = 0; index < contentLength; index += 1) {
      if (base64Value(body[index]) < 0) return -1;
    }
    for (let index = contentLength; index < body.length; index += 1) {
      if (body[index] !== "=") return -1;
    }
    const significantIndex = body.length - padding - 1;
    const significant = base64Value(body[significantIndex]);
    if (significant < 0 || (padding === 2 && (significant & 0x0f) !== 0)
      || (padding === 1 && (significant & 0x03) !== 0)) return -1;
    return (body.length / 4) * 3 - padding;
  }

  function rotateRight(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function createSha256() {
    const state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const block = new Uint8Array(64);
    const words = new Uint32Array(64);
    let blockLength = 0;
    let byteLength = 0;

    function compress() {
      for (let index = 0; index < 16; index += 1) {
        const offset = index * 4;
        words[index] = ((block[offset] << 24) | (block[offset + 1] << 16)
          | (block[offset + 2] << 8) | block[offset + 3]) >>> 0;
      }
      for (let index = 16; index < 64; index += 1) {
        const left = words[index - 15];
        const right = words[index - 2];
        const s0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
        const s1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = state;
      for (let index = 0; index < 64; index += 1) {
        const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ (~e & g);
        const first = (h + s1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
        const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const second = (s0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + first) >>> 0;
        d = c; c = b; b = a; a = (first + second) >>> 0;
      }
      state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
      state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
      state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
      state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
      blockLength = 0;
    }

    function updateBytes(bytes) {
      byteLength += bytes.length;
      for (let offset = 0; offset < bytes.length;) {
        const count = Math.min(64 - blockLength, bytes.length - offset);
        block.set(bytes.subarray(offset, offset + count), blockLength);
        blockLength += count;
        offset += count;
        if (blockLength === 64) compress();
      }
    }

    function updateString(value) {
      const text = String(value ?? "");
      const encoder = new TextEncoder();
      for (let offset = 0; offset < text.length; offset += 64 * 1024) {
        updateBytes(encoder.encode(text.slice(offset, offset + 64 * 1024)));
      }
    }

    function digestHex() {
      const messageBytes = byteLength;
      block[blockLength] = 0x80;
      blockLength += 1;
      if (blockLength > 56) {
        block.fill(0, blockLength);
        compress();
      }
      block.fill(0, blockLength, 56);
      const bitHigh = Math.floor(messageBytes / 0x20000000);
      const bitLow = (messageBytes * 8) >>> 0;
      for (let index = 0; index < 4; index += 1) {
        block[56 + index] = (bitHigh >>> (24 - index * 8)) & 0xff;
        block[60 + index] = (bitLow >>> (24 - index * 8)) & 0xff;
      }
      compress();
      return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
    }

    return { digestHex, updateString };
  }

  function fingerprintField(hash, label, value) {
    const text = String(value ?? "");
    hash.updateString(`${label}:${text.length}:`);
    hash.updateString(text);
    hash.updateString("\0");
  }

  function recoveryAttachments(values, {
    maxCount = 8,
    maxDataUrlCharacters = Number.POSITIVE_INFINITY,
    maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
    maxTotalBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  } = {}) {
    if (!Array.isArray(values) || values.length > maxCount) return null;
    let characters = 0;
    let bytes = 0;
    const result = [];
    for (const attachment of values) {
      const metadata = safeAttachmentMetadata(attachment, { maxBytes });
      if (!metadata) return null;
      const { name, type, size } = metadata;
      const dataUrl = String(attachment?.dataUrl ?? "");
      characters += dataUrl.length;
      if (characters > maxDataUrlCharacters) return null;
      const prefix = `data:${type};base64,`;
      if (!dataUrl.startsWith(prefix)) return null;
      const body = dataUrl.slice(prefix.length);
      if (canonicalBase64Size(body) !== size) return null;
      bytes += size;
      if (bytes > maxTotalBytes) return null;
      result.push({
        name,
        type,
        size,
        dataUrl,
      });
    }
    return result;
  }

  function hasDraftContent(draft) {
    return Boolean(
      String(draft?.text ?? "").length
      || (draft?.attachments ?? []).length
      || (draft?.taskReferences ?? []).length
      || (draft?.annotations ?? []).length,
    );
  }

  function recoveryFingerprint({ taskId, rawText, text, attachments, taskReferences, annotations } = {}) {
    const canonicalAttachments = recoveryAttachments(attachments);
    if (!canonicalAttachments) return "";
    const references = taskReferences == null
      ? []
      : Array.isArray(taskReferences) && taskReferences.length <= 8 ? taskReferences : null;
    const responseAnnotations = annotations == null
      ? []
      : Array.isArray(annotations) && annotations.length <= 20 ? annotations : null;
    if (!references || !responseAnnotations) return "";
    let referenceJson;
    let annotationJson;
    try {
      referenceJson = JSON.stringify(references);
      annotationJson = JSON.stringify(responseAnnotations);
    } catch {
      return "";
    }
    if (referenceJson.length > 16_384 || annotationJson.length > 500_000) return "";
    const hash = createSha256();
    fingerprintField(hash, "version", "2");
    fingerprintField(hash, "task", requestId(taskId));
    fingerprintField(hash, "text", String(rawText ?? text ?? ""));
    fingerprintField(hash, "references", referenceJson);
    fingerprintField(hash, "annotations", annotationJson);
    for (const attachment of canonicalAttachments) {
      fingerprintField(hash, "attachment-name", attachment.name);
      fingerprintField(hash, "attachment-type", attachment.type);
      fingerprintField(hash, "attachment-size", attachment.size);
      fingerprintField(hash, "attachment-data", attachment.dataUrl);
    }
    return `sha256:${hash.digestHex()}`;
  }

  function normalizedDraft(draft, recovery = null) {
    const recoveryDisabled = recovery === false;
    const recoveryId = recoveryDisabled ? "" : requestId(recovery?.requestId ?? draft?.recoveryRequestId);
    const fingerprint = recoveryDisabled ? "" : String(
      recovery?.fingerprint ?? draft?.recoveryFingerprint ?? "",
    );
    return {
      text: String(draft?.text ?? ""),
      attachments: Array.isArray(draft?.attachments) ? draft.attachments.slice() : [],
      taskReferences: Array.isArray(draft?.taskReferences) ? draft.taskReferences.slice() : [],
      annotations: Array.isArray(draft?.annotations) ? draft.annotations.slice() : [],
      ...(draft?.messageOrigin ? { messageOrigin: draft.messageOrigin } : {}),
      ...(draft?.composerTransfer ? { composerTransfer: draft.composerTransfer } : {}),
      ...(recoveryId && fingerprint ? {
        recoveryRequestId: recoveryId,
        recoveryFingerprint: fingerprint,
        ...(draft?.recoveryDurable === true ? { recoveryDurable: true } : {}),
      } : draft?.recoveryNonDurable === true ? { recoveryNonDurable: true } : {}),
    };
  }

  function create({
    drafts,
    retries,
    persist = () => {},
    render = () => {},
    persistenceFailed = () => {},
    invalidateRecovery = () => true,
  }) {
    if (typeof drafts?.get !== "function" || typeof drafts?.set !== "function"
      || typeof retries?.get !== "function" || typeof retries?.set !== "function") {
      throw new TypeError("Composer draft reconciliation requires draft and retry maps");
    }
    const editRevisions = new Map();

    function revision(taskId) {
      return editRevisions.get(requestId(taskId)) ?? 0;
    }

    function save(taskId, draft, { userEdited = false } = {}) {
      const id = requestId(taskId);
      if (!id) return null;
      const previous = drafts.get(id);
      const invalidatedRecoveryRequestId = userEdited
        ? requestId(previous?.recoveryRequestId)
        : "";
      const invalidationDurable = !invalidatedRecoveryRequestId || invalidateRecovery({
        taskId: id,
        requestId: invalidatedRecoveryRequestId,
      }) !== false;
      if (userEdited) {
        retries.delete(id);
        editRevisions.set(id, revision(id) + 1);
      }
      const recovery = userEdited ? false : {
        requestId: previous?.recoveryRequestId,
        fingerprint: previous?.recoveryFingerprint,
      };
      const next = normalizedDraft({
        ...draft,
        recoveryDurable: previous?.recoveryDurable === true,
        recoveryNonDurable: !userEdited && previous?.recoveryNonDurable === true,
      }, recovery);
      if (userEdited) delete next.recoveryNonDurable;
      drafts.set(id, next);
      const persisted = persist({ invalidatedRecoveryRequestId }) !== false;
      if (invalidatedRecoveryRequestId && (!invalidationDurable || !persisted)) {
        next.recoveryNonDurable = true;
        persistenceFailed({ taskId: id, requestId: invalidatedRecoveryRequestId });
      }
      return next;
    }

    function restore(taskId, draft) {
      const id = requestId(taskId);
      if (!id) return null;
      const candidate = normalizedDraft(draft);
      const recoveryId = requestId(candidate.recoveryRequestId);
      const fingerprint = String(candidate.recoveryFingerprint ?? "");
      const exact = Boolean(recoveryId && fingerprint) && recoveryFingerprint({
        taskId: id,
        text: candidate.text,
        attachments: candidate.attachments,
        taskReferences: candidate.taskReferences,
        annotations: candidate.annotations,
      }) === fingerprint;
      const restored = exact
        ? { ...candidate, recoveryDurable: true }
        : normalizedDraft(candidate, false);
      drafts.set(id, restored);
      if (exact) retries.set(id, { requestId: recoveryId, fingerprint });
      else retries.delete(id);
      return restored;
    }

    function complete({ pending = null, requestId: rawRequestId, taskId, outcome }) {
      const id = requestId(rawRequestId);
      const normalizedOutcome = outcomes.has(outcome) ? outcome : "unknown";
      const matchesPending = Boolean(id && pending?.requestId === id);
      const explicitTaskId = requestId(taskId);
      const pendingTaskId = matchesPending ? requestId(pending.taskId) : "";
      const identityConflict = Boolean(explicitTaskId && pendingTaskId && explicitTaskId !== pendingTaskId);
      const resolvedTaskId = identityConflict ? "" : explicitTaskId || pendingTaskId;
      let restored = false;
      let cleared = false;
      let changed = false;
      let durable = true;
      const pendingEditRevision = Number(pending?.editRevision);
      const unchangedSinceSend = matchesPending && (
        !Number.isSafeInteger(pendingEditRevision)
        || pendingEditRevision === revision(resolvedTaskId)
      );

      if (resolvedTaskId && normalizedOutcome === "accepted") {
        if (requestId(retries.get(resolvedTaskId)?.requestId) === id) retries.delete(resolvedTaskId);
        const draft = drafts.get(resolvedTaskId);
        if (requestId(draft?.recoveryRequestId) === id) {
          drafts.set(resolvedTaskId, emptyDraft());
          cleared = true;
          changed = true;
        }
      }

      if (!identityConflict && matchesPending && unchangedSinceSend && normalizedOutcome !== "accepted") {
        retries.set(resolvedTaskId, {
          requestId: pending.requestId,
          fingerprint: pending.fingerprint,
        });
        if (normalizedOutcome === "rejected"
          && pending.restoreOnReject !== false
          && !hasDraftContent(drafts.get(resolvedTaskId))) {
          drafts.set(resolvedTaskId, normalizedDraft({
            text: pending.rawText,
            attachments: pending.attachments,
            taskReferences: pending.taskReferences,
            annotations: pending.annotations,
          }, { requestId: id, fingerprint: pending.fingerprint }));
          restored = true;
          changed = true;
          durable = persist({ requiredRecoveryRequestId: id }) !== false;
          if (durable) {
            drafts.get(resolvedTaskId).recoveryDurable = true;
          } else {
            drafts.set(resolvedTaskId, {
              ...normalizedDraft(drafts.get(resolvedTaskId), false),
              recoveryNonDurable: true,
            });
            persist();
            persistenceFailed({ taskId: resolvedTaskId, requestId: id });
          }
        }
      }

      if (changed) render(resolvedTaskId);
      if ((!restored || durable) && (changed || matchesPending || normalizedOutcome === "accepted")) persist();
      return {
        pending: matchesPending && !identityConflict ? null : pending,
        matched: matchesPending && !identityConflict,
        outcome: normalizedOutcome,
        restored,
        cleared,
        durable,
        retryable: Boolean(resolvedTaskId && retries.has(resolvedTaskId)),
      };
    }

    function remove(taskId) {
      const id = requestId(taskId);
      if (!id) return false;
      const draft = drafts.get(id);
      const recoveryRequestId = requestId(draft?.recoveryRequestId || retries.get(id)?.requestId);
      if (recoveryRequestId) invalidateRecovery({ taskId: id, requestId: recoveryRequestId });
      drafts.delete(id);
      retries.delete(id);
      editRevisions.delete(id);
      persist({ invalidatedRecoveryRequestId: recoveryRequestId });
      return true;
    }

    return Object.freeze({ complete, remove, restore, revision, save });
  }

  window.AgentHubComposerDraftReconciliation = Object.freeze({
    create,
    emptyDraft,
    hasDraftContent,
    normalizedDraft,
    recoveryAttachments,
    recoveryFingerprint,
    safeAttachmentMetadata,
  });
})();
