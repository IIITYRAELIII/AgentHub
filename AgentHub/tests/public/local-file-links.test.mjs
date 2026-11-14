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
  const history = { provider: "codex", threadId: "thread-a", streamId: "stream-a", items: [],
    start: 0, end: 0, total: 0, messageTotal: 0, nextBefore: null, version: "empty" };
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
    await page.evaluate(({ targets }) => {
      window.AgentHub.setMessages("stream-a", [{ id: "file-links", role: "assistant", provider: "codex",
        threadId: "thread-a", text: targets.map((target, index) => `[file-${index}](<${target}>)`).join("\n\n") }]);
    }, { targets: targets.map(file => file.replaceAll("\\", "/")) });
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
