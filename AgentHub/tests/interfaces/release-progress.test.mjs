import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TestLog, ProgressReader } from '../../release-progress/reader.mjs';
import { startMonitor } from '../../release-progress/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'data/release-operation-executions/one');
  await mkdir(path.join(folder, 'publication-runs'), { recursive: true });
  const log = path.join(folder, 'publication-runs/test.log');
  const runner = { operationId: 'original', generation: 2, startedAt: '2026-10-23T17:30:07Z', status: 'running' };
  const status = { status: 'running', currentStep: 'Полные тесты', logFile: log, steps: [{ stageId: 'agent-hub-full-tests', status: 'running' }] };
  await writeFile(log, '✔ preserves original message (12.5ms)\n');
  await writeFile(path.join(folder, 'runner.json'), JSON.stringify(runner));
  await writeFile(path.join(folder, 'publication-status.json'), JSON.stringify(status));
  return { root, folder, log, status, runner };
}
test('test projection preserves exact names and attaches repeated failure details without double counting', () => {
  const log = new TestLog();
  log.append('✔ обычная '); log.append('проверка (2.5ms)\n✖ unsafe <img src=x> (3ms)\n✖ failing tests:\n\ntest at tests/example.mjs:2\n✖ unsafe <img src=x> (3ms)\n  AssertionError: expected true\n');
  assert.equal(log.cases.length, 2); assert.equal(log.cases[0].name, 'обычная проверка');
  assert.equal(log.cases[1].name, 'unsafe <img src=x>'); assert.match(log.cases[1].details, /AssertionError/u);
  assert.equal(log.cases[1].status, 'failed');
});
test('reader incrementally decodes UTF8, resets after truncation and never labels stale running as terminal', async t => {
  const f = await fixture(t), reader = new ProgressReader({ runtimeRoot: f.root, operationId: 'original' });
  const before = await stat(f.log), first = await reader.snapshot();
  assert.equal(first.counts.passed, 1); assert.equal(first.status, 'running');
  const bytes = Buffer.from('✔ сохранение (1ms)\n');
  await appendFile(f.log, bytes.subarray(0, 5)); await reader.snapshot();
  await appendFile(f.log, bytes.subarray(5)); const next = await reader.snapshot();
  assert.equal(next.cases[1].name, 'сохранение'); assert.equal(next.cases.length, 2);
  await writeFile(f.log, '✖ new (1ms)\n'); const reset = await reader.snapshot();
  assert.equal(reset.cases.length, 1); assert.equal(reset.cases[0].name, 'new');
  assert.equal(before.birthtimeMs, (await stat(f.log)).birthtimeMs);
});
test('reader binds operation and latest generation and refuses a log outside its execution root', async t => {
  const f = await fixture(t), reader = new ProgressReader({ runtimeRoot: f.root, operationId: 'original' });
  const second = path.join(f.root, 'data/release-operation-executions/two');
  await mkdir(second); await writeFile(path.join(second, 'runner.json'), JSON.stringify({ ...f.runner, operationId: 'foreign', generation: 99 }));
  assert.equal((await reader.snapshot()).generation, 2);
  await writeFile(path.join(second, 'runner.json'), JSON.stringify({ ...f.runner, generation: 3 }));
  const nextLog = path.join(second, 'next.log'); await writeFile(nextLog, '✔ next generation (1ms)\n');
  await writeFile(path.join(second, 'publication-status.json'), JSON.stringify({ ...f.status, logFile: nextLog }));
  const next = await reader.snapshot(); assert.equal(next.generation, 3); assert.equal(next.cases.length, 1); assert.equal(next.cases[0].name, 'next generation');
  await writeFile(path.join(second, 'runner.json'), JSON.stringify({ ...f.runner, operationId: 'foreign', generation: 99 }));
  await writeFile(path.join(f.folder, 'publication-status.json'), JSON.stringify({ ...f.status, logFile: path.join(f.root, 'outside.log') }));
  await writeFile(path.join(f.root, 'outside.log'), 'private');
  await assert.rejects(reader.snapshot(), /вне каталога/u);
});
test('local HTTP exposes observation only, rejects foreign origins and preserves source files', async t => {
  const f = await fixture(t); const bytes = await readFile(f.log), before = await stat(f.log);
  const { server, url } = await startMonitor({ runtimeRoot: f.root, operationId: 'original' });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  const first = await (await fetch(url + '/api/status')).json(); assert.equal(first.cases.length, 1);
  const delta = await (await fetch(url + `/api/status?run=${encodeURIComponent(first.run)}&after=1`)).json(); assert.equal(delta.cases.length, 0);
  assert.equal((await fetch(url + '/api/status', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + '/api/status', { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await fetch(url + '/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(url + '/api/status?file=../../outside')).status, 200);
  assert.equal((await fetch(url + '/missing')).status, 404);
  assert.equal(await (await fetch(url + '/log.txt')).text(), bytes.toString());
  const badHost = await new Promise(resolve => { const req = http.get(url + '/api/status', { headers: { Host: 'foreign.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', () => resolve(0)); });
  assert.equal(badHost, 403); assert.deepEqual(await readFile(f.log), bytes); assert.equal((await stat(f.log)).mtimeMs, before.mtimeMs);
});
