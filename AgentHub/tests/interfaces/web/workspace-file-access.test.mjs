import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { MiniAppServer } = await import(process.env.AGENT_HUB_WORKSPACE_SERVER_FILE
  ? pathToFileURL(process.env.AGENT_HUB_WORKSPACE_SERVER_FILE).href
  : new URL("../../../src/interfaces/web/mini-app-server.mjs", import.meta.url).href);
const { createLocalWebviewSession } = await import("../../../src/interfaces/web/local-webview-session.mjs");

test("workspace file HTTP keeps protected-local priority, device tickets and path/forwarding guards", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub412-http-"));
  const files = path.join(root, "Файлы");
  await mkdir(files);
  const target = path.join(files, "Расширение.cfe"), outside = path.join(root, "outside.epf");
  await writeFile(target, "synthetic extension"); await writeFile(outside, "outside");
  const secret = "s".repeat(43), device = { Authorization: "device fixture-device-session" };
  const server = new MiniAppServer({ port: 0, localAccessSecret: secret, workspaceFileRoots: [files],
    journalDatabase: { subscribe: () => () => {} },
    deviceStore: { resolveSession: async () => ({ id: "fixture", deviceId: "fixture-device" }) } });
  try {
    const { url } = await server.start();
    const direct = `${url}api/workspace-file?path=${encodeURIComponent(target)}`;
    assert.equal((await fetch(direct, { headers: device })).status, 403);
    assert.equal((await fetch(`${url}api/local-session`, { method: "HEAD", headers: device })).status, 401);
    const ticketFor = (targetPath, headers = device) => fetch(`${url}api/workspace-file/transfer-ticket`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ path: targetPath }),
    });
    const ticket = await (await ticketFor(target)).json();
    assert.equal(ticket.ok, true);
    assert.equal(await (await fetch(new URL(ticket.downloadPath, url))).text(), "synthetic extension");
    assert.equal((await fetch(new URL(ticket.downloadPath, url))).status, 404);
    for (const bad of [outside, path.join(files, "missing.epf")]) {
      assert.equal((await ticketFor(bad)).status, 400);
    }
    const post = await fetch(`${url}api/local-session`, { method: "POST",
      headers: { Authorization: `local ${secret}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(post.status, 200);
    const cookie = post.headers.get("set-cookie").split(";", 1)[0];
    const protectedHeaders = { ...device, Cookie: cookie };
    assert.equal((await fetch(`${url}api/local-session`, { method: "HEAD", headers: protectedHeaders })).status, 204);
    assert.equal((await fetch(direct, { headers: protectedHeaders })).status, 200);
    assert.equal((await fetch(direct, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${url}api/workspace-file?path=${encodeURIComponent(outside)}`, { headers: { Cookie: cookie } })).status, 404);
    // A forwarded device still has exactly device authority; cookie/hostname do
    // not become a local-only proof when the request is forwarded.
    const forwarded = { ...protectedHeaders, "X-Forwarded-For": "203.0.113.5", "X-Forwarded-Proto": "https" };
    assert.equal((await fetch(direct, { headers: forwarded })).status, 403);
    assert.equal((await ticketFor(target, forwarded)).status, 200);
    const webview = { Authorization: `webview ${createLocalWebviewSession(secret).token}` };
    assert.equal((await fetch(direct, { headers: webview })).status, 403);
    assert.equal((await fetch(direct)).status, 401);
    assert.equal((await fetch(`${url}api/local-session`, { method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.5", Authorization: `local ${secret}`, "Content-Type": "application/json" }, body: "{}" })).status, 404);
    assert.equal((await fetch(`${url}api/local-session`, { method: "POST",
      headers: { Authorization: "local invalid-proof", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal(await readFile(outside, "utf8"), "outside");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
