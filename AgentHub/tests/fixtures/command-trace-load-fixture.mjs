const STAGES = [
  "client-submit",
  "transport-start",
  "hub-receive",
  "receipt-lock-wait",
  "durable-intake-enqueue",
  "durable-intake-start",
  "durable-intake-commit",
  "response-send",
  "client-ack",
  "dispatch",
  "admission",
  "provider-rpc",
  "provider-accept",
  "first-event",
  "first-content",
  "first-visible",
  "terminal-commit",
  "projection-visible",
];

export function createCommandTraceLoadFixture({
  commandCount = 100,
  startAtMs = 1_787_680_000_000,
} = {}) {
  const spans = [];
  for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
    const commandId = `load-command-${String(commandIndex).padStart(5, "0")}`;
    for (let stageIndex = 0; stageIndex < STAGES.length; stageIndex += 1) {
      spans.push({
        spanId: `${commandId}-span-${String(stageIndex).padStart(2, "0")}`,
        commandId,
        stage: STAGES[stageIndex],
        outcome: "succeeded",
        transport: stageIndex < 9 ? "desktop" : "internal",
        observedAtMs: startAtMs + (commandIndex * 1_000) + stageIndex,
        monotonicDurationMs: (commandIndex % 100) + stageIndex / 100,
        queueDepth: commandIndex % 8,
        lockWaitMs: stageIndex === 3 ? commandIndex % 25 : null,
        sqliteBusyWaitMs: stageIndex === 6 ? commandIndex % 10 : null,
        metadata: { fixture: true, commandIndex, stageIndex },
      });
    }
  }
  return spans;
}
