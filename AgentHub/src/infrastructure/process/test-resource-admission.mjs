import { setTimeout as delay } from "node:timers/promises";
import { createTestResourceMonitor, TEST_RESOURCE_BUDGET } from "./test-resource-monitor.mjs";

export { TEST_RESOURCE_BUDGET };

// Admission retains prospective demand while a file owns work, including I/O
// phases. The Windows monitor also enforces the same tree CPU budget in its Job.
export async function testResourceAdmission({
  monitor = null,
  intervalMs = 500,
  clock = () => performance.now(),
  wait = delay,
  onSample = () => {},
} = {}) {
  monitor ??= await createTestResourceMonitor();
  let sample;
  let sampledAt = -Infinity;
  let active = 0;
  let memoryEstimate = process.memoryUsage().rss;
  let peakActive = 0;
  let closed = false;
  let refreshing = null;
  let blockedSince = null;
  const metrics = { budget: TEST_RESOURCE_BUDGET, samples: 0, peakCpuFraction: 0, peakRssBytes: 0,
    peakMemoryFraction: 0, cpuMs: 0, waitMs: 0, peakActive: 0, overshootSamples: 0 };
  let weightedCpu = 0;
  let measuredMs = 0;
  async function refresh(force = false) {
    if (closed) throw new Error("Test resource admission is closed");
    if (refreshing) return refreshing;
    if (force || clock() - sampledAt >= intervalMs) {
      refreshing = (async () => {
      sample = await monitor.sample();
      const keys = ["cpuFraction", "hostCpuFraction", "rssBytes", "totalMemory", "freeMemory", "cores", "elapsedMs", "cpuMs"];
      if (keys.some((key) => !Number.isFinite(sample[key]) || sample[key] < 0) || sample.cores < 1 || sample.totalMemory <= 0) {
        throw new Error("Invalid whole test-tree resource sample");
      }
      sampledAt = clock();
      if (active) memoryEstimate = Math.max(memoryEstimate, sample.rssBytes / active);
      metrics.samples += 1;
      metrics.cpuMs = sample.cpuMs;
      metrics.peakCpuFraction = Math.max(metrics.peakCpuFraction, sample.cpuFraction);
      metrics.peakRssBytes = Math.max(metrics.peakRssBytes, sample.rssBytes);
      metrics.peakMemoryFraction = Math.max(metrics.peakMemoryFraction, sample.rssBytes / sample.totalMemory);
      metrics.totalMemory = sample.totalMemory;
      metrics.logicalCpus = sample.cores;
      weightedCpu += sample.cpuFraction * sample.elapsedMs;
      measuredMs += sample.elapsedMs;
      if (sample.cpuFraction > TEST_RESOURCE_BUDGET || sample.rssBytes > sample.totalMemory * TEST_RESOURCE_BUDGET) metrics.overshootSamples += 1;
      onSample({ ...sample, active });
      return sample;
      })();
      try { return await refreshing; } finally { refreshing = null; }
    }
    return sample;
  }
  return {
    async canStart() {
      const value = await refresh();
      const otherCpu = Math.max(0, value.hostCpuFraction - value.cpuFraction);
      const cpuCapacity = Math.min(TEST_RESOURCE_BUDGET, Math.max(0, 1 - otherCpu));
      const cpuDemand = Math.max(value.cpuFraction, active / value.cores);
      const ramCapacity = Math.min(TEST_RESOURCE_BUDGET * value.totalMemory, value.freeMemory + value.rssBytes);
      const memoryDemand = Math.max(value.rssBytes, active * memoryEstimate);
      const fitsMemory = memoryDemand + memoryEstimate <= ramCapacity;
      // A single CPU-bound file is indivisible on a 1/2-core host. Allow one
      // when measured load has headroom, and report any resulting overshoot.
      const fitsCpu = value.cpuFraction < cpuCapacity
        && ((active === 0 && 1 / value.cores > TEST_RESOURCE_BUDGET
            && cpuCapacity >= Math.min(TEST_RESOURCE_BUDGET, 1 / value.cores))
          || cpuDemand + 1 / value.cores <= cpuCapacity);
      const allowed = fitsMemory && fitsCpu;
      if (!allowed) blockedSince ??= clock();
      else if (blockedSince !== null) { metrics.waitMs += clock() - blockedSince; blockedSince = null; }
      return allowed;
    },
    started() { active += 1; peakActive = Math.max(peakActive, active); },
    finished() { active -= 1; },
    async changed() {
      await wait(Math.max(1, intervalMs - (clock() - sampledAt)));
      await refresh(true);
    },
    async close() {
      if (closed) return metrics;
      try { await refresh(true); } finally { closed = true; await monitor.close(); }
      if (blockedSince !== null) metrics.waitMs += clock() - blockedSince;
      metrics.peakActive = peakActive;
      metrics.meanCpuFraction = measuredMs > 0 ? weightedCpu / measuredMs : 0;
      return { ...metrics };
    },
  };
}
