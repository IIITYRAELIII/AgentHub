export const EXPERIMENTS_SYSTEM_KEY = "experiments";

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

