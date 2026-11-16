import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FileTransferRoutes } from '../../src/interfaces/web/file-transfer-routes.mjs';
import { FileTransferService } from '../../src/infrastructure/filesystem/file-transfer-service.mjs';
import { FileTransferStore } from '../../src/infrastructure/persistence/file-transfer-store.mjs';
import { fileTransferPolicy } from '../../src/domain/file-transfer.mjs';
import { createFatalProcessHandler } from '../../src/runtime/fatal-process-handler.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'transfer-background-'));
const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
await mkdir(workspace);
const source = path.join(workspace, 'fault.bin');
await writeFile(source, Buffer.alloc(65536, 1));
let releaseCopy;
const copyGate = new Promise(resolve => { releaseCopy = resolve; });
let failed;
const failedGate = new Promise(resolve => { failed = resolve; });
const policy = fileTransferPolicy({ enabled: true, publicBaseUrl: 'https://files.example.test', freeBytes: 0 });
class FaultStore extends FileTransferStore {
  async heartbeatPreparation() {
    await copyGate;
    throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
  }
  async failPreparation(...args) { const result = await super.failPreparation(...args); failed(); return result; }
}
const store = new FaultStore({ dataDir, policy });
const service = new FileTransferService({ dataDir, roots: [workspace], store, policy,
  keyring: { currentKid: 'test', keys: { test: randomBytes(32) } } });
const shutdowns = [], unhandled = [];
const fatal = createFatalProcessHandler({ shutdown: async reason => shutdowns.push(reason),
  logger: { error() {} }, captureException() {}, flushDiagnostics: async () => {}, processRef: {} });
const onUnhandled = error => { unhandled.push(error.code); void fatal('unhandled rejection', error); };
process.on('unhandledRejection', onUnhandled);
const routes = new FileTransferRoutes({ assetsDirectory: workspace, policy, service });
const server = createServer(async (request, response) => {
  if (!await routes.handleOwner(request, response, request.method,
    new URL(request.url, 'http://127.0.0.1'), async () => ({ source: 'local-mini-app' }))) response.writeHead(404).end();
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/file-transfer/owner/prepare`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Agent-Hub-Transfer-Csrf': '1' },
    body: JSON.stringify({ path: source, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) });
  assert.equal(response.status, 202);
  const { artifact } = await response.json();
  assert.equal(artifact.state, 'preparing');
  // The ordinary HTTP caller does not wait. The optional waiter must still see EIO.
  const wait = process.argv.includes('--wait')
    ? assert.rejects(service.waitForPreparation(artifact.id), { code: 'EIO' }) : null;
  releaseCopy();
  await failedGate;
  // Drain real copy/close I/O before attaching service.close()'s allSettled.
  // beforeExit provides an event-loop boundary without masking the rejection.
  await new Promise(resolve => {
    process.once('beforeExit', resolve);
    server.close();
  });
  await service.close();
  if (wait) await wait;
  const files = await readdir(path.join(dataDir, 'file-transfers', 'artifacts'));
  // Reopen the real store; failed snapshots remain charged until canonical GC.
  const reopened = new FileTransferStore({ dataDir, policy });
  await reopened.initialize();
  try { assert.equal((await reopened.artifact('local', artifact.id)).state, 'failed'); }
  finally { await reopened.close(); }
  const db = new DatabaseSync(path.join(dataDir, 'runtime.sqlite'), { readOnly: true });
  let charged;
  try { charged = db.prepare("SELECT sum(size) n FROM transfer_artifacts WHERE state!='deleted'").get().n; }
  finally { db.close(); }
  assert.equal(charged, 65536);
  assert.deepEqual(files, []);
  console.log(JSON.stringify({ http: response.status, state: 'failed', files, charged, unhandled, shutdowns, waited: Boolean(wait) }));
  assert.deepEqual(unhandled, []);
  assert.deepEqual(shutdowns, []);
} finally {
  releaseCopy();
  await new Promise(resolve => server.close(resolve));
  await service.close();
  process.off('unhandledRejection', onUnhandled);
  await rm(root, { recursive: true, force: true });
}
