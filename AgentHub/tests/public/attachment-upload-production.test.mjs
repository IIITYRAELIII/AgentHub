import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { launchBrowser, openFixture, bridgeCalls, persistedRecovery } from "./composer-production.fixture.mjs";

const draftKey = "agent-hub:composer-drafts:v1:vscode";
async function attach(page, size = 2 * 1024 * 1024 + 7) {
  await page.locator("[data-composer-input]").fill("Resume exact attachment");
  await page.locator("[data-file-input]").setInputFiles({ name: "archive.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(size, 7) });
  await page.waitForFunction(() => document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1);
}
async function persisted(page) { return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]"), draftKey); }

test("production Blob draft reload resumes explicit upload and retains the exact rejected message identity", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  try {
    const diagnostics = await openFixture(page, { chunkedUpload: true });
    await attach(page, 21 * 1024 * 1024 + 7);
    const before = (await persisted(page))[0];
    assert.ok(before.attachments[0].blobId);
    assert.equal(before.attachments[0].dataUrl, undefined);
    assert.ok(JSON.stringify(before).length < 6000);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1);
    assert.equal((await persisted(page))[0].attachments[0].blobId, before.attachments[0].blobId);
    await page.evaluate(() => localStorage.setItem("fixture:upload-mode", "fail-once"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.locator("[data-upload-resume]").waitFor({ state: "visible" });
    assert.match(await page.title(), /Agent Hub/iu);
    assert.equal(new URL(page.url()).hostname, "agent-hub.test");
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "agent-hub-upload-desktop.png") });
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    await page.locator("[data-upload-resume]").click();
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Resume exact attachment");
    const first = (await bridgeCalls(page, "send-message"))[0];
    const restored = (await persisted(page))[0];
    assert.equal(restored.recoveryRequestId, first.params.clientUserMessageId);
    assert.equal(restored.attachments[0].uploadId, before.attachments[0].uploadId);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]").filter((entry) => entry.action === "send-message").length === 2);
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends[1].params.clientUserMessageId, first.params.clientUserMessageId);
    assert.equal(sends[1].params.attachments[0], first.params.attachments[0]);
    const uploads = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]"));
    assert.equal(uploads.filter((entry) => entry.method === "PUT").length, 22);
    assert.ok(uploads.filter((entry) => entry.method === "PUT").every((entry) => entry.size <= 1024 * 1024));
    assert.deepEqual(diagnostics.filter((message) => !message.includes("503")), []);
  } finally { await browser.close(); }
});

test("production cancel stops preparation and restores original durable Blob draft without message admission", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6000);
  try {
    await openFixture(page, { chunkedUpload: true });
    await page.evaluate(() => window.AgentHub.showSelectedTask());
    await attach(page);
    const original = (await persisted(page))[0].attachments[0];
    await page.evaluate(() => localStorage.setItem("fixture:upload-mode", "fail-once"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.locator("[data-upload-resume]").waitFor({ state: "visible" });
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "agent-hub-upload-mobile.png") });
    await page.locator("[data-upload-cancel]").click();
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Resume exact attachment");
    const draft = (await persisted(page))[0];
    assert.ok(draft.recoveryRequestId);
    assert.equal(draft.attachments[0].uploadId, original.uploadId);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(await page.locator("[data-upload-cancel]").count(), 0);
  } finally { await browser.close(); }
});

test("production unavailable Blob storage keeps memory draft and refuses a false durable recovery", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  try {
    await page.addInitScript(() => {
      const original = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, ...args) {
        if (name === "agent-hub-composer-files-v1") throw new DOMException("quota", "QuotaExceededError");
        return original.call(this, name, ...args);
      };
    });
    await openFixture(page, { chunkedUpload: true });
    await attach(page, 7);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    assert.equal((await persisted(page))[0].attachments.length, 0);
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Resume exact attachment");
    assert.equal((await persisted(page))[0].recoveryRequestId, undefined);
    assert.equal(await page.locator("[data-attachment-index]").count(), 1);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
  } finally { await browser.close(); }
});

test("production legacy upload completion after cancel cannot admit a message", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  try {
    await openFixture(page, { persistedDrafts: [persistedRecovery({
      requestId: "legacy-original-id", text: "Legacy cancellation",
      attachments: [{ name: "legacy.png", type: "image/png", size: 3, dataUrl: "data:image/png;base64,AQID" }],
    })] });
    await page.evaluate(() => localStorage.setItem("fixture:upload-mode", "hold"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => Boolean(window.__agentHubFixture.heldUpload));
    await page.locator("[data-upload-cancel]").click();
    await page.evaluate(() => window.__releaseHeldUpload());
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Legacy cancellation");
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal((await persisted(page))[0].recoveryRequestId, "legacy-original-id");
  } finally { await browser.close(); }
});
