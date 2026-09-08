import { createHash } from "node:crypto";

const OPEN_TAG = "<agent-hub-stream-message>";
const CLOSE_TAG = "</agent-hub-stream-message>";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ORIGIN_FIELDS = [
  "kind",
  "workspaceId",
  "workspaceName",
  "streamId",
  "streamName",
  "provider",
  "model",
  "sourceThreadId",
  "requestId",
];
const AUDITED_ORIGIN_FIELDS = [
  "workspaceId",
  "streamId",
  "provider",
  "sourceThreadId",
  "requestId",
];

function cleanText(value, name, maximumLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximumLength || text.includes("\0")) {
    throw new Error(`invalid ${name}`);
  }
  return text;
}

function optionalText(value, maximumLength) {
  const text = String(value ?? "").trim();
  return text && text.length <= maximumLength && !text.includes("\0") ? text : "";
}

function auditedInterstreamOrigin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const origin = {
    workspaceId: optionalText(value.workspaceId, 300),
    streamId: optionalText(value.streamId, 300),
    provider: optionalText(value.provider, 100).toLowerCase(),
    sourceThreadId: optionalText(value.sourceThreadId, 300),
    requestId: optionalText(value.requestId, 200),
  };
  return AUDITED_ORIGIN_FIELDS.every((field) => origin[field]) ? origin : null;
}

function auditedInterstreamEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const origin = auditedInterstreamOrigin(value.origin ?? value);
  const argumentsHash = optionalText(value.argumentsHash, 64).toLowerCase();
  const contentHash = optionalText(value.contentHash, 64).toLowerCase();
  const toolName = optionalText(value.toolName, 100);
  if (
    !origin
    || !SHA256_PATTERN.test(argumentsHash)
    || !SHA256_PATTERN.test(contentHash)
    || !toolName
  ) return null;
  return { origin, argumentsHash, contentHash, toolName };
}

