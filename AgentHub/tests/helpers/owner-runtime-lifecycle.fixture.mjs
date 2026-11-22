import { mkdir } from "node:fs/promises";
import { RuntimeStateStore } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { ProviderRunTerminalStore } from "../../src/infrastructure/persistence/provider-run-terminal-store.mjs";

// Own exactly the existing persistence services for this disposable runtime.
// Keep the snapshot writer alive until every accepted write has joined.
export async function createOwnerRuntimeLifecycle(dataDir, identity) {
  await mkdir(dataDir, { recursive: true });
  const state = new RuntimeStateStore({ dataDir });
  try {
    await state.save({ activeRuns: [{ ...identity, status: "running" }] });
  } catch (error) {
    await state.close();
    throw error;
  }
  const terminals = new ProviderRunTerminalStore({ dataDir });
  return {
    removeActive: () => state.save({ activeRuns: [] }),
    recordTerminal: (status = "aborted") => terminals.record({ ...identity, status }),
    close: () => state.close(),
  };
}
