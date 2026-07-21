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
    throw new TelegramRequestError(`Telegram ${method}: ${cause.message}`, {
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
