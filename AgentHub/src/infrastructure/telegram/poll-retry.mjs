const DEFAULT_BASE_DELAY_MS = 3_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export function telegramPollingRetryDelay(
  consecutiveFailures,
  { baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {},
) {
  const failures = Math.max(1, Number(consecutiveFailures) || 1);
  const base = Math.max(1, Number(baseDelayMs) || DEFAULT_BASE_DELAY_MS);
  const maximum = Math.max(base, Number(maxDelayMs) || DEFAULT_MAX_DELAY_MS);
  return Math.min(maximum, base * (2 ** Math.min(10, failures - 1)));
}

export function shouldLogPollingFailure(consecutiveFailures) {
  const failures = Math.max(1, Number(consecutiveFailures) || 1);
  return failures === 1 || (failures & (failures - 1)) === 0;
}
