const OPEN_TAG = "<agent-hub-stream-message>";
const CLOSE_TAG = "</agent-hub-stream-message>";

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
