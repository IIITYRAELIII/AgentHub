import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function liveCardRenderApi() {
  const source = await readFile(
    new URL("../../assets/web-app/live-card-render-controller.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubLiveCardRender;
}

test("live card preserves unchanged trace DOM while streamed answer text advances", async () => {
  const { createLiveCardRenderController, liveCardRenderParts } = await liveCardRenderApi();
  const controller = createLiveCardRenderController();
  const owner = {};
  const groups = Array.from({ length: 12 }, (_, groupIndex) => ({
    id: `group-${groupIndex}`,
    reasoning: `reasoning-${groupIndex}`,
    activities: Array.from({ length: groupIndex < 8 ? 4 : 3 }, (_, activityIndex) => ({
      id: `activity-${groupIndex}-${activityIndex}`,
    })),
  }));
  assert.equal(groups.flatMap((group) => group.activities).length, 44);

  let traceRenders = 0;
  let traceSummaryRenders = 0;
  let bodyRenders = 0;
  const streamedText = ["Первый фрагмент", "Второй фрагмент", "Финальный фрагмент"];
  for (const [index, visibleText] of streamedText.entries()) {
    const parts = liveCardRenderParts({
      visibleText,
      traceGroups: groups,
      activities: groups.flatMap((group) => group.activities),
      stageDetail: `Этап ${index + 1}`,
    });
    controller.reconcile(owner, "trace", parts.trace, () => { traceRenders += 1; });
    controller.reconcile(owner, "trace-summary", parts.traceSummary, () => {
      traceSummaryRenders += 1;
    });
    controller.reconcile(owner, "body", parts.body, () => { bodyRenders += 1; });
  }

  assert.equal(traceRenders, 1);
  assert.equal(traceSummaryRenders, 3);
  assert.equal(bodyRenders, 3);
});

test("grouped trace does not build a second hidden activity feed", async () => {
  const { liveCardRenderParts } = await liveCardRenderApi();
  const activities = Array.from({ length: 44 }, (_, index) => ({ id: `activity-${index}` }));
  const grouped = liveCardRenderParts({
    traceGroups: [{ id: "trace", reasoning: "Проверяю", activities }],
    activities,
    stageDetail: "Выполняется следующий этап…",
  });
  assert.equal(grouped.activityFeed.visible, false);
  assert.deepEqual(Array.from(grouped.activityFeed.activities), []);
  assert.equal(grouped.traceSummary.count, 44);

  const ungrouped = liveCardRenderParts({ activities, stageDetail: "Выполняется следующий этап…" });
  assert.equal(ungrouped.activityFeed.visible, true);
  assert.equal(ungrouped.activityFeed.activities.length, 44);
  assert.equal(ungrouped.activityFeedSummary.stageDetail, "Выполняется следующий этап…");
});

test("failed render is retried instead of being cached as complete", async () => {
  const { createLiveCardRenderController } = await liveCardRenderApi();
  const controller = createLiveCardRenderController();
  const owner = {};
  assert.throws(() => controller.reconcile(owner, "trace", { revision: 1 }, () => {
    throw new Error("render failed");
  }), /render failed/u);
  let renders = 0;
  assert.equal(controller.reconcile(owner, "trace", { revision: 1 }, () => { renders += 1; }), true);
  assert.equal(renders, 1);
});
