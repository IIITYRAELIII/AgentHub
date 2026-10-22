import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileTransferService } from "../../src/infrastructure/filesystem/file-transfer-service.mjs";
import { FileTransferStore } from "../../src/infrastructure/persistence/file-transfer-store.mjs";
import { FileTransferRoutes } from "../../src/interfaces/web/file-transfer-routes.mjs";
import { fileTransferPolicy } from "../../src/domain/file-transfer.mjs";

const [root, mode] = process.argv.slice(2);
const workspace = path.join(root, "workspace"), source = path.join(workspace, "synthetic.bin");
await mkdir(workspace, { recursive: true });
await writeFile(source, Buffer.alloc(64 * 1024, 1));
const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: "https://transfer.example.test", freeBytes: 0 });
const store = new FileTransferStore({ dataDir: root, policy });
let release;
const gate = new Promise(resolve => { release = resolve; });
let failed;
const failure = new Promise(resolve => { failed = resolve; });
const heartbeat = store.heartbeatPreparation.bind(store);
let changed = false;
store.heartbeatPreparation = async id => {
  await heartbeat(id);
  if (!changed) {
    changed = true;
    await gate; // HTTP caller gets its 202 before the real source changes.
    await writeFile(source, Buffer.alloc(64 * 1024 + 1, 2));
  }
};
const failPreparation = store.failPreparation.bind(store);
store.failPreparation = async (...args) => { await failPreparation(...args); failed(); };
const service = new FileTransferService({ dataDir: root, roots: [workspace], store, policy,
  keyring: { currentKid: "fixture", keys: { fixture: Buffer.alloc(32, 7) } } });
const routes = new FileTransferRoutes({ assetsDirectory: fileURLToPath(new URL("../../assets/web-app", import.meta.url)), policy, service });
const server = createServer(async (req, res) => {
  if (!await routes.handleOwner(req, res, req.method, new URL(req.url, "http://127.0.0.1"),
    async () => ({ source: "local-mini-app" }))) res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { "Content-Type": "application/json", Origin: origin, "X-Agent-Hub-Transfer-CSRF": "1" };
  const prepared = await fetch(`${origin}/api/file-transfer/owner/prepare`, { method: "POST", headers,
    body: JSON.stringify({ path: source, requestId: randomUUID() }) });
  assert.equal(prepared.status, 202);
  const { artifact } = await prepared.json();
  assert.equal(artifact.state, "preparing");
  const waiter = mode === "explicit-wait" ? assert.rejects(service.waitForPreparation(artifact.id), /transfer-source-changed/u) : null;
  release();
  await failure;
  // Let Node perform its unhandled-rejection check. No global rejection handler
  // or explicit preparation waiter exists in the ordinary HTTP caller case.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await waiter;
  const status = await fetch(`${origin}/api/file-transfer/owner/status`, { method: "POST", headers,
    body: JSON.stringify({ path: source }) });
  assert.equal(status.status, 200);
  const state = await status.json();
  assert.equal(state.artifact.state, "failed");
  assert.equal(state.share, null);
  const share = await fetch(`${origin}/api/file-transfer/owner/create`, { method: "POST", headers,
    body: JSON.stringify({ artifactId: artifact.id, requestId: randomUUID(), ttlMs: 3_600_000 }) });
  assert.equal(share.status, 409);
  assert.deepEqual(await readdir(path.join(root, "file-transfers", "artifacts")), []);
  console.log(JSON.stringify({ accepted: "preparing", alive: true, durableState: "failed", shareStatus: share.status,
    partials: 0, explicitWaitRejected: Boolean(waiter) }));
} finally {
  release();
  await service.close();
  await new Promise(resolve => server.close(resolve));
}
