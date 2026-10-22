import { Session } from "node:inspector";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_NODES = 50_000;
const MAX_SAMPLES = 50_000;
const MAX_HOTSPOTS = 20;
const MAX_STACK = 8;

function frameSummary(frame, root) {
  const native = new Set(["(root)", "(program)", "(idle)", "(garbage collector)"]);
  let file = "external";
  const url = String(frame?.url ?? "");
  if (/^node:[a-zA-Z0-9_./-]{1,120}$/u.test(url)) file = url;
  else if (url.startsWith("file:")) {
    try {
      const relative = path.relative(root, fileURLToPath(url));
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        && /^[a-zA-Z0-9_./\\@+-]{1,160}$/u.test(relative)) file = relative.replaceAll("\\", "/");
    } catch { /* Unrecognized source URLs are deliberately not retained. */ }
  }
  const name = String(frame?.functionName ?? "");
  return {
    file,
    function: native.has(name) ? name : file !== "external" && /^[a-zA-Z_$][a-zA-Z0-9_.$:# <>-]{0,99}$/u.test(name)
      ? name : "(anonymous)",
    line: Number.isSafeInteger(frame?.lineNumber) && frame.lineNumber >= 0 ? frame.lineNumber + 1 : 0,
  };
}

// Aggregate a bounded prefix of V8's code-location sample. Never persist the raw
// profile, source text, values, absolute URLs or externally supplied function names.
export function summarizeRuntimeCpuProfile(profile, { sourceRoot = SOURCE_ROOT } = {}) {
  const nodes = new Map(), parents = new Map(), weights = new Map();
  const rawNodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  let links = 0;
  for (const node of rawNodes.slice(0, MAX_NODES)) {
    nodes.set(node.id, node);
    for (const child of node.children ?? []) {
      if (links++ >= MAX_NODES) break;
      parents.set(child, node.id);
    }
  }
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  let sampledUs = 0;
  for (let i = 0; i < Math.min(samples.length, MAX_SAMPLES); i += 1) {
    const duration = Number(profile.timeDeltas?.[i]);
    if (!Number.isFinite(duration) || duration < 0) continue;
    sampledUs += duration;
    const weight = weights.get(samples[i]) ?? { samples: 0, durationUs: 0 };
    weight.samples += 1;
    weight.durationUs += duration;
    weights.set(samples[i], weight);
  }
  const hotspots = [...weights].sort((a, b) => b[1].durationUs - a[1].durationUs)
    .slice(0, MAX_HOTSPOTS).map(([id, weight]) => {
      const stack = [], seen = new Set();
      while (nodes.has(id) && !seen.has(id) && stack.length < MAX_STACK) {
        seen.add(id);
        stack.push(frameSummary(nodes.get(id).callFrame, sourceRoot));
        id = parents.get(id);
      }
      return { samples: weight.samples, sampledMs: weight.durationUs / 1000, stack };
    });
  return { sampledMs: sampledUs / 1000, samples: Math.min(samples.length, MAX_SAMPLES),
    nodes: Math.min(rawNodes.length, MAX_NODES), truncated: samples.length > MAX_SAMPLES || rawNodes.length > MAX_NODES,
    hotspots };
}

export function createRuntimeCpuSample({ trace, instanceId, createSession = () => new Session(),
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, clock = Date.now,
  monotonicClock = () => performance.now(), durationMs = 15_000 } = {}) {
  let attempted = false, session = null, timer = null, active = null, finish = null;
  const commandId = `runtime:${instanceId}`;
  function record(stage, outcome, metadata, duration = 0) {
    try { trace.recordBestEffort({ commandId, stage, transport: "runtime", outcome,
      observedAtMs: clock(), monotonicDurationMs: duration, metadata })?.catch?.(() => {}); } catch { /* Diagnostics never own work. */ }
  }
  return {
    start({ eventLoopDelayP95Ms } = {}) {
      // A single sample of an actually slow process. No second loop monitor or
      // new timer-based polling lane; the existing health sampler calls here.
      if (attempted || !(eventLoopDelayP95Ms >= 2000)) return active;
      attempted = true;
      const startedAtMs = clock(), started = monotonicClock();
      const operationSpanId = `cpu:${instanceId}`;
      const common = { operationSpanId, startedAtMs, targetDurationMs: durationMs,
        samplingIntervalUs: 10_000, eventLoopDelayP95Ms };
      record("runtime-cpu-sample", "started", common);
      let resolve;
      active = new Promise(done => { resolve = done; });
      let completed = false;
      const complete = (outcome, profile, interrupted = false) => {
        if (completed) return;
        completed = true;
        if (timer) clearTimeoutImpl(timer);
        timer = null;
        try {
          const summary = profile ? summarizeRuntimeCpuProfile(profile) : null;
          const elapsed = Math.max(0, monotonicClock() - started);
          record("runtime-cpu-sample", outcome, { ...common, interrupted,
            elapsedMs: elapsed, timerOverrunMs: Math.max(0, elapsed - durationMs),
            ...(summary ? { sampledMs: summary.sampledMs, samples: summary.samples,
              nodes: summary.nodes, truncated: summary.truncated } : {}) }, elapsed);
          for (const [rank, hotspot] of (summary?.hotspots ?? []).entries()) {
            record("runtime-cpu-hotspot", "succeeded", { ...common, rank: rank + 1, ...hotspot });
          }
        } catch { record("runtime-cpu-sample", "failed", { ...common, summaryFailed: true }); }
        finally {
          try { session?.disconnect(); } catch {}
          session = null;
          finish = null;
          resolve();
        }
      };
      let finishing = false;
      const post = (method, params, callback) => {
        if (completed) return;
        try {
          session.post(method, params, (error, result) => {
            if (completed) return;
            try { callback(error, result); } catch { complete("failed"); }
          });
        } catch { complete("failed"); }
      };
      finish = (interrupted = false) => {
        if (finishing) return active;
        finishing = true;
        if (timer) clearTimeoutImpl(timer);
        timer = null;
        post("Profiler.stop", {}, (error, value) => complete(error ? "failed" : "succeeded", value?.profile, interrupted));
        return active;
      };
      try {
        session = createSession();
        session.connect(); // In-process only: never opens a TCP inspector endpoint.
        post("Profiler.enable", {}, error => {
          if (error) { complete("failed"); return; }
          post("Profiler.setSamplingInterval", { interval: 10_000 }, error => {
            if (error) { complete("failed"); return; }
            post("Profiler.start", {}, error => {
              if (error) { complete("failed"); return; }
              timer = setTimeoutImpl(() => finish?.(), durationMs);
              timer.unref?.();
            });
          });
        });
      } catch { complete("failed"); }
      return active;
    },
    stop() { return finish?.(true) ?? active; },
  };
}
