import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

test("compact picker and header preserve unknown occupancy and preparation", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const diagnostics = await openFixture(page, { surface: "web", followSelection: true });
    for (const [flags, status, state] of [
      [{ activityUnknown: true, preparing: false }, "Состояние уточняется · поток занят", "unknown"],
      [{ activityUnknown: false, preparing: true }, "Подготовка хода · Ход выполняется", "running"],
    ]) {
      await page.evaluate((flags) => AgentHub.patchTask("stream-a", {
        ...flags, running: true, run: { turnId: "current", operationKind: "user-turn", projectionState: "active" },
      }), flags);
      await page.locator("[data-mobile-stream-switch]").click();
      const row = page.locator('[data-mobile-stream-id="stream-a"]');
      assert.equal(await row.getAttribute("data-state"), state);
      assert.equal(await row.locator(".mobile-stream-running").innerText(), status);
      assert.equal(await page.locator("[data-mobile-current-status]").innerText(), status);
      await page.keyboard.press("Escape");
    }
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});
