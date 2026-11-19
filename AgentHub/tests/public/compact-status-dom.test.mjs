import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchBrowser, openFixture, bridgeCalls } from "./composer-production.fixture.mjs";

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

test("working mobile conversation keeps Stop and sendable queued draft accessible", async () => {
  const browser = await launchBrowser();
  const captures = fileURLToPath(new URL("../../WIP/hub332-working-queue-captures/", import.meta.url));
  await mkdir(captures, { recursive: true });
  try {
    for (const width of [320, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const diagnostics = await openFixture(page, { surface: "web", followSelection: true });
      await page.evaluate(() => {
        const flags = { running: true, run: { turnId: "queue-layout-current", operationKind: "user-turn", projectionState: "active" } };
        Object.assign(window.__agentHubFixture.snapshot.tasks.find((task) => task.streamId === "stream-a"), flags);
        AgentHub.patchTask("stream-a", flags);
        localStorage.setItem("fixture:send-mode", "accept");
      });
      const input = page.locator("[data-composer-input]");
      const stop = page.locator(".composer-primary-actions [data-chat-stop]");
      const send = page.locator(".composer-primary-actions [data-composer-send]");
      await input.fill("");
      await stop.waitFor({ state: "visible" });
      assert.equal(await send.isVisible(), false, `no draft: ${width}`);
      await page.screenshot({ path: `${captures}/${width}-working-empty.png` });
      await input.fill("Queue while running");
      await send.waitFor({ state: "visible" });
      assert.equal(await stop.isVisible(), true, `sendable draft: ${width}`);
      const boxes = await page.evaluate(() => [
        document.querySelector(".composer-primary-actions [data-chat-stop]"),
        document.querySelector(".composer-primary-actions [data-composer-send]"),
      ].map((element) => {
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      }));
      for (const box of boxes) {
        assert.ok(box.width >= 44 && box.height >= 44, JSON.stringify({ width, box }));
        assert.ok(box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= 844, JSON.stringify({ width, box }));
      }
      assert.ok(boxes[0].right <= boxes[1].left || boxes[1].right <= boxes[0].left, JSON.stringify({ width, boxes }));
      await page.screenshot({ path: `${captures}/${width}-working-sendable.png` });
      await send.click();
      const calls = await bridgeCalls(page, "send-message");
      assert.equal(calls.length, 1, `one addressed queue dispatch: ${width}`);
      assert.equal(calls[0].params.followUpMode, "queue");
      assert.equal(calls[0].params.text, "Queue while running");
      assert.ok(calls[0].params.clientUserMessageId);
      assert.equal((await bridgeCalls(page, "cancel-run")).length, 0);
      assert.deepEqual(diagnostics, []);
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.close();
    }
  } finally { await browser.close(); }
});
