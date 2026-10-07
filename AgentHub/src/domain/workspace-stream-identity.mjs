export const EXPERIMENTS_SYSTEM_KEY = "experiments";
export const OTHER_WORKSPACE_NAME = "Other";

const PROVIDERS = new Set(["codex", "claude"]);

function normalizedRequiredText(value, { name, maxChars }) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxChars || text.includes("\0")) {
    throw new Error(`invalid ${name}`);
  }
  return text;
}

export function normalizedProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error(`invalid provider: ${value}`);
  return provider;
}

export function normalizedWorkspaceName(value) {
  return normalizedRequiredText(value, { name: "workspace name", maxChars: 200 });
}

export function normalizedStreamName(value) {
  const name = String(value ?? "").trim();
  if (name.length > 200 || name.includes("\0")) throw new Error("invalid stream name");
  return name || null;
}

export function normalizedThreadIdentity(value) {
  return {
    provider: normalizedProvider(value?.provider),
    threadId: normalizedRequiredText(value?.threadId, {
      name: "provider thread id",
      maxChars: 200,
    }),
  };
}

export function providerThreadKey(value) {
  const identity = normalizedThreadIdentity(value);
  return `${identity.provider}\0${identity.threadId}`;
}

export function streamDisplayName({ name, ordinal, streamCount }) {
  const explicit = normalizedStreamName(name);
  if (explicit) return explicit;
  const count = Math.max(0, Number(streamCount) || 0);
  if (count <= 1) return "";
  return `Stream ${Math.max(1, Number(ordinal) || 1)}`;
}

// Keep the durable Thread number even when a provider title must be truncated.
export function workspaceProviderThreadTitle(workspace, stream, position) {
  const text = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
  const workspaceName = text(workspace?.name);
  if (!workspaceName || !stream?.id || !Number.isSafeInteger(position) || position < 1) {
    throw new Error("Workspace, Stream and durable Thread position are required");
  }
  const number = ` ${position}`;
  const streamName = (text(stream.name) || `Поток ${Math.max(1, Number(stream.ordinal) || 1)}`)
    .slice(0, 80 - number.length - 4);
  const suffix = ` - ${streamName}${number}`;
  return `${workspaceName.slice(0, 80 - suffix.length)}${suffix}`;
}
