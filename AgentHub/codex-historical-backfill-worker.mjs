import { parentPort, workerData } from "node:worker_threads";

import { scanCodexHistoricalRollout } from "./codex-turn-usage.mjs";
import { uuidV7TimestampMs } from "./codex-subagent-accounting.mjs";

try {
  const rolloutCreatedAt = uuidV7TimestampMs(workerData.rolloutId);
  const result = await scanCodexHistoricalRollout(workerData.transcriptPath);
  const turns = result.turns.flatMap((turn) => {
    const createdAt = uuidV7TimestampMs(turn.turnId);
    if (rolloutCreatedAt > 0 && createdAt > 0 && createdAt < rolloutCreatedAt) return [];
    const {
      patches: _patches,
      imageGenerationCalls: _imageGenerationCalls,
      started: _started,
      ...portable
    } = turn;
    return [portable];
  });
  parentPort.postMessage({ ok: true, turns });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: String(error?.stack ?? error?.message ?? error),
  });
}
