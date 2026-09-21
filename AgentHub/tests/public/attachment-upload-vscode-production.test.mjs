import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AgentHubBridge } from "../../VSCodeExtension/agent-hub-bridge.js";
import { DesktopAttachmentService } from "../../src/interfaces/desktop/desktop-attachment-service.mjs";
import { launchBrowser, openFixture, bridgeCalls } from "./composer-production.fixture.mjs";

test("VS Code composer uploads with web components disabled through the runtime attachment owner", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-ipc-upload-"));
  const service = new DesktopAttachmentService({ runtimeCommandRoot: root, projectRoot: root });
  const bridge = new AgentHubBridge({ runtimeRoot: root });
  const requests = [];
  bridge.desktopControl = async (action, params) => {
    assert.equal(action, "attachment-upload");
    requests.push({ method: params.method, path: params.path, size: params.body?.length ?? 0 });
    return service.upload(params, { source: "desktop-control" });
  };
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(6000);
    const diagnostics = await openFixture(page, { chunkedUpload: true });
    await page.exposeFunction("__uploadIpc", (message) => bridge.http(message));
    // The HTTP fixture lacks secure-context WebCrypto; use real SHA-256 for
    // this cross-surface test instead of its lightweight UI-only hash stub.
    await page.exposeFunction("__uploadSha256", (bytes) => [...createHash("sha256").update(Buffer.from(bytes, "base64")).digest()]);
    await page.evaluate(() => {
      crypto.subtle.digest = async (_algorithm, value) => {
        const bytes = new Uint8Array(value);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return new Uint8Array(await window.__uploadSha256(btoa(binary))).buffer;
      };
      const existing = window.__agentHubVscode;
      window.acquireVsCodeApi = () => ({ postMessage(message) {
        if (message.type === "agenthub:session") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: {
            type: "agenthub:session-result", id: message.id, ok: false, error: "Web App disabled",
          } })), 0);
        } else if (message.type === "agenthub:http" && message.path.startsWith("/api/attachment-upload")) {
          window.__uploadIpc(message).then((result) => window.dispatchEvent(new MessageEvent("message", {
            data: { type: "agenthub:http-result", id: message.id, ...result },
          })));
        } else existing.postMessage(message);
      } });
      const native = window.fetch;
      window.fetch = (input, init) => {
        if (String(input).includes("/api/attachment-upload")) throw new Error("HTTP upload disabled");
        return native(input, init);
      };
      localStorage.setItem("fixture:send-mode", "accept");
    });
    await page.addScriptTag({ path: fileURLToPath(new URL("../../VSCodeExtension/vscode-bootstrap.js", import.meta.url)) });
    assert.equal(await page.evaluate(() => window.__agentHubDirectTransport.available()), false);
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 137);
    await page.locator("[data-composer-input]").fill("Upload through local VS Code");
    await page.locator("[data-file-input]").setInputFiles({ name: "archive.bin", mimeType: "application/octet-stream", buffer: bytes });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 1);
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    try {
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]").some((entry) => entry.action === "send-message"));
    } catch (error) {
      throw new Error(`${error.message}; requests=${JSON.stringify(requests)}; diagnostics=${JSON.stringify(diagnostics)}; toast=${await page.locator("[data-toast]").textContent()}`);
    }
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends.length, 1);
    assert.deepEqual(await readFile(sends[0].params.attachments[0]), bytes);
    assert.equal(requests.filter((entry) => entry.method === "PUT").length, 3);
    assert.ok(requests.every((entry) => entry.size <= 4 * Math.ceil(1024 * 1024 / 3)));
    assert.match(await page.title(), /Agent Hub/iu);
    assert.equal(new URL(page.url()).hostname, "agent-hub.test");
    assert.deepEqual(diagnostics, []);
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "vscode-upload-fixed.png") });
  } finally {
    await browser.close();
    bridge.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
