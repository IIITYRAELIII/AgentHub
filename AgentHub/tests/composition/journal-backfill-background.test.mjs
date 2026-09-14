import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createJournalBackfillComposition } from "../../src/composition/journal-backfill-composition.mjs";
import { scanCodexTurnPricingMetadata, scanCodexTurnJsonlIncrementally } from "../../src/providers/codex/codex-turn-usage.mjs";

test("optional pricing scan yields and can be cancelled while scanning one long rollout", async () => {
  const controller = new AbortController();
  const line = JSON.stringify({ type: "unrelated", payload: {} }) + "\n";
  let input;
  const pending = scanCodexTurnPricingMetadata("unused", ["missing-turn"], {
    signal: controller.signal,
    createReadStreamImpl: () => { input = Readable.from([line.repeat(4096)]); return input; },
  });
  const cancel = setImmediate(() => controller.abort());
  try {
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(input.destroyed, true);
  } finally { clearImmediate(cancel); }
});

test("background backfill checks shutdown cancellation before another project mutation", async () => {
  const controller = new AbortController();
  const writes = [];
  const service = createJournalBackfillComposition({
    projects: [{ path: "first" }, { path: "second" }], projectionProjectRoots: [],
    workLogUsageStore: {
      missingPricingTurns: async () => [],
      synchronizePricingMetadataAndProject: async ({ projectRoot }) => {
        writes.push(projectRoot); controller.abort();
      },
    }, logger: { error() {} },
  });
  await assert.rejects(service.backfill([], { signal: controller.signal, propagateErrors: true }), { name: "AbortError" });
  assert.deepEqual(writes, ["first"]);
});

test("failed optional backfill remains retryable and can report failure to background owner", async () => {
  let fail = true;
  let reads = 0;
  const service = createJournalBackfillComposition({
    projects: [], projectionProjectRoots: [], logger: { error() {} },
    workLogUsageStore: {
      missingPricingTurns: async () => { reads += 1; if (fail) throw new Error("busy"); return []; },
      missingImageGenerationEstimateTurns: async () => [],
    },
  });
  await assert.rejects(service.backfill([], { propagateErrors: true }), /busy/u);
  fail = false;
  await service.backfill([], { propagateErrors: true });
  await service.backfill([], { propagateErrors: true });
  assert.equal(reads, 2);
});


test("background image usage scan yields per chunk and aborts without retrying", async () => {
  const controller = new AbortController();
  let opened = 0;
  const pending = scanCodexTurnJsonlIncrementally("unused", "turn-1", {
    signal: controller.signal, findTurnStartImpl: async () => 0,
    createReadStreamImpl: () => { opened += 1; return Readable.from(["{}\n", "{}\n"]); },
  });
  const cancel = setImmediate(() => controller.abort());
  try {
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(opened, 1);
  } finally { clearImmediate(cancel); }
});
