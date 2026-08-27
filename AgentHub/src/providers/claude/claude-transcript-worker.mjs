import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

import { compactClaudeHistoryLine } from "./claude-transcript-history.mjs";

async function compactHistoryRange({ transcriptPath, start, endExclusive }) {
  if (endExclusive <= start) return { compactLines: [], parsedBytes: start };
  const compactLines = [];
  const pendingChunks = [];
  let pendingLength = 0;
  let parsedBytes = start;
  const stream = createReadStream(transcriptPath, {
    start,
    end: endExclusive - 1,
  });

  const consumeLine = (line, consumedBytes) => {
    const result = compactClaudeHistoryLine(line.toString("utf8"));
    if (result.compactLine) compactLines.push(result.compactLine);
    parsedBytes += consumedBytes;
  };

  for await (const chunk of stream) {
    let chunkStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0A) continue;
      const fragment = chunk.subarray(chunkStart, index);
      if (pendingLength) {
        pendingChunks.push(fragment);
        consumeLine(Buffer.concat(pendingChunks, pendingLength + fragment.length), pendingLength + fragment.length + 1);
        pendingChunks.length = 0;
        pendingLength = 0;
      } else {
        consumeLine(fragment, fragment.length + 1);
      }
      chunkStart = index + 1;
    }
    if (chunkStart < chunk.length) {
      const remainder = chunk.subarray(chunkStart);
      pendingChunks.push(remainder);
      pendingLength += remainder.length;
    }
  }

  if (pendingLength) {
    const result = compactClaudeHistoryLine(Buffer.concat(pendingChunks, pendingLength).toString("utf8"));
    if (result.valid) {
      if (result.compactLine) compactLines.push(result.compactLine);
      parsedBytes += pendingLength;
    }
  }
  return { compactLines, parsedBytes };
}

async function execute(payload) {
  if (payload.operation === "compact-history-range") return compactHistoryRange(payload);
  if (payload.operation === "historical-scan") {
    const { scanClaudeHistoricalTranscript } = await import("./claude-work-log.mjs");
    return scanClaudeHistoricalTranscript(
      await readFile(payload.transcriptPath, "utf8"),
      { transcriptPath: payload.transcriptPath },
    );
  }
  throw new Error(`Unknown Claude transcript worker operation: ${payload.operation}`);
}

try {
  parentPort.postMessage({ ok: true, result: await execute(workerData) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: { message: String(error?.message ?? error) },
  });
}
