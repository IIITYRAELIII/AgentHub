import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFixtureSnapshot, bridgeCalls, launchBrowser, openFixture, setSelectedTask, snapshot,
} from "./composer-production.fixture.mjs";

// Valid 1x1 PNG: the browser must decode the selected File before preparation is released.
const screenshot = {
  name: "screenshot.png", mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
};

async function holdPreparation(page) {
  await page.evaluate(() => {
    const original = window.AgentHubComposerFiles;
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__previewRevocations = [];
    URL.revokeObjectURL = (url) => { window.__previewRevocations.push(url); revoke(url); };
    window.AgentHubComposerFiles = { ...original, prepare: (file, metadata) => new Promise((resolve, reject) => {
      window.__releasePreviewPreparation = async () => {
        window.AgentHubComposerFiles = original;
        try { resolve(await original.prepare(file, metadata)); } catch (error) { reject(error); }
      };
    }) };
    window.__previewStartedAt = performance.now();
  });
}

async function previewUrl(page) {
  await page.waitForFunction(() => {
    const image = document.querySelector("[data-attachment-preparing] img");
    return image?.complete && image.naturalWidth > 0;
  });
  return page.locator("[data-attachment-preparing] img").getAttribute("src");
}

test("production selected screenshot is visible before preparation and explicit send retains exactly one file", {
  timeout: 30_000,
}, async (context) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await holdPreparation(page);
    await page.locator("[data-composer-input]").fill("Screenshot with text");
    await page.locator("[data-file-input]").setInputFiles(screenshot);
    const url = await previewUrl(page);
    assert.match(url, /^blob:/u);
    assert.match(await page.locator("[data-attachment-preparing]").innerText(), /Подготовка…/u);
    assert.equal(await page.locator("[data-attachment-index]").count(), 0);
    assert.equal(await page.locator("[data-composer-send]").isDisabled(), true);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    context.diagnostic(`Selected File decoded before releasing preparation, observed after ${Math.round(await page.evaluate(() => performance.now() - window.__previewStartedAt))} ms (includes test-driver calls)`);
    await page.locator("[data-composer-input]").press("Enter");
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "Screenshot with text");

    await page.evaluate(() => window.__releasePreviewPreparation());
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    assert.equal(await page.locator("[data-attachment-preparing]").count(), 0);
    assert.equal(await page.locator("[data-attachments] img").count(), 1);
    assert.equal(await page.evaluate((value) => window.__previewRevocations.filter((item) => item === value).length, url), 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
      .some((entry) => entry.action === "send-message"));
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].params.attachments.length, 1);
    assert.equal((await bridgeCalls(page, "upload-attachment")).length, 1);
  } finally { await browser.close(); }
});

test("production pending preview cancellation, clear and Thread rebind revoke immediately and cannot resurrect", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    for (const boundary of ["cancel", "clear", "rebind"]) {
      const page = await browser.newPage();
      await openFixture(page);
      await page.locator("[data-composer-input]").fill("Old draft");
      await holdPreparation(page);
      await page.locator("[data-file-input]").setInputFiles(screenshot);
      const url = await previewUrl(page);
      if (boundary === "cancel") await page.locator("[data-attachment-preparation-remove]").click();
      else if (boundary === "clear") await page.locator("[data-composer-input]").fill("");
      else {
        const next = snapshot();
        next.version = "preview-thread-rebound";
        next.tasks[0].threadId = "thread-rebound";
        next.workspaces[0].streams[0].threads = [{ id: "thread-rebound" }];
        next.selected.threadId = "thread-rebound";
        await applyFixtureSnapshot(page, next);
      }
      await page.waitForFunction(() => !document.querySelector("[data-attachment-preparing]"));
      assert.equal(await page.evaluate((value) => window.__previewRevocations.filter((item) => item === value).length, url), 1, boundary);
      await page.evaluate(() => window.__releasePreviewPreparation());
      // A new settled attachment proves the cancelled callback has passed its continuation.
      await page.locator("[data-file-input]").setInputFiles({ ...screenshot, name: "new.png" });
      await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
      assert.equal(await page.locator("[data-attachments] img[alt='screenshot.png']").count(), 0, boundary);
      assert.equal(await page.locator("[data-attachments] img[alt='new.png']").count(), 1, boundary);
      assert.equal((await bridgeCalls(page, "send-message")).length, 0);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("production pending preview and send guard belong only to their selected Stream", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await holdPreparation(page);
    await page.locator("[data-file-input]").setInputFiles(screenshot);
    const url = await previewUrl(page);
    await setSelectedTask(page, "stream-b");
    assert.equal(await page.locator("[data-attachment-preparing]").count(), 0);
    await page.locator("[data-composer-input]").fill("Independent Stream B");
    assert.equal(await page.locator("[data-composer-send]").isEnabled(), true);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "");
    assert.equal((await bridgeCalls(page, "send-message")).length, 1);
    await setSelectedTask(page, "stream-a");
    assert.equal(await previewUrl(page), url);
    await page.evaluate(() => window.__releasePreviewPreparation());
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 1);
  } finally { await browser.close(); }
});
