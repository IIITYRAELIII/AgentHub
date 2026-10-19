import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

// Transport feasibility only: this disposable server owns no production capability.
for (const channel of ["msedge", "chrome"]) for (const behavior of ["default", "allowAndName"]) {
  test(`${channel}/${behavior}: native attachment resume bypasses the scoped service worker and is denied`, { timeout: 90_000 }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hub-transfer-browser-"));
    const evidence = await mkdtemp(path.join(os.tmpdir(), `hub112-${channel}-${behavior}-evidence-`));
    t.diagnostic(`evidence: ${evidence}`);
    const requests = [];
    const rangeProbes = [];
    const block = Buffer.alloc(64 * 1024, 0x5a);
    const size = 700 * 1024 ** 2;
    const fixtureHasher = createHash("sha256");
    for (let offset = 0; offset < size; offset += block.length) fixtureHasher.update(block.subarray(0, Math.min(block.length, size - offset)));
    const fixtureSha256 = fixtureHasher.digest("hex");
    let cut = true;
    const certFile = path.join(directory, "localhost.crt");
    const keyFile = path.join(directory, "localhost.key");
    const opensslConfig = path.join(directory, "openssl.cnf");
    await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-config", opensslConfig,
      "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1"], { windowsHide: true, maxBuffer: 64 * 1024 });
    const certificate = await readFile(certFile);
    const spki = createHash("sha256").update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" })).digest("base64");
    const server = createServer({ key: await readFile(keyFile), cert: certificate }, async (req, res) => {
      res.setHeader("Cache-Control", "no-store, no-transform");
      if (req.url === "/transfer/worker.js") {
        res.setHeader("Content-Type", "application/javascript");
        res.end(`self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname!=='/transfer/file')return;
const h=new Headers(e.request.headers);h.set('X-Transfer-Spike','signed');
h.set('X-Transfer-Spike-Context',JSON.stringify({client:e.clientId?'present':'empty',resultingClient:e.resultingClientId?'present':'empty',mode:e.request.mode,destination:e.request.destination}));
e.respondWith(fetch(new Request(e.request,{headers:h})));});`);
      } else if (req.url === "/transfer/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<a href="/transfer/file">Download</a><script>
navigator.serviceWorker.register('/transfer/worker.js',{scope:'/transfer/'}).then(()=>navigator.serviceWorker.ready).then(async()=>{
if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));
document.body.dataset.ready='1';});</script>`);
      } else if (req.url === "/transfer/file") {
        const range = String(req.headers.range ?? "");
        const start = Number(/^bytes=(\d+)-/u.exec(range)?.[1] ?? 0);
        const receipt = { method: req.method, range, ifRange: req.headers["if-range"] ?? "", signed: req.headers["x-transfer-spike"] === "signed",
          path: req.url, rawHeaders: req.rawHeaders.filter((_, index, values) => /^(host|range|if-range|x-transfer-spike|x-transfer-spike-context|accept-encoding)$/iu.test(values[index - index % 2])),
          context: req.headers["x-transfer-spike-context"] ?? null, denied: req.headers["x-transfer-spike"] !== "signed", emittedBytes: 0 };
        if (req.headers["x-transfer-spike-probe"] !== "1") requests.push(receipt);
        if (req.headers["x-transfer-spike"] !== "signed") { receipt.status = 403; res.writeHead(403); res.end(); return; }
        const headers = { "Content-Disposition": 'attachment; filename="transfer-spike.bin"',
          "Content-Type": "application/octet-stream", "Content-Length": size - start, "Accept-Ranges": "bytes",
          ETag: `"${fixtureSha256}"`, ...(range ? { "Content-Range": `bytes ${start}-${size - 1}/${size}` } : {}) };
        receipt.status = range ? 206 : 200; receipt.headers = headers;
        res.writeHead(receipt.status, headers);
        for (let offset = start; offset < size; offset += block.length) {
          if (cut && !range && offset >= 4 * 1024 ** 2) { cut = false; res.destroy(); break; }
          if (res.destroyed) break;
          const output = block.subarray(0, Math.min(block.length, size - offset));
          receipt.emittedBytes += output.length;
          if (!res.write(output)) {
            await new Promise((resolve) => {
              const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
              res.once("drain", done); res.once("close", done);
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        if (!res.destroyed) res.end();
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let context;
    let browserVersion;
    let launchFlags = "";
    try {
      await mkdir(path.join(directory, "profile", "Default"), { recursive: true });
      await writeFile(path.join(directory, "profile", "Default", "Preferences"), JSON.stringify({
        download: { default_directory: directory, prompt_for_download: false, directory_upgrade: true },
      }));
      try {
        context = await chromium.launchPersistentContext(path.join(directory, "profile"), {
          channel, headless: true, downloadsPath: directory, acceptDownloads: true,
          viewport: { width: 1280, height: 720 },
          ignoreHTTPSErrors: true, args: [`--ignore-certificate-errors-spki-list=${spki}`],
        });
      } catch (error) {
        // Edge is the documented required Windows browser. Chrome is an
        // additional feasibility matrix, not an installed Hub dependency.
        // Only the explicit missing-distribution result is unavailable coverage;
        // all other launch failures and all behavior assertions still fail.
        if (channel === "chrome" && String(error?.message ?? "").includes("Chromium distribution 'chrome' is not found at")) {
          t.skip("Optional Chrome channel is not installed/discoverable in this isolated run; no Chrome resume proof. Required Edge cases remain enabled.");
          return;
        }
        throw error;
      }
      const probe = await context.request.get(`https://127.0.0.1:${server.address().port}/transfer/file`, {
        headers: { Range: `bytes=${size - 1}-`, "X-Transfer-Spike": "signed", "X-Transfer-Spike-Probe": "1" },
      });
      const lastByte = await probe.body();
      assert.equal(probe.status(), 206);
      assert.equal(probe.headers()["content-range"], `bytes ${size - 1}-${size - 1}/${size}`);
      assert.equal(lastByte.length, 1); assert.equal(lastByte[0], 0x5a);
      rangeProbes.push({ range: `bytes=${size - 1}-`, status: probe.status(), headers: probe.headers(),
        bodyBytes: lastByte.length, bodySha256: createHash("sha256").update(lastByte).digest("hex") });
      browserVersion = context.browser()?.version();
      t.diagnostic(`browser ${channel}: ${browserVersion}`);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const versionPage = await context.newPage();
      await versionPage.goto(channel === "msedge" ? "edge://version/" : "chrome://version/");
      launchFlags = (await versionPage.locator("#command_line").textContent()).replaceAll(directory, "<disposable-profile-root>");
      await versionPage.close();
      await cdp.send("Browser.setDownloadBehavior", { behavior, ...(behavior === "default" ? {} : { downloadPath: directory }), eventsEnabled: true });
      await page.goto(`https://127.0.0.1:${server.address().port}/transfer/`);
      await page.waitForFunction(() => document.body.dataset.ready === "1");
      const downloading = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download", exact: true }).click();
      const download = await downloading;
      const failure = await download.failure();
      t.diagnostic(`interrupted initial download: ${failure}`);
      assert.equal(requests[0]?.signed, true, "initial native download must traverse worker");
      assert.ok(failure, "fixture must interrupt download");
      const manager = await context.newPage();
      await manager.goto(channel === "msedge" ? "edge://downloads/all" : "chrome://downloads/");
      t.diagnostic(`download-manager text: ${(await manager.locator('body').innerText()).slice(0, 1800)}`);
      const resume = manager.getByRole("button", { name: /resume|возобнов|продолж/iu }).first();
      let resumedByCoordinates = false;
      try { await resume.waitFor({ state: "visible", timeout: 3_000 }); }
      catch (error) {
        await manager.screenshot({ path: path.join(evidence, "manager-before-resume.png") });
        if (channel === "msedge") {
          // Edge's manager uses closed shadow roots. This control was inspected
          // in the fixed 1280x720 screenshot produced by the preceding run.
          await manager.mouse.click(1095, 197);
          resumedByCoordinates = true;
        } else {
          await manager.mouse.click(908, 149);
          await manager.screenshot({ path: path.join(evidence, "manager-menu.png") });
          await manager.getByRole("menuitem", { name: /resume|возобнов/iu }).click({ timeout: 5_000 });
          resumedByCoordinates = true;
        }
      }
      if (!resumedByCoordinates) await resume.click();
      const deadline = Date.now() + 15_000;
      while (requests.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      t.diagnostic(`request evidence: ${JSON.stringify(requests)}`);
      assert.ok(requests.length >= 2, "native Resume must request bytes again");
      assert.equal(requests[1].signed, false, "native Resume must not be mistaken for a PoP-authenticated request");
      assert.equal(requests[1].denied, true);
      assert.equal(requests[1].status, 403);
      assert.equal(requests[1].emittedBytes, 0, "unsigned native Resume must receive zero file bytes");
    } finally {
      await context?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const harnessHash = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
      await writeFile(path.join(evidence, "harness.mjs"), await readFile(new URL(import.meta.url)));
      await writeFile(path.join(evidence, "localhost.crt"), certificate);
      await writeFile(path.join(evidence, "result.json"), JSON.stringify({
        browser: channel, browserVersion, headless: true, transport: "localhost HTTPS with disposable self-signed certificate (not public TLS/reachability evidence)",
        certificateSha256: createHash("sha256").update(certificate).digest("hex"),
        launchFlags,
        downloadBehavior: { behavior, eventsEnabled: true, isolatedPreferencesDirectory: true },
        fixture: { size, expectedSha256: fixtureSha256, blockBytes: block.length, fillByte: 0x5a, forcedDisconnectAt: 4 * 1024 ** 2, delayPerBlockMs: 2,
          completeTransferVerified: false },
        markerIsAuthentication: false, markerDescription: "diagnostic of SW interception only, not a production proof",
        harnessHash, requests, rangeProbes,
        conclusion: requests.length >= 2 && !requests[1].signed ? "resume bypassed SW; denied before bytes" : "inspect trace",
      }, null, 2));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
