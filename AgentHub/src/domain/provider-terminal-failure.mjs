import { redactSensitiveText } from "./secret-redaction.mjs";

const FAILURE_MESSAGE_LIMIT = 1_000;
const FAILURE_CODE_LIMIT = 80;

export const PROVIDER_TERMINAL_FAILURE_FALLBACK =
  "Провайдер завершил ход с ошибкой без подробностей.";

// The provider controls this text, so redaction happens here, before any hash,
// persistence or projection sees it. Bounding comes last so truncation cannot
// expose a tail the redaction already removed.
function boundedText(value, limit) {
  return redactSensitiveText(String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim())
    .trim()
    .slice(0, limit);
}

export function normalizeProviderTerminalFailure(value, { status = "" } = {}) {
  if (String(status ?? "").trim().toLowerCase() !== "failed") return null;
  const source = value?.terminalFailure ?? value?.failure ?? value?.error ?? value ?? {};
  const message = boundedText(source?.message ?? source?.reason, FAILURE_MESSAGE_LIMIT)
    || PROVIDER_TERMINAL_FAILURE_FALLBACK;
  const rawCode = boundedText(
    source?.code ?? source?.codex_error_info ?? source?.providerCode,
    FAILURE_CODE_LIMIT,
  );
  const code = /^[a-z0-9._:-]+$/iu.test(rawCode) ? rawCode : "";
  return {
    type: "provider_error",
    message,
    ...(code ? { code } : {}),
  };
}

function isSpecificProviderTerminalFailure(value) {
  return Boolean(value?.code)
    || value?.message !== PROVIDER_TERMINAL_FAILURE_FALLBACK;
}

export function mergeProviderTerminalFailure(existingValue, incomingValue, { status = "" } = {}) {
  const existing = normalizeProviderTerminalFailure(existingValue, { status });
  const incoming = normalizeProviderTerminalFailure(incomingValue, { status });
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (isSpecificProviderTerminalFailure(existing) && !isSpecificProviderTerminalFailure(incoming)) {
    return existing;
  }
  return incoming;
}

export function codexTerminalFailure(turn, status = turn?.status) {
  return normalizeProviderTerminalFailure(turn?.error ?? turn?.terminalFailure, { status });
}
