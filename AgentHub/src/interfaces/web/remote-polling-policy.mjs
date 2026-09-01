export class BoundedPollingBackoff {
  #attempt = 0;

  constructor({
    baseMs,
    maxMs,
    jitterRatio = 0.2,
    random = Math.random,
  } = {}) {
    this.baseMs = Math.max(1, Math.trunc(Number(baseMs) || 1));
    this.maxMs = Math.max(this.baseMs, Math.trunc(Number(maxMs) || this.baseMs));
    this.jitterRatio = Math.min(1, Math.max(0, Number(jitterRatio) || 0));
    this.random = typeof random === "function" ? random : Math.random;
  }

  failure({ minimumMs = 0 } = {}) {
    this.#attempt += 1;
    const exponent = Math.min(30, this.#attempt - 1);
    const bounded = Math.min(this.maxMs, this.baseMs * (2 ** exponent));
    const jitter = bounded * this.jitterRatio * ((this.random() * 2) - 1);
    const requestedMinimum = Math.max(0, Math.trunc(Number(minimumMs) || 0));
    return {
      attempt: this.#attempt,
      delayMs: Math.min(
        this.maxMs,
        Math.max(this.baseMs, requestedMinimum, Math.round(bounded + jitter)),
      ),
    };
  }

  success() {
    const recoveredAttempts = this.#attempt;
    this.#attempt = 0;
    return recoveredAttempts;
  }
}

export function retryAfterMilliseconds(value) {
  const seconds = Number(String(value ?? "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000) : 0;
}
