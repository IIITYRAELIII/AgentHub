const SOURCE_VERSION = 1;
const MAX_IDENTITY_LENGTH = 300;
const MAX_SOURCE_OFFSET = 1_000_000;
const MAX_SURFACE_INDEX = 199;
const SOURCE_SURFACES = new Set(["message-body", "trace-reasoning", "reasoning"]);
const SOURCE_ROLES = new Set(["agent", "user"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function cleanIdentity(value, limit = MAX_IDENTITY_LENGTH) {
  const text = String(value ?? "").trim();
  return text && text.length <= limit && !/[\u0000-\u001f\u007f]/u.test(text) ? text : "";
}

export function responseAnnotationSourceMessageKey({
  provider,
  threadId,
  turnId,
  itemId,
  role = "agent",
  clientUserMessageId = "",
} = {}) {
  if (clientUserMessageId) {
    const values = [provider, threadId, clientUserMessageId].map((value) => String(value ?? "").trim());
    return role === "user" && values.every(Boolean) ? `client\u001f${values.join("\u001f")}\u001fuser` : "";
  }
  const values = [provider, threadId, turnId, itemId, role].map((value) => String(value ?? "").trim());
  return values.every(Boolean) ? `provider\u001f${values.join("\u001f")}` : "";
}

export function normalizedResponseAnnotationSource(value) {
  if (!value || Number(value.version) !== SOURCE_VERSION) return null;
  const provider = cleanIdentity(value.provider, 20).toLowerCase();
  const threadId = cleanIdentity(value.threadId);
  const turnId = cleanIdentity(value.turnId);
  const itemId = cleanIdentity(value.itemId);
  const role = String(value.role ?? "").trim().toLowerCase();
  const clientUserMessageId = cleanIdentity(value.clientUserMessageId);
  if (value.clientUserMessageId && (!clientUserMessageId || role !== "user" || turnId || itemId)) return null;
  const surfaceKind = String(value.surfaceKind ?? "").trim();
  const surfaceIndex = Number(value.surfaceIndex);
  const start = Number(value.start);
  const end = Number(value.end);
  const contentHash = String(value.contentHash ?? "").trim().toLowerCase();
  const surfaceHash = String(value.surfaceHash ?? "").trim().toLowerCase();
  const selectionHash = String(value.selectionHash ?? "").trim().toLowerCase();
  const messageKey = responseAnnotationSourceMessageKey({ provider, threadId, turnId, itemId, role, clientUserMessageId });
  if (!provider || !threadId || (!clientUserMessageId && (!turnId || !itemId)) || !SOURCE_ROLES.has(role)
    || String(value.messageKey ?? "") !== messageKey
    || !SOURCE_SURFACES.has(surfaceKind)
    || !Number.isSafeInteger(surfaceIndex) || surfaceIndex < 0 || surfaceIndex > MAX_SURFACE_INDEX
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end <= start || end > MAX_SOURCE_OFFSET
    || !SHA256.test(contentHash) || !SHA256.test(surfaceHash) || !SHA256.test(selectionHash)) return null;
  return {
    version: SOURCE_VERSION,
    provider,
    threadId,
    turnId,
    itemId,
    role,
    messageKey,
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    surfaceKind,
    surfaceIndex,
    start,
    end,
    contentHash,
    surfaceHash,
    selectionHash,
  };
}

export function normalizedResponseAnnotations(values, {
  annotationLimit = 4_000,
} = {}) {
  return (Array.isArray(values) ? values : []).slice(0, 20).flatMap((item) => {
    const text = String(item?.text ?? item?.quote ?? "").trim();
    const annotation = String(item?.annotation ?? item?.comment ?? "").trim().slice(0, annotationLimit);
    if (!text && !annotation) return [];
    const source = normalizedResponseAnnotationSource(item?.source);
    return [{ text, annotation, ...(source ? { source } : {}) }];
  });
}