export function normalizeInterstreamOrigin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const workspaceId = optionalText(value.workspaceId, 300);
  const workspaceName = optionalText(value.workspaceName, 500);
  const streamId = optionalText(value.streamId, 300);
  const streamName = optionalText(value.streamName, 500);
  if (!workspaceId || !workspaceName || !streamId || !streamName) return null;
  const provider = optionalText(value.provider, 100).toLowerCase();
  const model = optionalText(value.model ?? value.sourceModel, 100);
  const sourceThreadId = optionalText(value.sourceThreadId, 300);
  const requestId = optionalText(value.requestId, 200);
  return {
    kind: "interstream",
    workspaceId,
    workspaceName,
    streamId,
    streamName,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(sourceThreadId ? { sourceThreadId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function normalizeInterstreamClientUserMessageId(value) {
  return optionalText(value, 200) || null;
}

export function createInterstreamOrigin({
  workspaceId,
  workspaceName,
  streamId,
  streamName,
  provider,
  model,
  sourceThreadId,
  requestId,
} = {}) {
  return normalizeInterstreamOrigin({
    workspaceId: cleanText(workspaceId, "workspace id", 300),
    workspaceName: cleanText(workspaceName, "workspace name", 500),
    streamId: cleanText(streamId, "stream id", 300),
    streamName: cleanText(streamName, "stream name", 500),
    provider: cleanText(provider, "provider", 100).toLowerCase(),
    model,
    sourceThreadId,
    requestId,
  });
}

export function interstreamOriginAuthor(value) {
  const origin = normalizeInterstreamOrigin(value);
  if (!origin) return "";
  const providerAgent = origin.provider === "claude"
    ? "Claude"
    : origin.provider === "codex" ? "Codex" : "";
  const family = /(?:^|[-_/])(sol|terra|luna|opus|sonnet|haiku)(?:$|[-_/])/iu
    .exec(origin.model)?.[1];
  const agent = family
    ? `${family[0].toUpperCase()}${family.slice(1).toLowerCase()}`
    : origin.model || providerAgent;
  return `${origin.workspaceName} - ${origin.streamName}${agent ? ` (${agent})` : ""}`;
}

export function createInterstreamMessage({
  workspaceId,
  workspaceName,
  streamId,
  streamName,
  provider,
  model,
  sourceThreadId,
  requestId,
  text,
} = {}) {
  const source = createInterstreamOrigin({
    workspaceId,
    workspaceName,
    streamId,
    streamName,
    provider,
    model,
    sourceThreadId,
    requestId,
  });
  const body = cleanText(text, "message text", 100_000);
  return `${OPEN_TAG}\n${JSON.stringify(source)}\n${CLOSE_TAG}\n${body}`;
}

export function interstreamMessageDetails(value) {
  const source = String(value ?? "").trim();
  if (!source.startsWith(OPEN_TAG)) return null;
  const closeAt = source.indexOf(CLOSE_TAG, OPEN_TAG.length);
  if (closeAt < 0) return null;
  const metadataText = source.slice(OPEN_TAG.length, closeAt).trim();
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    return null;
  }
  const origin = normalizeInterstreamOrigin(metadata);
  const text = source.slice(closeAt + CLOSE_TAG.length).trim();
  if (!origin || !text) return null;
  return {
    ...origin,
    origin,
    author: interstreamOriginAuthor(origin),
    text,
  };
}

export function interstreamAuditContentHash(value, { origin = null } = {}) {
  const details = interstreamMessageDetails(value);
  const stableOrigin = auditedInterstreamOrigin(details?.origin ?? origin);
  const text = String(details?.text ?? value ?? "").trim();
  if (!stableOrigin || !text || text.length > 100_000 || text.includes("\0")) return "";
  return createHash("sha256").update(JSON.stringify({ ...stableOrigin, text })).digest("hex");
}

export function sameInterstreamOrigin(left, right) {
  const normalizedLeft = normalizeInterstreamOrigin(left);
  const normalizedRight = normalizeInterstreamOrigin(right);
  return Boolean(normalizedLeft && normalizedRight && ORIGIN_FIELDS.every((field) => (
    String(normalizedLeft[field] ?? "") === String(normalizedRight[field] ?? "")
  )));
}

export function sameAuditedInterstreamOrigin(left, right) {
  const normalizedLeft = auditedInterstreamOrigin(left);
  const normalizedRight = auditedInterstreamOrigin(right);
  return Boolean(normalizedLeft && normalizedRight && AUDITED_ORIGIN_FIELDS.every((field) => (
    normalizedLeft[field] === normalizedRight[field]
  )));
}

export function trustedInterstreamMessageDetails(value, {
  origin = null,
  clientUserMessageId = "",
  audited = false,
} = {}) {
  const details = interstreamMessageDetails(value);
  if (!details) return null;
  const evidence = audited ? auditedInterstreamEvidence(origin) : null;
  const expectedOrigin = audited ? evidence?.origin : normalizeInterstreamOrigin(origin);
  const suppliedClientId = String(clientUserMessageId ?? "").trim();
  const clientId = normalizeInterstreamClientUserMessageId(clientUserMessageId) ?? "";
  const originMatches = audited
    ? sameAuditedInterstreamOrigin(details.origin, expectedOrigin)
    : sameInterstreamOrigin(details.origin, expectedOrigin);
  if (!originMatches || (suppliedClientId && !clientId) || (audited && !clientId)) return null;
  if (clientId || audited) {
    const requestId = String(details.origin.requestId ?? "").trim();
    if (!requestId || clientId !== `mcp:${requestId}`) return null;
  }
  if (audited && interstreamAuditContentHash(details.text, { origin: details.origin }) !== evidence.contentHash) {
    return null;
  }
  return details;
}

export function trustedAuditedInterstreamBodyDetails(value, {
  origin = null,
  clientUserMessageId = "",
} = {}) {
  if (interstreamMessageDetails(value)) return null;
  const evidence = auditedInterstreamEvidence(origin);
  const clientId = normalizeInterstreamClientUserMessageId(clientUserMessageId) ?? "";
  const text = String(value ?? "").trim();
  if (
    !evidence
    || !clientId
    || clientId !== `mcp:${evidence.origin.requestId}`
    || interstreamAuditContentHash(text, { origin: evidence.origin }) !== evidence.contentHash
  ) return null;
  const normalizedOrigin = normalizeInterstreamOrigin(origin.origin ?? origin);
  if (!normalizedOrigin) return null;
  return {
    ...normalizedOrigin,
    origin: normalizedOrigin,
    author: interstreamOriginAuthor(normalizedOrigin),
    text,
  };
}

export function consistentInterstreamRecordIdentity({
  clientUserMessageIds = [],
  origins = [],
} = {}) {
  const suppliedClientIds = clientUserMessageIds
    .filter((value) => value != null && String(value).trim())
    .map((value) => normalizeInterstreamClientUserMessageId(value));
  const suppliedOrigins = origins
    .filter((value) => value != null)
    .map((value) => normalizeInterstreamOrigin(value));
  const clientUserMessageId = suppliedClientIds[0] ?? null;
  const messageOrigin = suppliedOrigins[0] ?? null;
  const conflicted = suppliedClientIds.some((value) => !value || value !== clientUserMessageId)
    || suppliedOrigins.some((value) => !value || !sameInterstreamOrigin(value, messageOrigin))
    || Boolean(
      messageOrigin?.requestId
      && clientUserMessageId
      && clientUserMessageId !== `mcp:${messageOrigin.requestId}`,
    );
  return conflicted
    ? { conflicted: true, clientUserMessageId: null, messageOrigin: null }
    : { conflicted: false, clientUserMessageId, messageOrigin };
}

export function interstreamDisplayText(value, identity = {}) {
  return trustedInterstreamMessageDetails(value, identity)?.text ?? String(value ?? "");
}
