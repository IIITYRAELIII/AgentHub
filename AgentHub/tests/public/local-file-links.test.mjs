import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { launchBrowser, snapshot } from "./composer-production.fixture.mjs";

const journal = () => ({ subscribe: () => () => {}, version: "local-files", html: () => "" });

test("local file APIs retain authentication and file errors without configured roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-local-file-api-"));
  const target = path.join(root, "Отчёт вне проекта.txt");
  const bytes = Buffer.from("local file outside Workspace\n");
  await writeFile(target, bytes);
  const effects = [];
  const secret = "f".repeat(43);
  const server = new MiniAppServer({ port: 0, journalDatabase: journal(), localAccessSecret: secret,
    copyWorkspaceFile: async file => effects.push(["copy", file]),
    revealWorkspaceFile: async file => effects.push(["reveal", file]) });
  try {
    const { url } = await server.start();
    const direct = file => `${url}api/workspace-file?path=${encodeURIComponent(file)}`;
    assert.equal((await fetch(direct(target))).status, 401);
    const session = await fetch(`${url}api/local-session`, { method: "POST",
      headers: { Authorization: `local ${secret}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(session.status, 200);
    const headers = { Cookie: session.headers.get("set-cookie").split(";", 1)[0] };
    const file = await fetch(direct(`${target}:12:3`), { headers });
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    assert.equal((await fetch(direct(target), { method: "HEAD", headers })).headers.get("content-length"), String(bytes.length));
    for (const action of ["copy", "reveal"]) {
      const response = await fetch(`${url}api/workspace-file/${action}`, { method: "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ path: target }) });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(effects, [["copy", await realpath(target)], ["reveal", await realpath(target)]]);
    for (const invalid of [path.join(root, "missing.txt"), root, "bad\0path", ""]) {
      const response = await fetch(direct(invalid), { headers });
      assert.equal(response.status, 404);
      assert.ok((await response.json()).error);
    }
    // Trusted-device identity still grants the existing ticket/reveal mode,
    // not direct local-browser access. Missing/invalid credentials stay refused.
    assert.equal((await fetch(`${url}api/workspace-file/transfer-ticket`, { method: "POST",
      headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ path: target }) })).status, 403);
    assert.equal(effects.length, 2);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("real Edge file-link menu downloads and reveals inside and outside files through the HTTP owner", { timeout: 40_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-local-file-ui-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const targets = [path.join(workspace, "inside.txt"), path.join(root, "Камень вне проекта.png")];
  const bodies = [Buffer.from("inside Workspace\n"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=", "base64")];
  await Promise.all(targets.map((file, index) => writeFile(file, bodies[index])));
  const revealed = [], copied = [], calls = [], errors = [];
  const initial = snapshot();
  initial.tasks[0].projectRoot = workspace;
  initial.tasks[0].sessionCwd = workspace;
  const history = { provider: "codex", threadId: "thread-a", streamId: "stream-a",
    items: [{ id: "file-links-turn", completed: true, status: "completed", terminalRevision: 1,
      answer: targets.map((file, index) => `[file-${index}](<${file.replaceAll("\\", "/")}>)`).join("\n\n") }],
    start: 0, end: 1, total: 1, messageTotal: 1, nextBefore: null, version: "file-links" };
  const secret = "b".repeat(43);
  const server = new MiniAppServer({ port: 0, journalDatabase: journal(), localAccessSecret: secret,
    // A deliberately narrower legacy input cannot restrict local file links.
    workspaceFileRoots: [workspace],
    revealWorkspaceFile: async file => revealed.push(file), copyWorkspaceFile: async file => copied.push(file),
    controlHandler: async ({ action }) => {
      calls.push(action);
      if (action === "task-history") return history;
      if (action === "open-task") return { history, snapshot: initial };
      if (action === "runtime-health") return { ok: true, ready: true };
      return initial;
    } });
  let browser;
  try {
    const { url } = await server.start();
    browser = await launchBrowser();
    const context = await browser.newContext({ acceptDownloads: true });
    const session = await context.request.post(`${url}api/local-session`, {
      headers: { Authorization: `local ${secret}` }, data: {} });
    assert.equal(session.status(), 200);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    // Only the optional external Telegram SDK is isolated; all Hub HTML,
    // client assets, auth, file routes and bytes come from the actual server.
    await page.route("https://telegram.org/**", route => route.fulfill({ body: "" }));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.AgentHub?.setMessages));
    await page.waitForFunction(() => Boolean(document.querySelector('[data-stream-task-id="stream-a"]')));
    await page.evaluate(() => window.AgentHub.selectTask("stream-a"));
    await page.waitForFunction(() => document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "stream-a");
    // Render the links from the authoritative HTTP history response. A later
    // normal history refresh must retain them, not erase a manual DOM injection.
    await page.getByRole("link", { name: "file-0", exact: true }).waitFor();
    for (let index = 0; index < targets.length; index += 1) {
      const link = page.getByRole("link", { name: `file-${index}`, exact: true });
      await link.click();
      const downloading = page.waitForEvent("download");
      await page.locator('[data-resource-action="save"]').click();
      const download = await downloading;
      assert.equal(download.suggestedFilename(), path.basename(targets[index]));
      assert.deepEqual(await readFile(await download.path()), bodies[index]);
      await link.click();
      const revealing = page.waitForResponse(response => response.url().endsWith("/api/workspace-file/reveal"));
      await page.locator('[data-resource-action="reveal"]').click();
      assert.equal((await revealing).status(), 200);
      // Await the actual HTTP response rather than a cosmetic UI timer.
      await link.click();
      const copying = page.waitForResponse(response => response.url().endsWith("/api/workspace-file/copy"));
      await page.locator('[data-resource-action="copy-object"]').click();
      assert.equal((await copying).status(), 200);
    }
    assert.deepEqual(revealed, await Promise.all(targets.map(file => realpath(file))));
    assert.deepEqual(copied, revealed);
    assert.ok(calls.includes("snapshot"));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("Android file-link save uses the HttpOnly device session and delivers the exact PNG to the existing save port", { timeout: 40_000 }, async () => {
  const { webcrypto } = await import("node:crypto");
  const { deviceSessionMessage, TrustedDeviceStore } = await import("../../src/infrastructure/persistence/trusted-device-store.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-android-file-ui-"));
  const target = path.join(root, "Камень вне проекта.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=", "base64");
  let now = Date.now();
  const deviceStore = new TrustedDeviceStore({ filePath: path.join(root, "devices.json"), now: () => now });
  const initial = snapshot();
  const history = { provider: "codex", threadId: "thread-a", streamId: "stream-a",
    items: [{ id: "file-link-turn", completed: true, status: "completed", terminalRevision: 1,
      answer: `[PNG](<${target.replaceAll("\\", "/")}>)` }],
    start: 0, end: 1, total: 1, messageTotal: 1, nextBefore: null, version: "android-file-link" };
  const server = new MiniAppServer({ port: 0, journalDatabase: journal(), deviceStore, localAccessSecret: "m".repeat(43),
    controlHandler: async ({ action }) => {
      if (action === "task-history") return history;
      if (action === "open-task") return { history, snapshot: initial };
      if (action === "runtime-health") return { ok: true, ready: true };
      return initial;
    } });
  let browser;
  try {
    await writeFile(target, png);
    await deviceStore.load();
    const { url } = await server.start();
    const origin = new URL(url).origin;
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pairing = await deviceStore.createPairing("42");
    const { device } = await deviceStore.pair({ code: pairing.code, name: "Fixture phone", platform: "Android",
      publicKey: Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url") });
    const challenge = await deviceStore.createChallenge({ deviceId: device.id, origin });
    const message = deviceSessionMessage({ ...challenge, origin, deviceId: device.id });
    const signature = Buffer.from(await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, keys.privateKey, Buffer.from(message),
    )).toString("base64url");
    const session = await deviceStore.createSession({ deviceId: device.id, challengeId: challenge.challengeId, signature });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    // Model Android's existing injection points; all HTML, API requests,
    // session resolution, ticket consumption and file bytes are real.
    await context.addCookies([{ name: "agent_hub_device", value: session.token, url, httpOnly: true, secure: true, sameSite: "Strict" }]);
    const saved = [], responses = [];
    await context.exposeBinding("recordAndroidSave", (_source, name, data) => {
      const comma = data.indexOf(",");
      saved.push({ name, media: data.slice(0, comma), bytes: Buffer.from(data.slice(comma + 1), "base64") });
    });
    await context.addInitScript(deviceId => {
      window.AgentHubAndroid = {
        getDeviceId: () => deviceId,
        saveDataUrl: (name, data) => {
          void window.recordAndroidSave(name, data).then(() => { window.androidSaveCompleted = true; });
        },
      };
    }, device.id);
    const page = await context.newPage();
    page.on("response", response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith("/api/workspace-file")) {
        responses.push({ pathname, method: response.request().method(), status: response.status() });
      }
    });
    await page.route("https://telegram.org/**", route => route.fulfill({ body: "" }));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(document.querySelector('[data-stream-task-id="stream-a"]')));
    await page.evaluate(() => window.AgentHub.selectTask("stream-a"));
    const link = page.getByRole("link", { name: "PNG", exact: true });
    assert.deepEqual(await page.evaluate(() => ({
      scriptSeesCookie: document.cookie.includes("agent_hub_device"),
      browserPaired: Boolean(window.AgentHubBrowserDevice?.isPaired()),
    })), { scriptSeesCookie: false, browserPaired: false });

    const save = async () => {
      await link.click({ button: "right" });
      await page.locator('[data-resource-action="save"]').click();
    };
    await save();
    // Published RED fails here with the actual wrong "сначала сопряги"
    // message and zero HTTP requests. On success wait for the native port.
    await page.waitForFunction(() => document.querySelector("[data-toast]")?.textContent.includes("сначала сопряги")
      || window.androidSaveCompleted === true, null, { timeout: 5000 });
    const toast = page.locator("[data-toast]");
    assert.doesNotMatch(await toast.textContent(), /сначала сопряги/u);
    assert.deepEqual(saved, [{ name: path.basename(target), media: "data:image/png;base64", bytes: png }], await toast.textContent());
    assert.deepEqual(responses.map(({ method, status }) => [method, status]), [["POST", 200], ["GET", 200]]);
    const replay = await context.request.get(new URL(responses[1].pathname, url).href);
    assert.equal(replay.status(), 404);

    now = session.expiresAt + 1;
    for (const status of [403, 401]) {
      if (status === 401) await context.clearCookies({ name: "agent_hub_device" });
      const denied = page.waitForResponse(response => response.url().endsWith("/api/workspace-file/transfer-ticket"));
      await save();
      assert.equal((await denied).status(), status);
      assert.equal(saved.length, 1);
    }
    assert.deepEqual(responses.map(({ method, status }) => [method, status]), [
      ["POST", 200], ["GET", 200], ["POST", 403], ["POST", 401],
    ]);
  } finally { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
