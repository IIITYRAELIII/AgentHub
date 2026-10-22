import { createHash } from "node:crypto";

const normalizedPolicies = new WeakSet();
const normalizedKey = value => String(value ?? "").trim().toLowerCase();
const fail = () => { throw new Error("Invalid private legacy account policy"); };
const record = value => value && typeof value === "object" && !Array.isArray(value);
function key(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\r\n\0]/u.test(value)) return fail();
  return normalizedKey(value);
}

/** Explicit historical operator policy; no personal roster, dates or default
 * accounts are shipped. Missing policy means no team/label attribution.
 */
export function createLegacyTeamUsageAccountPolicy(raw) {
  if (raw == null) return null;
  if (normalizedPolicies.has(raw)) return raw;
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.accounts) || !raw.accounts.length
      || raw.accounts.length > 64 || !Array.isArray(raw.epochs) || !raw.epochs.length || raw.epochs.length > 64
      || !record(raw.deviceLabels ?? {})) return fail();
  const accounts = new Map();
  for (const value of raw.accounts) {
    if (!record(value) || typeof value.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.id)
        || accounts.has(value.id) || typeof value.email !== "string" || value.email.length > 320
        || !/^[^\s@]+@[^\s@]+$/u.test(value.email.trim()) || typeof value.planType !== "string"
        || !value.planType.trim() || value.planType.length > 64 || /[\r\n\0]/u.test(value.planType)) return fail();
    const email = value.email.trim().toLowerCase();
    accounts.set(value.id, Object.freeze({ key: `chatgpt:${createHash("sha256").update(email).digest("hex")}`,
      label: email, type: "chatgpt", planType: value.planType.trim() }));
  }
  const account = id => accounts.get(id) ?? fail();
  const epochs = raw.epochs.map((value, index) => {
    if (!record(value) || (index === 0 ? value.from !== null : typeof value.from !== "string")
        || !record(value.participants ?? {})) return fail();
    const from = index === 0 ? -Infinity : Date.parse(value.from);
    if (index > 0 && (!Number.isFinite(from) || new Date(from).toISOString() !== value.from)) return fail();
    const entries = Object.entries(value.participants ?? {});
    if (entries.length > 256) return fail();
    const participants = new Map();
    for (const [login, id] of entries) {
      const normalized = key(login);
      if (participants.has(normalized)) return fail();
      participants.set(normalized, account(id));
    }
    return { from, date: value.from, defaultAccount: account(value.defaultAccount), participants };
  });
  if (epochs.some((epoch, index) => index > 0 && epoch.from <= epochs[index - 1].from)) return fail();
  const labelEntries = Object.entries(raw.deviceLabels ?? {});
  if (labelEntries.length > 256) return fail();
  const labels = new Map();
  for (const [label, id] of labelEntries) {
    const normalized = key(label);
    if (labels.has(normalized)) return fail();
    labels.set(normalized, account(id));
  }
  const policy = Object.freeze({
    initialAccount: epochs[0].defaultAccount,
    boundaries: Object.freeze(epochs.slice(1).map(epoch => epoch.date)),
    accountAt(login, timestamp) {
      let epoch = epochs[0];
      for (const next of epochs.slice(1)) { if (next.from > timestamp) break; epoch = next; }
      return epoch.participants.get(login) ?? epoch.defaultAccount;
    },
    deviceAccount(label) { return labels.get(label) ?? null; },
  });
  normalizedPolicies.add(policy);
  return policy;
}

export function teamUsageAccountAt(participant, observedMs, policy = null) {
  const login = normalizedKey(participant), timestamp = Number(observedMs);
  if (!login) throw new Error("Team account backfill requires a valid participant login");
  if (!Number.isFinite(timestamp)) throw new Error("Account backfill timestamp must be finite");
  return createLegacyTeamUsageAccountPolicy(policy)?.accountAt(login, timestamp) ?? null;
}

export function inferredTeamAccountForDeviceLabel(deviceLabel, policy = null) {
  return createLegacyTeamUsageAccountPolicy(policy)?.deviceAccount(normalizedKey(deviceLabel)) ?? null;
}

function accountKeyProvider(accountKey) {
  const key = normalizedKey(accountKey);
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : "";
}

function accountBillingType(account) {
  return normalizedKey(account?.accountType ?? account?.type) || accountKeyProvider(account?.accountKey ?? account?.key);
}

function accountSupportsUsageProvider(account, provider) {
  const usageProvider = normalizedKey(provider);
  const billingType = accountBillingType(account);
  if (!usageProvider || !billingType) return false;
  if (usageProvider === "codex") return billingType !== "claude";
  return billingType === usageProvider;
}

