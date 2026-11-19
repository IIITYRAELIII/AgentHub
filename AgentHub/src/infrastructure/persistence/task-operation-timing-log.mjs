import { appendRotatingLog } from "./rotating-log.mjs";
import { createTaskOperationTimingBatchRecorder } from "../process/task-operation-timing.mjs";
import { open } from "node:fs/promises";

const PROGRESS_STAGES = new Set(["workflow", "lock", "lock-local-acquire", "prepare-task", "prepare-dev",
  "sparse-worktree", "dependency-project", "dependency-inventory", "dependency-full-proof",
  "dependency-installed-lock-proof", "dependency-npm", "task-binding", "mcp:receipt"]);

export function createTaskOperationTimingLogRecorder({ logFile, maxBytes, maxFiles, mirror = false,
  maxEvents = 16, maxDelayMs = 250 }) {
  const progress = new Map();
  const observe = (event, live) => {
    if (!PROGRESS_STAGES.has(event.stage) || !["start", "end"].includes(event.phase)) return;
    const key = JSON.stringify([event.operationId, event.taskId]);
    let state = progress.get(key);
    if (!state || state.traceId !== event.traceId) state = { traceId: event.traceId, active: new Map() };
    if (event.phase === "start") state.active.set(event.spanId, event.stage);
    else state.active.delete(event.spanId);
    state.value = { stage: [...state.active.values()].at(-1) ?? event.stage,
      phase: state.active.size ? "running" : event.phase, observedAt: event.at, live };
    progress.delete(key);
    progress.set(key, state);
    if (progress.size > 512) progress.delete(progress.keys().next().value);
  };
  const recordBatch = createTaskOperationTimingBatchRecorder((events) => {
    const lines = events.map((event) => `${event.at} [task-operation-timing] ${JSON.stringify(event)}\n`).join("");
    try { appendRotatingLog(logFile, lines, { maxBytes, maxFiles }); }
    catch (error) { console.error("Cannot write task-operation timing log:", error.message); }
    if (mirror) process.stdout.write(lines);
  }, { maxEvents, maxDelayMs });
  const record = event => {
    observe(event, true);
    return recordBatch(event);
  };
  record.readProgress = ({ operationId, taskId }) => {
    const value = progress.get(JSON.stringify([operationId, taskId]))?.value;
    return value ? { ...value, source: "task-operation-timing", canonicalOutcome: null } : null;
  };
  record.restore = async () => {
    let handle;
    try {
      handle = await open(logFile, "r");
      const info = await handle.stat();
      const start = Math.max(0, info.size - 256 * 1024);
      const buffer = Buffer.alloc(info.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start) lines.shift();
      for (const line of lines) {
        const index = line.indexOf("[task-operation-timing] ");
        if (index < 0) continue;
        try {
          const event = JSON.parse(line.slice(index + 24));
          if (event.component === "task-operation-timing" && typeof event.operationId === "string"
              && typeof event.taskId === "string") observe(event, false);
        } catch {}
      }
    } catch {}
    finally { await handle?.close().catch(() => {}); }
  };
  return record;
}
