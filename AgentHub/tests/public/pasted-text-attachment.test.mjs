import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { launchBrowser, openFixture, bridgeCalls, submit } from "./composer-production.fixture.mjs";

const app = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");
const policyStart = app.indexOf("const PASTED_TEXT_ATTACHMENT_THRESHOLD");
const policyEnd = app.indexOf("function pastedTextFile", policyStart);
assert.ok(policyStart >= 0 && policyEnd > policyStart, "paste policy must be present in app.js");

const context = { DRAFT_STORAGE_MAX_TEXT: 100_000 };
vm.runInNewContext(app.slice(policyStart, policyEnd), context);

test("large pasted text becomes an attachment before the message limit", () => {
  assert.equal(context.pastedTextShouldBeAttachment("x".repeat(7_999)), false);
  assert.equal(context.pastedTextShouldBeAttachment("x".repeat(8_000)), true);
  assert.equal(context.pastedTextShouldBeAttachment("x".repeat(2_000), "", 99_000), true);
});

test("pasted spreadsheet and Markdown tables become text attachments", () => {
  assert.equal(context.pastedTextShouldBeAttachment("A\tB\n1\t2"), true);
  assert.equal(context.pastedTextShouldBeAttachment("A | B\n--- | ---\n1 | 2"), true);
  assert.equal(context.pastedTextShouldBeAttachment("A B", "<table><tr><td>A</td></tr></table>"), true);
  assert.equal(context.pastedTextShouldBeAttachment("Короткий обычный текст"), false);
});

test("composer paste creates the standard pasted-text file card", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.setDefaultTimeout(8_000);
    const uploaded = [];
    const failed = [];
    page.on("response", (response) => { if (response.status() >= 400) failed.push(response.url()); });
    page.on("request", (request) => {
      if (request.method() === "PUT") {
        uploaded.push(request.postDataBuffer());
      }
    });
    const diagnostics = await openFixture(page, { chunkedUpload: true });
    const paste = (text, html = "") => page.locator("[data-composer-input]").evaluate((element, value) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", value.text);
      clipboardData.setData("text/html", value.html);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    }, { text, html });
    const text = "Таблица 😀\n".repeat(900);
    await paste(text);
    await page.getByText("Вставленный текст.txt", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
    assert.deepEqual(await bridgeCalls(page, "send-message"), []);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await submit(page);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]").some((entry) => entry.method === "PUT"));
    const uploads = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log")));
    assert.equal(uploads.find((entry) => entry.method === "PUT").value.name, "Вставленный текст.txt");
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].toString("utf8"), text);
    await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => entry.action === "send-message"));
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].params.attachments.length, 1);
    assert.ok(sends[0].params.attachments[0].endsWith("Вставленный текст.txt"));
    assert.deepEqual(diagnostics, [], JSON.stringify(failed));
  } finally { await browser.close(); }
});