export function applyInferredTeamDeviceAccount(event, policy = null) {
  if (!event || typeof event !== "object") return event;
  if (String(event.accountAttribution ?? "").trim().toLowerCase() === "exact") return event;
  const account = inferredTeamAccountForDeviceLabel(event.deviceLabel, policy);
  if (!accountSupportsUsageProvider(account, event.provider)) return event;
  if (!account) return event;
  return {
    ...event,
    accountKey: account.key,
    accountLabel: account.label,
    accountType: account.type,
    accountPlan: account.planType,
    accountAttribution: "inferred",
    accountRecovery: "team-label",
  };
}

function deviceProviderKey(event) {
  const deviceId = String(event?.deviceId ?? "").trim();
  const provider = normalizedKey(event?.provider);
  return deviceId && provider ? `${deviceId}\0${provider}` : "";
}

function eventTimestamp(event) {
  const completedMs = Date.parse(String(event?.completedAt ?? ""));
  if (Number.isFinite(completedMs)) return completedMs;
  const observedMs = Date.parse(String(event?.observedAt ?? ""));
  return Number.isFinite(observedMs) ? observedMs : Number.NaN;
}

function hasExactAccountIdentity(event) {
  return String(event?.accountAttribution ?? "").trim().toLowerCase() === "exact"
    && Boolean(String(event?.accountKey ?? "").trim());
}

function exactAccountObservation(event) {
  if (!hasExactAccountIdentity(event)) return null;
  const timestamp = eventTimestamp(event);
  if (!Number.isFinite(timestamp)) return null;
  return { event, timestamp };
}

function nearestAccountObservation(timeline, timestamp) {
  if (!timeline?.length || !Number.isFinite(timestamp)) return null;
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timeline[middle].timestamp <= timestamp) low = middle + 1;
    else high = middle;
  }
  const before = low > 0 ? timeline[low - 1] : null;
  const after = low < timeline.length ? timeline[low] : null;
  if (!before) return after;
  if (!after) return before;
  return timestamp - before.timestamp <= after.timestamp - timestamp ? before : after;
}

function inferredAccountFromObservation(event, observation) {
  if (!observation) return null;
  const account = observation.event;
  if (!accountSupportsUsageProvider(account, event.provider)) return null;
  return {
    ...event,
    accountKey: account.accountKey,
    accountLabel: account.accountLabel,
    accountType: account.accountType,
    accountPlan: account.accountPlan,
    accountAttribution: "inferred",
    accountRecovery: "device",
  };
}

/**
 * Projection-only recovery for legacy sync events whose untrusted inferred
 * account fields were removed. An exact account observation from the same
 * device and provider is the strongest generic source allowed to derive an
 * account. Same-device cross-provider recovery is allowed only when the billing
 * account type is compatible with the usage provider, so Claude usage is never
 * recovered into a ChatGPT account. The explicit team label mapping remains a
 * fallback under the same compatibility rule. Derived fields never become exact
 * and are not written back to the sync store or exported to VDS.
 */
export function applyInferredDeviceTimelineAccounts(events = [], policy = null) {
  const values = Array.isArray(events) ? events : [];
  const providerTimelines = new Map();
  const deviceTimelines = new Map();
  for (const event of values) {
    const providerKey = deviceProviderKey(event);
    const observation = exactAccountObservation(event);
    if (!observation) continue;
    if (providerKey) {
      if (!providerTimelines.has(providerKey)) providerTimelines.set(providerKey, []);
      providerTimelines.get(providerKey).push(observation);
    }
    const deviceId = String(event?.deviceId ?? "").trim();
    if (deviceId) {
      if (!deviceTimelines.has(deviceId)) deviceTimelines.set(deviceId, []);
      deviceTimelines.get(deviceId).push(observation);
    }
  }
  for (const timeline of [...providerTimelines.values(), ...deviceTimelines.values()]) {
    timeline.sort((left, right) => left.timestamp - right.timestamp);
  }
  return values.map((event) => {
    if (hasExactAccountIdentity(event)) return event;
    const timeline = providerTimelines.get(deviceProviderKey(event))
      ?? deviceTimelines.get(String(event?.deviceId ?? "").trim());
    const inferred = inferredAccountFromObservation(
      event,
      nearestAccountObservation(timeline, eventTimestamp(event)),
    );
    return inferred ?? applyInferredTeamDeviceAccount(event, policy);
  });
}
