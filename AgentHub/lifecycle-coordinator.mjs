export async function settleNamedOperations(entries, {
  logError = () => {},
} = {}) {
  const normalized = entries
    .filter((entry) => entry && typeof entry.run === "function")
    .map((entry) => ({
      name: String(entry.name ?? "operation"),
      promise: Promise.resolve().then(entry.run),
    }));
  const outcomes = await Promise.allSettled(normalized.map((entry) => entry.promise));
  const failures = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") return;
    const failure = {
      name: normalized[index].name,
      error: outcome.reason instanceof Error
        ? outcome.reason
        : new Error(String(outcome.reason)),
    };
    failures.push(failure);
    logError(failure.name, failure.error);
  });
  return { outcomes, failures, ok: failures.length === 0 };
}
