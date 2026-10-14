import assert from "node:assert/strict";
import test from "node:test";

import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot } from "./composer-production.fixture.mjs";

function contextSnapshot({ operationId, afterPercent = null, estimated = false }) {
  return {
    usedTokens: afterPercent === null ? null : 73312,
    modelContextWindow: 258400,
    percent: afterPercent,
    estimated,
    usagePending: false,
    compacting: false,
    compaction: {
      operationId, status: "completed", origin: "automatic", turnId: "turn-current",
      beforePercent: 85, afterPercent,
      measurementStatus: afterPercent === null ? "failed" : "completed",
      measurementKind: estimated ? "estimated" : null,
      completedAt: "2026-10-01T12:33:53.226Z",
    },
  };
}

test("shipped client renders provider estimate and a terminal unknown without endless updating", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const initial = snapshot();
    initial.version = "estimate-1";
    initial.tasks[0].context = contextSnapshot({ operationId: "compaction-1", afterPercent: 28.37, estimated: true });
    const errors = await openFixture(page, { fixtureSnapshot: initial });
    await page.waitForFunction(() => document.querySelector("[data-context-label]")?.textContent?.includes("≈28%"));
    assert.equal(await page.locator("[data-context-label]").textContent(), "≈28% контекста");
    await page.locator("[data-context-usage]").click();
    assert.equal(await page.locator("[data-context-usage-modal]").isVisible(), true);
    assert.equal(await page.locator("[data-context-usage-modal]").getByText("≈28%", { exact: true }).count(), 1);
    await page.locator('[data-context-usage-modal] [data-action="context-usage-close"]').first().click();
    const boundary = await page.locator(".msg-maintenance").allTextContents();
    assert.ok(boundary.some((value) => value.includes("≈28%")), JSON.stringify(boundary));

    const percentOnly = snapshot();
    percentOnly.version = "estimate-percent-only";
    percentOnly.tasks[0].context = contextSnapshot({ operationId: "compaction-percent-only",
      afterPercent: 28.37, estimated: true });
    percentOnly.tasks[0].context.usedTokens = null;
    percentOnly.tasks[0].context.modelContextWindow = 0;
    await applyFixtureSnapshot(page, percentOnly);
    await page.waitForFunction(() => document.querySelector("[data-context-label]")?.textContent === "≈28% контекста");
    assert.equal(await page.locator("[data-context-usage]").isVisible(), true);
    await page.locator("[data-context-usage]").click();
    assert.equal(await page.locator("[data-context-usage-modal]").isVisible(), true);
    assert.ok((await page.locator("[data-context-usage-modal]").textContent()).includes("≈28% контекста"));
    await page.locator('[data-context-usage-modal] [data-action="context-usage-close"]').first().click();

    const missing = snapshot();
    missing.version = "estimate-2";
    missing.tasks[0].context = contextSnapshot({ operationId: "compaction-2" });
    await applyFixtureSnapshot(page, missing);
    await page.waitForFunction(() => document.querySelector("[data-context-label]")?.textContent === "нет оценки");
    assert.equal(await page.locator("[data-context-label]").textContent(), "нет оценки");
    assert.ok(!(await page.locator("[data-context-usage]").getAttribute("title")).includes("Ожидается"));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
  }
});
