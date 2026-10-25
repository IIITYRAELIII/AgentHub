import { createRuntimeCpuSample } from "./runtime-cpu-sample.mjs";

// Publish existing health counters into the common trace owner; no second
// event-loop monitor, database or lifecycle state is created here.
export function createRuntimePerformanceSampler({ trace, readHealth, instanceId,
  cpuSample = createRuntimeCpuSample({ trace, instanceId }),
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, intervalMs = 10_000 }) {
  let timer;
  function sample() {
    try {
      const diagnostics = readHealth()?.diagnostics ?? {};
      const metrics = {};
      function visit(value, prefix, depth) {
        if (Object.keys(metrics).length >= 64 || depth > 3) return;
        if (typeof value === "number" && Number.isFinite(value)) metrics[prefix] = value;
        else if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const [key, child] of Object.entries(value).slice(0, 64)) {
            if (/^[a-zA-Z][a-zA-Z0-9_-]{0,50}$/u.test(key)) visit(child, prefix ? `${prefix}.${key}` : key, depth + 1);
          }
        }
      }
      visit(diagnostics.process, "process", 1);
      const backlog = trace.backpressureStats?.();
      if (backlog) visit(backlog, "trace", 1);
      visit(diagnostics, "", 0);
      trace.recordBestEffort({ commandId: `runtime:${instanceId}`, stage: "runtime-health",
        transport: "runtime", outcome: "succeeded", metadata: { metrics, sampleIntervalMs: intervalMs } });
      void cpuSample.start(diagnostics.process)?.catch?.(() => {});
    } catch { /* Diagnostics cannot fail application work. */ }
  }
  return { start() { if (!timer) { timer = setIntervalImpl(sample, intervalMs); timer.unref?.(); } },
    stop() { if (timer) clearIntervalImpl(timer); timer = null; return cpuSample.stop(); }, sample };
}
