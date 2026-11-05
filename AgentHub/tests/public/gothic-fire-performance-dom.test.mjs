import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

test("Gothic scene light pulses without a main-thread style update every frame", { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1080 } });
    const errors = await openFixture(page);
    await page.addStyleTag({ url: "/themes/gothic/theme.css" });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "gothic";
      document.documentElement.dataset.background = "gothic";
      delete document.documentElement.dataset.backgroundOverride;
    });
    await page.waitForFunction(() => document.getAnimations().some((animation) => animation.animationName === "gothic-fire"));
    // Isolate this layer's style cost from unrelated fixture/control animations.
    // The full-page CPU comparison separately leaves rain and status effects on.
    await page.evaluate(() => {
      document.getAnimations().filter((animation) => animation.animationName !== "gothic-fire")
        .forEach((animation) => animation.pause());
    });
    const client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await client.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    // Sample from the host: polling CSSAnimation.currentTime on every rAF would
    // itself force animation/style synchronization and distort this measurement.
    const animationTime = () => page.evaluate(() => document.getAnimations()
      .find((animation) => animation.animationName === "gothic-fire").currentTime);
    const startedAt = await animationTime();
    const before = await metrics();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await metrics();
    assert.ok(await animationTime() - startedAt >= 1000, "the measured scene light must keep advancing");
    assert.ok(after.RecalcStyleCount - before.RecalcStyleCount < 35,
      `scene light caused ${after.RecalcStyleCount - before.RecalcStyleCount} style recalculations while its timeline advanced 1.2s`);
    const light = await page.evaluate(() => {
      const fire = document.getAnimations().find((animation) => animation.animationName === "gothic-fire");
      fire.pause();
      fire.currentTime = 0;
      const dim = Number(getComputedStyle(document.body, "::before").opacity);
      fire.currentTime = 3080;
      const bright = Number(getComputedStyle(document.body, "::before").opacity);
      const filter = getComputedStyle(document.body, "::before").filter;
      return { dim, bright, filter };
    });
    assert.ok(light.bright > light.dim + 0.08, "the scene must retain its irregular visible light pulse");
    assert.equal(light.filter, "none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.animationName === "gothic-fire"));
    assert.equal(await page.evaluate(() => Number(getComputedStyle(document.body, "::before").opacity)), 0.38);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "orbit"; });
    assert.equal(await page.evaluate(() => document.getAnimations().some((animation) => animation.animationName === "gothic-fire")), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
