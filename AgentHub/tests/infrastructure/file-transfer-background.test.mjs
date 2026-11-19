import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const wait of [false, true]) test(`HTTP 202 background failure stays local; waiter=${wait}`, async () => {
  const result = await promisify(execFile)(process.execPath, ['--no-warnings',
    fileURLToPath(new URL('../fixtures/file-transfer-background-worker.mjs', import.meta.url)), ...(wait ? ['--wait'] : [])],
  { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.http, 202);
  assert.equal(value.state, 'failed');
  assert.deepEqual(value.unhandled, []);
  assert.deepEqual(value.shutdowns, []);
  assert.equal(value.waited, wait);
});
