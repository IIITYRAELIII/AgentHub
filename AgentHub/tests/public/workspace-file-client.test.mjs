import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = await readFile(process.env.AGENT_HUB_WORKSPACE_CLIENT_FILE
  ?? new URL("../../assets/web-app/hub-client.js", import.meta.url), "utf8");
const interactions = await readFile(new URL("../../assets/web-app/attachments/interactions.js", import.meta.url), "utf8");
// Execute the unchanged production functions and event handlers, not a second
// implementation of routing. Extraction is a VM seam, not a source-text oracle.
const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const functions = between("function remoteWorkspaceFileBridgeAvailable()", "const selectedTaskKey =")
  + between("async function saveLinkResource(", "agentHub.on(\"resource:open\"")
  + between("agentHub.on(\"resource:reveal\"", "agentHub.on(\"resource:copy\"")
  + between("agentHub.on(\"resource:copy-object\"", "window.AgentHubFileTransferOwner")
  + between("agentHub.on(\"resource:save\"", "agentHub.on(\"hub:restart\"");

function client({ paired = true, local = true, vscode = null, ready = Promise.resolve(), fetch } = {}) {
  const calls = [], downloads = [], blobs = [], bridges = [], handlers = new Map();
  const window = { location: { origin: "http://127.0.0.1:8787", href: "http://127.0.0.1:8787/" },
    AgentHubBrowserDevice: { isPaired: () => paired } };
  const document = { createElement: () => ({ click() { downloads.push({ href: this.href, name: this.download }); }, remove() {} }),
    body: { append() {} } };
  const context = { window, document, URL, String, Boolean, Error, Promise,
    localWorkspaceFilesAvailable: local, localSessionReady: ready, vscode,
    agentHub: { on: (name, handler) => handlers.set(name, handler), toast() {} },
    runAction: (action) => action(), authorizationHeaders: () => ({}),
    hubFetch: async (url, init) => { calls.push({ url, init }); return fetch(url, init); },
    saveBlob: async (blob, name) => blobs.push({ blob, name }), resourceFileName: (resource) => resource.name,
    bridgeCall: async (action, body) => bridges.push({ action, body }) };
  vm.runInNewContext(interactions, context);
  vm.runInNewContext(functions + ";window.saveLinkResource = saveLinkResource;", context);
  return { window, calls, downloads, blobs, bridges, save: window.saveLinkResource,
    action: (name, resource) => handlers.get(`resource:${name}`)({ resource }) };
}

const file = (name = "бит_Адаптация.cfe") => ({ kind: "link", localPath: `D:/Workspace/Просперити/Результат/${name}`, name });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("paired loopback without protected local proof downloads Cyrillic artifacts via existing tickets", async () => {
  let release;
  const c = client({ ready: new Promise((resolve) => { release = resolve; }), fetch: async (url, init) => {
    if (url === "/api/local-session") { assert.equal(init.method, "HEAD"); return new Response(null, { status: 401 }); }
    assert.equal(url, "/api/workspace-file/transfer-ticket");
    assert.match(JSON.parse(init.body).path, /Просперити\/Результат/u);
    return json({ ok: true, name: "готово.cfe", downloadPath: "/api/workspace-file/transfer/one-use" });
  } });
  const first = c.action("save", file());
  await Promise.resolve();
  assert.equal(c.calls.length, 0, "bootstrap must finish before capability selection");
  release();
  await first;
  for (const name of ["Отчет.epf", "README.md"]) await c.save(file(name));
  assert.equal(c.downloads.length, 3);
  assert.equal(c.blobs.length, 0);
  assert.equal(c.calls.filter((x) => x.url.startsWith("/api/workspace-file?")).length, 0);
  assert.ok(c.downloads.every((x) => x.href === "http://127.0.0.1:8787/api/workspace-file/transfer/one-use"));
});

test("protected local proof wins over paired-device capability and retains exact encoded path", async () => {
  const c = client({ fetch: async (url) => {
    if (url === "/api/local-session") return new Response(null, { status: 204 });
    assert.equal(url, `/api/workspace-file?path=${encodeURIComponent(file().localPath)}`);
    return new Response("synthetic extension");
  } });
  await c.save(file());
  assert.equal(c.blobs.length, 1);
  assert.equal(await c.blobs[0].blob.text(), "synthetic extension");
  assert.equal(c.downloads.length, 0);
  assert.equal(c.calls.length, 2);
});

test("remote paired download uses ticket; WebView uses its existing native bridge", async () => {
  const remote = client({ local: false, fetch: async (url) => {
    assert.equal(url, "/api/workspace-file/transfer-ticket");
    return json({ ok: true, downloadPath: "/api/workspace-file/transfer/remote" });
  } });
  await remote.save(file());
  assert.equal(remote.downloads.length, 1);
  const webview = client({ vscode: {}, fetch: () => assert.fail("WebView must not use HTTP file authority") });
  await webview.save(file());
  assert.equal(webview.bridges[0].action, "save-link");
});

