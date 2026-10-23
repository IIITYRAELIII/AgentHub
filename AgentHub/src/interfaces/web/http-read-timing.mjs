import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;
const ROUTES = new Set(["snapshot", "health", "static"]);

// Opt-in, content-free request timing through the existing trace worker. The
// original client ID is diagnostic only and never becomes mutation authority.
export function createHttpReadTiming({ commandId, route, response, record,
  receivedAtMs = Date.now(), now = () => performance.now(), clock = Date.now,
  cpu = () => process.threadCpuUsage?.(), loop = () => performance.eventLoopUtilization() } = {}) {
  if (!ID.test(String(commandId ?? "")) || !ROUTES.has(route) || typeof record !== "function") return null;
  const started = now(), operationSpanId = randomUUID();
  let ended = false;
  const emit = (stage, outcome, start, metadata, duration = 0) => {
    try { record({ commandId, stage, outcome, transport: "http", observedAtMs: clock(),
      monotonicDurationMs: duration, metadata: { route, operationSpanId, startedAtMs: start, ...metadata } })?.catch?.(() => {}); }
    catch { /* Diagnostics cannot reject an HTTP request. */ }
  };
  const readCounters = () => {
    try { return { at: now(), cpu: cpu(), loop: loop() }; } catch { return { at: now() }; }
  };
  const cost = before => {
    const after = readCounters();
    return { elapsedMs: Math.max(0, after.at - before.at),
      ...(before.cpu && after.cpu ? { threadCpuWindowMs: Math.max(0,
        after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000 } : {}),
      ...(before.loop && after.loop ? { loopActiveWindowMs: Math.max(0, after.loop.active - before.loop.active),
        loopIdleWindowMs: Math.max(0, after.loop.idle - before.loop.idle) } : {}) };
  };
  emit("http-read", "started", receivedAtMs, {});
  const finish = () => {
    if (ended) return;
    ended = true;
    const completed = response.writableFinished;
    emit("http-read", completed && response.statusCode < 400 ? "succeeded" : "failed", receivedAtMs,
      { statusCode: response.statusCode, ...(!completed ? { failureKind: "aborted" } : {}) }, Math.max(0, now() - started));
  };
  response.once("finish", finish);
  response.once("close", finish);
  response.setHeader("X-Agent-Hub-Trace-Id", commandId);
  return {
    commandId,
    start(stage) {
      const before = readCounters(), at = clock();
      emit(stage, "started", at, {});
      let finished = false;
      return outcome => {
        if (finished) return;
        finished = true;
        const metrics = cost(before);
        emit(stage, outcome, at, { ...metrics, synchronous: false }, metrics.elapsedMs);
      };
    },
    sync(stage, operation) {
      const before = readCounters(), at = clock();
      emit(stage, "started", at, {});
      let outcome = "succeeded";
      try { return operation(); } catch (error) { outcome = "failed"; throw error; }
      finally { const metrics = cost(before); emit(stage, outcome, at, { ...metrics, synchronous: true }, metrics.elapsedMs); }
    },
    async measure(stage, operation) {
      const before = readCounters(), at = clock();
      emit(stage, "started", at, {});
      let outcome = "succeeded";
      try { return await operation(); } catch (error) { outcome = "failed"; throw error; }
      finally { const metrics = cost(before); emit(stage, outcome, at, { ...metrics, synchronous: false }, metrics.elapsedMs); }
    },
  };
}
