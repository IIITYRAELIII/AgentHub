import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { ensureReleaseProgressMonitor, createReleaseProgressObserver } from '../../src/infrastructure/process/release-progress-monitor.mjs';
import { ReleaseOperationService } from '../../src/application/release-operation-service.mjs';
import { ReleaseOperationStore } from '../../src/infrastructure/persistence/release-operation-store.mjs';

const helper = pathToFileURL(path.resolve(import.meta.dirname, '../../src/infrastructure/process/release-progress-monitor.mjs')).href;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monitor-auto-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  return { runtimeRoot: root, operationId: 'original-operation', port };
}
async function stopOwned(input, result) {
  const identity = await (await fetch(result.url + '/api/identity')).json();
  assert.equal(identity.operationId, input.operationId); assert.equal(identity.pid, result.pid);
  process.kill(result.pid);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await fetch(result.url + '/api/identity'); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('owned monitor did not exit');
}
async function creator(t, input) {
  const file = path.join(input.runtimeRoot, `creator-${Math.random()}.mjs`);
  await writeFile(file, `import { ensureReleaseProgressMonitor } from ${JSON.stringify(helper)};
console.log(JSON.stringify(await ensureReleaseProgressMonitor(${JSON.stringify(input)})));`);
  const child = spawn(process.execPath, [file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr); assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('two independent launchers converge; detached viewer survives both creators and is recreated after absence', async t => {
  const input = await fixture(t);
  const results = await Promise.all([creator(t, input), creator(t, input)]);
  let current = results[0];
  t.after(async () => { if (current) await stopOwned(input, current); });
  assert.equal(results[0].pid, results[1].pid);
  assert.equal((await fetch(current.url)).status, 200);
  assert.equal((await fetch(current.url + '/api/status')).status, 503); // no execution yet, not a failed launch
  const reused = await ensureReleaseProgressMonitor(input);
  assert.equal(reused.pid, current.pid); assert.equal(reused.reused, true);
  await stopOwned(input, current); current = null;
  current = await ensureReleaseProgressMonitor(input);
  assert.notEqual(current.pid, reused.pid);
  assert.equal((await fetch(current.url)).status, 200);
  await assert.rejects(ensureReleaseProgressMonitor({ ...input, operationId: 'foreign' }), /MONITOR_PORT_OCCUPIED/);
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'monitor-foreign-'));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  await assert.rejects(ensureReleaseProgressMonitor({ ...input, runtimeRoot: otherRoot }), /MONITOR_PORT_OCCUPIED/);
  assert.equal((await fetch(current.url + '/api/identity', { method: 'POST' })).status, 405);
  assert.equal((await fetch(current.url + '/api/identity', { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
});

test('foreign listener is preserved; accepted legacy same-original viewer is reused without replacement', async t => {
  const input = await fixture(t); let legacy = false, requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (legacy && req.url === '/api/status') res.writeHead(200).end(JSON.stringify({ operationId: input.operationId, generation: 6, run: 'legacy', cases: [] }));
    else res.writeHead(404).end();
  });
  server.listen(input.port, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(ensureReleaseProgressMonitor(input), /MONITOR_PORT_OCCUPIED/);
  legacy = true;
  const result = await ensureReleaseProgressMonitor(input);
  assert.equal(result.reused, true); assert.equal(result.identityMode, 'legacy-operation');
  assert.equal(requests, 4); assert.equal(server.listening, true);
});

function service(store, observeOperation) {
  const scheduled = [];
  const forbidden = () => assert.fail('publisher must not run during addressed monitor admission');
  return new ReleaseOperationService({ store, observeOperation, schedule: work => scheduled.push(work),
    processAlive: () => true, compose: forbidden, validate: forbidden, publishTarget: forbidden,
    readTarget: forbidden, finalize: forbidden });
}
test('actual durable start and first continue after reopening reuse original operation and independently start viewer', async t => {
  const input = await fixture(t);
  const store = new ReleaseOperationStore({ dataDir: input.runtimeRoot, idFactory: () => input.operationId });
  const launched = [];
  const observer = createReleaseProgressObserver({ runtimeRoot: input.runtimeRoot, ensure: args => {
    const promise = ensureReleaseProgressMonitor({ ...args, port: input.port }); launched.push(promise); return promise;
  }, onError: error => assert.fail(error) });
  const first = service(store, observer);
  const args = { requestId: 'one-start', workspaceId: 'workspace', streamId: 'stream', threadId: 'thread',
    authorization: { taskIds: ['selected'], approvedTargets: [{ targetId: 'git', kind: 'git', repositoryRoot: 'repository' }], validationMode: 'full' } };
  const started = first.start(args);
  await Promise.resolve(); let viewer = await launched.at(-1);
  t.after(async () => { if (viewer) await stopOwned(input, viewer); });
  assert.equal(started.operationId, input.operationId);
  const duplicate = first.start(args); await Promise.resolve();
  assert.equal(duplicate.created, false); assert.equal((await launched.at(-1)).pid, viewer.pid);
  const ordinaryContinue = first.continue(input.operationId); await Promise.resolve();
  assert.equal(ordinaryContinue.accepted, true); assert.equal((await launched.at(-1)).pid, viewer.pid);
  const before = store.get(input.operationId);
  store.transition(input.operationId, { state: 'waiting', currentStep: 'compose', nextAction: 'external condition' }, { expectedRevision: before.revision });
  const retained = store.snapshot(input.operationId);
  await stopOwned(input, viewer); viewer = null;
  const resumedStore = new ReleaseOperationStore({ dataDir: input.runtimeRoot });
  const resumedOwner = service(resumedStore, observer);
  const continued = resumedOwner.continue(input.operationId); await Promise.resolve(); viewer = await launched.at(-1);
  assert.equal(continued.accepted, false); assert.equal(continued.reason, 'external-condition');
  assert.deepEqual(store.snapshot(input.operationId), retained);
  assert.equal((await fetch(viewer.url)).status, 200);
  assert.throws(() => resumedOwner.continue('missing'), /not found/);
});

test('monitor failure is independent of release admission and never repeats publication', async t => {
  const input = await fixture(t), errors = [];
  const store = new ReleaseOperationStore({ dataDir: input.runtimeRoot });
  const owner = service(store, createReleaseProgressObserver({ runtimeRoot: input.runtimeRoot,
    ensure: async () => { throw Object.assign(new Error('occupied'), { code: 'MONITOR_PORT_OCCUPIED' }); }, onError: error => errors.push(error.code) }));
  const result = owner.start({ requestId: 'one', workspaceId: 'workspace', streamId: 'stream', threadId: 'thread',
    authorization: { taskIds: ['selected'], approvedTargets: [{ targetId: 'git', kind: 'git', repositoryRoot: 'repository' }], validationMode: 'full' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.accepted, true); assert.deepEqual(errors, ['MONITOR_PORT_OCCUPIED']);
  assert.equal(store.snapshot(result.operationId).generations.length, 0);
});
