export const DURABLE_OBJECT_FREE_REQUESTS_PER_DAY = 100_000;
export const DURABLE_OBJECT_FREE_GB_SECONDS_PER_DAY = 13_000;
export const DURABLE_OBJECT_ALLOCATED_GB = 128 / 1_024;

export function remoteControlTransportBudget({
  channels = 2,
  fallbackMs = 10_000,
  heartbeatMs = 60_000,
  immediatePullP99Ms = 250,
  connectionRequestsPerChannel = 1,
} = {}) {
  const normalizedChannels = Math.max(1, Math.trunc(Number(channels) || 1));
  const normalizedFallbackMs = Math.max(1_000, Math.trunc(Number(fallbackMs) || 10_000));
  const normalizedHeartbeatMs = Math.max(10_000, Math.trunc(Number(heartbeatMs) || 60_000));
  const normalizedPullMs = Math.max(0, Number(immediatePullP99Ms) || 0);
  const fallbackRequests = Math.ceil((86_400_000 / normalizedFallbackMs) * normalizedChannels);
  const heartbeatMessages = Math.ceil((86_400_000 / normalizedHeartbeatMs) * normalizedChannels);
  const websocketRequestEquivalents = Math.ceil(heartbeatMessages / 20)
    + (normalizedChannels * Math.max(1, Math.trunc(Number(connectionRequestsPerChannel) || 1)));
  const fallbackGbSeconds = fallbackRequests * (normalizedPullMs / 1_000) * DURABLE_OBJECT_ALLOCATED_GB;
  return {
    channels: normalizedChannels,
    fallbackMs: normalizedFallbackMs,
    heartbeatMs: normalizedHeartbeatMs,
    immediatePullP99Ms: normalizedPullMs,
    fallbackRequests,
    fallbackRequestRatio: fallbackRequests / DURABLE_OBJECT_FREE_REQUESTS_PER_DAY,
    fallbackGbSeconds,
    fallbackDurationRatio: fallbackGbSeconds / DURABLE_OBJECT_FREE_GB_SECONDS_PER_DAY,
    heartbeatMessages,
    websocketRequestEquivalents,
    websocketRequestRatio: websocketRequestEquivalents / DURABLE_OBJECT_FREE_REQUESTS_PER_DAY,
    websocketIdleGbSeconds: 0,
  };
}

export function assertRemoteControlTransportBudget(budget, {
  maxRequestRatio = 0.25,
  maxDurationRatio = 0.1,
} = {}) {
  if (Number(budget?.fallbackRequestRatio) > maxRequestRatio) {
    throw new Error("remote control fallback exceeds the Durable Objects request budget");
  }
  if (Number(budget?.fallbackDurationRatio) > maxDurationRatio) {
    throw new Error("remote control fallback exceeds the Durable Objects duration budget");
  }
  if (Number(budget?.websocketRequestRatio) > maxRequestRatio || Number(budget?.websocketIdleGbSeconds) !== 0) {
    throw new Error("remote control wake channel exceeds the Durable Objects idle budget");
  }
  return budget;
}
