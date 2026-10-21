// Current-pointer custody, never directory age, owns runtime retirement.
export const RETIRED_RUNTIME_FORMAT = 1;
export const MAX_RETIRED_RUNTIMES = 128;
const ID = /^[A-Za-z0-9._-]{1,160}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const DIGITS = /^\d+$/u;

export function validReleaseBinding(value) {
  return Boolean(value && ID.test(value.releaseId ?? "") && ![".", ".."].includes(value.releaseId) && SHA.test(value.manifestSha256 ?? "")
    && ["dev", "ino", "birthFileTime"].every(k => DIGITS.test(String(value.root?.[k] ?? ""))));
}

function decode(pointer) {
  const value = pointer?.runtimeRetention;
  if (value === undefined) return { kind: "legacy" };
  if (!value || value.version !== RETIRED_RUNTIME_FORMAT || !ID.test(pointer.current ?? "")
      || [".", ".."].includes(pointer.current)
      || (value.current !== null && (!validReleaseBinding(value.current) || value.current.releaseId !== pointer.current))
      || !Array.isArray(value.retired)
      || value.retired.length > MAX_RETIRED_RUNTIMES || value.retired.some(r => !validReleaseBinding(r)
        || !Number.isFinite(Date.parse(r.retiredAt)) || [pointer.current, pointer.previous].includes(r.releaseId))
      || new Set(value.retired.map(r => r.releaseId)).size !== value.retired.length
      || (value.previous !== null && (!validReleaseBinding(value.previous) || value.previous.releaseId !== pointer.previous))) {
    return { kind: "unknown" };
  }
  return { kind: "known", value: structuredClone(value) };
}

export function runtimePointerTransition({ pointer = {}, installed, now = new Date().toISOString() }) {
  if (!validReleaseBinding(installed) || !Number.isFinite(Date.parse(now))) throw new TypeError("Exact verified prepared runtime binding required");
  const old = decode(pointer);
  if (old.kind === "known") {
    const existing = [old.value.current, old.value.previous, ...old.value.retired]
      .filter(Boolean).find(r => r.releaseId === installed.releaseId);
    if (existing && (existing.manifestSha256 !== installed.manifestSha256
        || JSON.stringify(existing.root) !== JSON.stringify(installed.root))) {
      throw new Error("Known runtime identity changed; preserve original custody");
    }
    if (existing?.operationId || existing?.phase === "pruning") {
      throw new Error("Partially retired runtime cannot be reselected");
    }
  }
  const previousId = pointer.current === installed.releaseId ? pointer.previous ?? null : pointer.current ?? pointer.previous ?? null;
  const result = { ...structuredClone(pointer), current: installed.releaseId, previous: previousId, updatedAt: now };
  if (old.kind === "unknown") {
    // Preserve unfamiliar custody bytes; no adoption, rewrite or old deletion.
    result.runtimeRetention = structuredClone(pointer.runtimeRetention);
    return { pointer: result, deferred: "unknown-runtime-retention" };
  }
  const known = old.kind === "known" ? old.value : { previous: null, current: null, retired: [] };
  const previous = known.current?.releaseId === previousId ? known.current
    : known.previous?.releaseId === previousId ? known.previous : null;
  const retired = known.retired.filter(r => ![result.current, result.previous].includes(r.releaseId));
  let deferred = null;
  const retiring = known.previous;
  if (retiring && ![result.current, result.previous].includes(retiring.releaseId)
      && !retired.some(r => r.releaseId === retiring.releaseId)) {
    if (retired.length === MAX_RETIRED_RUNTIMES) deferred = "runtime-retirement-queue-full";
    else retired.push({ ...retiring, retiredAt: now });
  }
  result.runtimeRetention = { version: RETIRED_RUNTIME_FORMAT, current: structuredClone(installed), previous, retired };
  return { pointer: result, deferred };
}

export function runtimeRollbackPointer({ pointer, now = new Date().toISOString() }) {
  if (!pointer.previous) throw new Error("No previous runtime release");
  const result = { ...structuredClone(pointer), current: pointer.previous, previous: pointer.current, updatedAt: now };
  const old = decode(pointer);
  if (old.kind === "known") {
    result.runtimeRetention = { ...old.value, current: old.value.previous, previous: old.value.current };
  }
  // Unsupported/missing binding remains unknown and cannot authorize deletion.
  return result;
}

export function runtimeRetirementCandidates({ pointer, runningReleaseId, pinnedReleaseIds = [] }) {
  const decoded = decode(pointer);
  if (decoded.kind !== "known") return { candidates: [], reason: "unproven-runtime-retirement" };
  const keep = new Set([pointer.current, pointer.previous, runningReleaseId, ...pinnedReleaseIds].filter(Boolean));
  return { candidates: decoded.value.retired.filter(r => !keep.has(r.releaseId)),
    reason: null, kept: [...keep] };
}
