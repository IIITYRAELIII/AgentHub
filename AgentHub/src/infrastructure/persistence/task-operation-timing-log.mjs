import { appendRotatingLog } from "./rotating-log.mjs";
import { createTaskOperationTimingBatchRecorder } from "../process/task-operation-timing.mjs";

export function createTaskOperationTimingLogRecorder({ logFile, maxBytes, maxFiles, mirror = false,
  maxEvents = 16, maxDelayMs = 250 }) {
  return createTaskOperationTimingBatchRecorder((events) => {
    const lines = events.map((event) => `${event.at} [task-operation-timing] ${JSON.stringify(event)}\n`).join("");
    try { appendRotatingLog(logFile, lines, { maxBytes, maxFiles }); }
    catch (error) { console.error("Cannot write task-operation timing log:", error.message); }
    if (mirror) process.stdout.write(lines);
  }, { maxEvents, maxDelayMs });
}
