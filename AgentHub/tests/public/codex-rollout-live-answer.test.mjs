import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createObservedTaskRun } from "../../src/domain/task-runs.mjs";
import { createDesktopSnapshotFactory } from "../../src/interfaces/desktop/desktop-snapshot.mjs";
import { codexRolloutHistory } from "../../src/interfaces/telegram/task-view-controller.mjs";
import { parseCodexRolloutActivity } from "../../src/providers/codex/codex-rollout-activity.mjs";
import { message, observer, start, turnId } from "../providers/codex/codex-rollout-answer.fixture.mjs";
import { applyFixtureSnapshot, launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

test("rollout observer through desktop and shipped client renders exact commentary and final owners", async () => {
  const text = "Equal text belongs to distinct provider items.";
  const source = start() + message("comment-one", "commentary", text);
  let activity = parseCodexRolloutActivity(source);
  const service = observer(async () => activity);
  const binding = { provider: "codex", threadId: "thread-a", turnId,
    observer: true, exactTurnObserver: true, status: "running", operationKind: "user-turn" };
  const initial = await service.read(binding);
  const run = createObservedTaskRun(binding, initial);
  service.applyObserved(run, initial);
  const { desktopRunSnapshot } = createDesktopSnapshotFactory({
    runs: { titleFor: () => "Synthetic turn" },
    context: { latestUsage: () => null, compactionFor: () => null },
  });
  const value = snapshot();
  value.tasks[0].running = true;
  value.tasks[0].run = { ...desktopRunSnapshot(run, { operationKind: "user-turn" }), projectionState: "active" };
  assert.equal(value.tasks[0].run.response, "");
  assert.equal(value.tasks[0].run.responseItemId, "comment-one");
  assert.equal(value.tasks[0].run.responsePhase, "commentary");
  const history = { provider: "codex", threadId: "thread-a", streamId: "stream-a",
    start: 0, end: 1, total: 1, messageTotal: 1, version: "rollout-first",
    items: codexRolloutHistory(activity) };
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = await openFixture(page, { fixtureSnapshot: value, fixtureHistory: history });
    await page.locator("[data-stream-task-id='stream-a']").first().click();
    const card = page.locator("[data-chat-live]");
    await page.waitForFunction(() => document.querySelector("[data-chat-live]")?.innerText
      .includes("Equal text belongs to distinct provider items."));
    assert.equal((await card.innerText()).split(text).length - 1, 1);
    assert.equal(await card.locator("[data-live-body]").isVisible(), false);
    if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await page.screenshot({
      path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, "rollout-commentary.png"),
    });

    activity = parseCodexRolloutActivity(source + message("comment-two", "commentary", text));
    service.applyObserved(run, await service.read(run));
    const next = structuredClone(value);
    next.version = "rollout-second";
    next.tasks[0].run = { ...desktopRunSnapshot(run, { operationKind: "user-turn" }), projectionState: "active" };
    await applyFixtureSnapshot(page, next);
    await page.waitForFunction(() => document.querySelectorAll("[data-chat-live] .turn-trace-reasoning").length === 2);
    assert.equal((await card.innerText()).split(text).length - 1, 2,
      "two equal commentary items remain distinct");

    activity = parseCodexRolloutActivity(source + message("comment-two", "commentary", text)
      + message("final-one", "final_answer", text));
    service.applyObserved(run, await service.read(run));
    const final = structuredClone(next);
    final.version = "rollout-final-item";
    final.tasks[0].run = { ...desktopRunSnapshot(run, { operationKind: "user-turn" }), projectionState: "active" };
    await applyFixtureSnapshot(page, final);
    await page.waitForFunction(() => !document.querySelector("[data-chat-live] [data-live-body]").hidden);
    assert.equal(await card.locator("[data-live-body]").innerText(), text);
    assert.equal((await card.innerText()).split(text).length - 1, 3,
      "the distinct streaming final remains visible beside both commentary items");
    assert.deepEqual(errors, []);
    if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) await page.screenshot({
      path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, "rollout-streaming-final.png"),
    });
  } finally {
    await browser.close();
  }
});