test("unknown session failures and file denial never turn into a ticket retry", async () => {
  const offline = new Error("network down");
  const c = client({ fetch: async () => { throw offline; } });
  await assert.rejects(c.save(file()), (error) => error === offline);
  assert.equal(c.calls.length, 1);
  for (const status of [403, 404]) {
    const denied = client({ fetch: async (url) => url === "/api/local-session"
      ? new Response(null, { status: 204 }) : json({ error: "file rejected" }, status) });
    await assert.rejects(denied.save(file()), /file rejected/u);
    assert.equal(denied.calls.length, 2);
    assert.equal(denied.downloads.length, 0);
  }
  const unknown = client({ fetch: async () => new Response(null, { status: 503 }) });
  await assert.rejects(unknown.save(file()), /503/u);
  assert.equal(unknown.calls.length, 1);
  const unpaired = client({ paired: false, fetch: async () => new Response(null, { status: 401 }) });
  await assert.rejects(unpaired.save(file()), /сопряги/u);
  assert.equal(unpaired.calls.length, 1);
});

test("loopback reveal bridge fallback works only on runtime unavailability; local copy keeps priority", async () => {
  const c = client({ fetch: async (url) => {
    if (url.endsWith("/reveal")) return json({ code: "workspace-file-reveal-unavailable", error: "unavailable" }, 503);
    assert.equal(url, "/api/workspace-file/transfer-ticket");
    return json({ ok: true, downloadPath: "/api/workspace-file/transfer/reveal", name: "test.cfe" });
  } });
  await c.action("reveal", file());
  assert.match(c.downloads[0].href, /^agenthub-file:\/\/reveal/u);
  const denied = client({ fetch: async () => json({ code: "workspace-file-reveal-failed", error: "wrong root" }, 400) });
  await assert.rejects(denied.action("reveal", file()), /wrong root/u);
  assert.equal(denied.calls.length, 1);
  const local = client({ fetch: async (url) => url === "/api/local-session"
    ? new Response(null, { status: 204 }) : json({ ok: true }) });
  await local.action("copy-object", file());
  assert.deepEqual(local.calls.map((x) => x.url), ["/api/local-session", "/api/workspace-file/copy"]);
  assert.equal(local.downloads.length, 0);
});

test("native browser click downloads paired loopback artifacts through the real HTTP owner", async () => {
  const { chromium } = await import("playwright");
  const { MiniAppServer } = await import(process.env.AGENT_HUB_WORKSPACE_SERVER_FILE
    ? pathToFileURL(process.env.AGENT_HUB_WORKSPACE_SERVER_FILE).href
    : new URL("../../src/interfaces/web/mini-app-server.mjs", import.meta.url).href);
  const root = await mkdtemp(path.join(os.tmpdir(), "hub412-click-"));
  const files = path.join(root, "Просперити", "Результат");
  await mkdir(files, { recursive: true });
  const names = ["бит_Адаптация.cfe", "Отчет.epf", "README.md"];
  for (const name of names) await writeFile(path.join(files, name), `synthetic:${name}`);
  const token = "d".repeat(43), secret = "l".repeat(43);
  const server = new MiniAppServer({ port: 0, localAccessSecret: secret, workspaceFileRoots: [files],
    journalDatabase: { subscribe: () => () => {} },
    deviceStore: { resolveSession: async (value) => {
      assert.equal(value, token); return { id: "fixture", deviceId: "fixture-device" };
    } } });
  let browser;
  try {
    const address = await server.start();
    browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true });
    const context = await browser.newContext();
    await context.addCookies([{ name: "agent_hub_device", value: token, url: address.url }]);
    const page = await context.newPage();
    await page.route(address.url, (route) => route.fulfill({ contentType: "text/html", body: '<button id="save">Download</button>' }));
    await page.goto(address.url);
    await page.addScriptTag({ content: interactions });
    await page.addScriptTag({ content: `(() => {
      const localWorkspaceFilesAvailable = true, localSessionReady = Promise.resolve(), vscode = null;
      window.AgentHubBrowserDevice = { isPaired: () => true };
      const handlers = new Map();
      const agentHub = { on: (name, handler) => handlers.set(name, handler), toast() {} };
      const hubFetch = (url, init) => fetch(url, init), authorizationHeaders = () => ({});
      const runAction = (action) => action(), resourceFileName = (resource) => resource.name;
      const saveBlob = () => { throw new Error("device-only browser used the local file endpoint"); };
      ${functions}
      document.querySelector("#save").onclick = () => {
        window.clickOutcome = handlers.get("resource:save")({ resource: window.fixtureResource });
      };
    })();` });
    for (const name of names) {
      await page.evaluate((resource) => { window.fixtureResource = resource; }, { kind: "link", localPath: path.join(files, name), name });
      const downloadPromise = page.waitForEvent("download");
      await page.click("#save");
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), name);
      const chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), `synthetic:${name}`);
      await page.evaluate(() => window.clickOutcome);
    }
    // A real protected cookie coexisting with the device proof keeps its local
    // authority. Reload confirms that no URL fragment is required afterwards.
    await context.request.post(`${address.url}api/local-session`, {
      headers: { Authorization: `local ${secret}`, "Content-Type": "application/json" }, data: "{}",
    }).then((response) => assert.equal(response.status(), 200));
    await page.reload();
    const local = await page.evaluate(async (target) => ({
      session: (await fetch("/api/local-session", { method: "HEAD" })).status,
      file: (await fetch(`/api/workspace-file?path=${encodeURIComponent(target)}`)).status,
    }), path.join(files, names[0]));
    assert.deepEqual(local, { session: 204, file: 200 });
  } finally {
    await browser?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
