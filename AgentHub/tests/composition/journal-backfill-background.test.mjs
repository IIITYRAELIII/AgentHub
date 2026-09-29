import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJournalBackfillComposition } from "../../src/composition/journal-backfill-composition.mjs";
import { WORK_LOG_IMAGE_BACKFILL_VERSION } from "../../src/domain/codex-usage-estimate.mjs";
import { WORK_LOG_PRICING_PROJECTION_VERSION } from "../../src/domain/token-usage.mjs";
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

test("shipped pricing reprojects already identified turns once after upgrade", async () => {
  let version = "";
  let projections = 0;
  const service = createJournalBackfillComposition({
    projects: [{ path: "project" }], projectionProjectRoots: ["project"],
    logger: { error() {} },
    workLogUsageStore: {
      missingPricingTurns: async () => [],
      synchronizePricingMetadataAndProject: async () => ({ updated: 0 }),
      missingImageGenerationEstimateTurns: async () => [],
      synchronizeUsageEstimatesAndProject: async () => ({ updated: 0 }),
      pricingProjectionVersion: async () => version,
      project: async () => { projections += 1; version = WORK_LOG_PRICING_PROJECTION_VERSION; },
    },
  });
  await service.backfill([]);
  await service.backfill([]);
  assert.equal(projections, 1);
});

test("historical ImageGen is restored in background once across restarts", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub183-image-backfill-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  const threadId = "019f1ec7-8de7-7aa3-92b6-045036561c8e";
  const turnId = "019f1ec8-8de7-7aa3-92b6-045036561c8e";
  const rows = [
    { type: "session_meta", payload: { id: threadId, cwd: directory } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "event_msg", payload: { type: "item_completed", turn_id: turnId,
      item: { type: "Extension", kind: "image_gen.generation", id: "image-1", status: "completed",
        failure: null, savedPath: path.join(directory, "image.png") } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
  await writeFile(rolloutPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  let imageVersion = "";
  let count = 0;
  const seen = [];
  const store = {
    missingPricingTurns: async () => [],
    synchronizePricingMetadataAndProject: async () => ({ updated: 0 }),
    imageBackfillVersion: async () => imageVersion,
    missingImageGenerationEstimateTurns: async ({ allUnestimated }) => {
      seen.push(allUnestimated);
      return count ? [] : [{ provider: "codex", threadId, turnId, startedAt: "2026-09-20T00:00:00Z" }];
    },
    synchronizeUsageEstimatesAndProject: async ({ items }) => {
      count = items[0]?.imageGenerationCount ?? count;
    },
    pricingProjectionVersion: async () => WORK_LOG_PRICING_PROJECTION_VERSION,
    project: async (_file, options) => { imageVersion = options.imageBackfillVersion; },
  };
  const makeService = () => createJournalBackfillComposition({
    projects: [{ path: directory }], projectionProjectRoots: [directory], workLogUsageStore: store,
    logger: { error() {}, log() {} },
  });
  await makeService().backfill([{ id: threadId, path: rolloutPath }], { propagateErrors: true });
  await makeService().backfill([{ id: threadId, path: rolloutPath }], { propagateErrors: true });
  assert.equal(count, 1);
  assert.equal(imageVersion, WORK_LOG_IMAGE_BACKFILL_VERSION);
  assert.deepEqual(seen, [true, false]);
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
