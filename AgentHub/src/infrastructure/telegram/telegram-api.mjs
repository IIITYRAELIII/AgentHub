export class TelegramRequestError extends Error {
  constructor(message, {
    cause,
    retryable = false,
    retryAfterMs = 0,
    uncertain = false,
  } = {}) {
    super(message, { cause });
    this.name = "TelegramRequestError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.uncertain = uncertain;
  }
}

function normalizedTelegramApiBaseUrl(apiBaseUrl) {
  return String(apiBaseUrl || "https://api.telegram.org").replace(/\/+$/, "");
}

function transportFailureSummary(error) {
  const allowed = new Set([
    "AbortError", "TimeoutError", "TypeError", "AggregateError",
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
    "ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]);
  const pending = [error];
  const seen = new Set();
  const codes = new Set();
  while (pending.length && seen.size < 8) {
    const cause = pending.shift();
    if (!cause || typeof cause !== "object" || seen.has(cause)) continue;
    seen.add(cause);
    for (const value of [cause.name, cause.code]) if (allowed.has(value)) codes.add(value);
    pending.push(cause.cause, ...(Array.isArray(cause.errors) ? cause.errors.slice(0, 8) : []));
  }
  // Never copy error.message, request URL, token or payload into startup health.
  return codes.size ? ` (${[...codes].join(", ")})` : "";
}

export function telegramBotApiUrl(apiBaseUrl, token, method) {
  return `${normalizedTelegramApiBaseUrl(apiBaseUrl)}/bot${token}/${String(method).replace(/^\/+/, "")}`;
}

export function telegramFileApiUrl(apiBaseUrl, token, filePath) {
  return `${normalizedTelegramApiBaseUrl(apiBaseUrl)}/file/bot${token}/${String(filePath).replace(/^\/+/, "")}`;
}

export async function callTelegramJson({
  token,
  method,
  body,
  fetchImpl = fetch,
  timeoutMs = 40_000,
  apiBaseUrl = "https://api.telegram.org",
}) {
  let response;
  try {
    response = await fetchImpl(telegramBotApiUrl(apiBaseUrl, token, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new TelegramRequestError(`Telegram ${method}: transport failed${transportFailureSummary(cause)}`, {
      cause,
      retryable: true,
      uncertain: true,
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new TelegramRequestError(`Telegram ${method}: HTTP ${response.status}, invalid JSON`, {
      cause,
      retryable: response.status >= 500 || response.status === 408 || response.status === 429,
    });
  }
  if (!payload.ok) {
    throw new TelegramRequestError(
      `Telegram ${method}: ${payload.description ?? response.status}`,
      {
        retryable: response.status >= 500 || response.status === 408 || response.status === 429,
        retryAfterMs: Number(payload.parameters?.retry_after ?? 0) * 1000,
      },
    );
  }
  return payload.result;
}
