export class LifecycleOperationTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`Lifecycle operation ${name} timed out after ${timeoutMs} ms`);
    this.name = "LifecycleOperationTimeoutError";
    this.operation = name;
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout(promise, name, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new LifecycleOperationTimeoutError(name, timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function settleNamedOperations(entries, {
  logError = () => {},
  timeoutMs = 45_000,
  now = Date.now,
} = {}) {
  const normalized = entries
    .filter((entry) => entry && typeof entry.run === "function")
    .map((entry) => ({
      name: String(entry.name ?? "operation"),
      run: entry.run,
      timeoutMs: Number(entry.timeoutMs ?? timeoutMs),
    }));
  const deadlineAt = Number.isFinite(timeoutMs) && timeoutMs > 0 ? now() + timeoutMs : Number.POSITIVE_INFINITY;
  const outcomes = [];
  const failures = [];
  for (const entry of normalized) {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      const failure = {
        name: entry.name,
        error: new LifecycleOperationTimeoutError(entry.name, timeoutMs),
      };
      outcomes.push({ status: "rejected", reason: failure.error });
      failures.push(failure);
      logError(failure.name, failure.error);
      break;
    }
    const operationTimeoutMs = Math.min(entry.timeoutMs, remainingMs);
    let outcome;
    try {
      const value = await withTimeout(
        Promise.resolve().then(entry.run),
        entry.name,
        operationTimeoutMs,
      );
      outcome = { status: "fulfilled", value };
    } catch (error) {
      outcome = { status: "rejected", reason: error };
    }
    outcomes.push(outcome);
    if (outcome.status === "fulfilled") continue;
    const failure = {
      name: entry.name,
      error: outcome.reason instanceof Error
        ? outcome.reason
        : new Error(String(outcome.reason)),
    };
    failures.push(failure);
    logError(failure.name, failure.error);
    if (failure.error instanceof LifecycleOperationTimeoutError) break;
  }
  return { outcomes, failures, ok: failures.length === 0 };
}
