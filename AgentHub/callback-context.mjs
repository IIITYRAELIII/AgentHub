const CONTEXT_SUFFIX = /^(.*):u:([0-9a-f]{12})$/i;

function requiresFreshContext(action) {
  return /^(?:approval-mode:|p:\d+$|engine:|codex-model:|codex-reasoning:|codex-mode:|claude-reasoning:|claude-mode:|model:|thread:new$|thread:archive$)/.test(action);
}

export function contextualCallback(action, contextToken) {
  const value = `${String(action)}:u:${String(contextToken)}`;
  if (value.length > 64) throw new Error(`Telegram callback_data exceeds 64 bytes: ${action}`);
  return value;
}

export function resolveContextualCallback(value, currentContextToken) {
  const raw = String(value ?? "");
  const match = CONTEXT_SUFFIX.exec(raw);
  const action = match?.[1] ?? raw;
  const contextual = Boolean(match);
  const stale = requiresFreshContext(action)
    && (!contextual || match[2] !== String(currentContextToken));
  return { action, contextual, stale };
}
