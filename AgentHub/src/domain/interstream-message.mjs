const OPEN_TAG = "<agent-hub-stream-message>";
const CLOSE_TAG = "</agent-hub-stream-message>";

function cleanText(value, name, maximumLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximumLength || text.includes("\0")) {
    throw new Error(`invalid ${name}`);
  }
  return text;
}

export function createInterstreamMessage({
  workspaceId,
  workspaceName,
  streamId,
  streamName,
  provider,
  text,
} = {}) {
  const source = {
    workspaceId: cleanText(workspaceId, "workspace id", 300),
    workspaceName: cleanText(workspaceName, "workspace name", 500),
    streamId: cleanText(streamId, "stream id", 300),
    streamName: cleanText(streamName, "stream name", 500),
    provider: cleanText(provider, "provider", 100).toLowerCase(),
  };
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
  const workspaceId = String(metadata?.workspaceId ?? "").trim();
  const workspaceName = String(metadata?.workspaceName ?? "").trim();
  const streamId = String(metadata?.streamId ?? "").trim();
  const streamName = String(metadata?.streamName ?? "").trim();
  const provider = String(metadata?.provider ?? "").trim().toLowerCase();
  const text = source.slice(closeAt + CLOSE_TAG.length).trim();
  if (!workspaceId || !workspaceName || !streamId || !streamName || !text) return null;
  const agent = provider === "claude"
    ? "Claude"
    : provider === "codex" ? "Codex" : "";
  return {
    workspaceId,
    workspaceName,
    streamId,
    streamName,
    ...(provider ? { provider } : {}),
    author: `${workspaceName} - ${streamName}${agent ? ` (${agent})` : ""}`,
    text,
  };
}
