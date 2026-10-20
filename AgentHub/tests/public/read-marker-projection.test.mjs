import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { taskHasUnreadAnswer } from '../../src/infrastructure/persistence/task-read-state-store.mjs';

const context = { window: {} };
vm.runInNewContext(await readFile(new URL('../../assets/web-app/messages/read-marker.js', import.meta.url), 'utf8'), context);
const { cursorCovers, newerReceipt } = context.window.AgentHubReadMarker;
const final = { provider: 'codex', threadId: 'thread', turnId: 'turn-b', revision: 2,
  completedAt: '2026-10-06T07:00:00.000Z' };
const receipt = { final, cursor: { answerAtMs: Date.parse(final.completedAt), answerTurnId: final.turnId, answerRevision: 2 } };

test('read projection follows the canonical server cursor tuple and exact Thread scope', () => {
  for (const item of [final, { ...final, revision: 1 }, { ...final, revision: 3 },
    { ...final, turnId: 'turn-a' }, { ...final, turnId: 'turn-c' },
    { ...final, completedAt: '2026-10-06T06:59:59.000Z', turnId: 'turn-z' },
    { ...final, completedAt: '2026-10-06T07:00:01.000Z' }]) {
    assert.equal(cursorCovers(item, receipt), !taskHasUnreadAnswer({
      answerAt: item.completedAt, answerTurnId: item.turnId, answerRevision: item.revision,
    }, receipt.cursor));
  }
  assert.equal(cursorCovers({ ...final, threadId: 'foreign' }, receipt), false);
  assert.equal(cursorCovers({ ...final, provider: 'claude' }, receipt), false);
  assert.equal(cursorCovers(final, { final, cursor: { ...receipt.cursor, answerRevision: Infinity } }), false);
  assert.equal(cursorCovers(final, null), false);
  assert.equal(cursorCovers({ ...final, completedAt: undefined }, receipt), true);
  assert.equal(cursorCovers({ ...final, turnId: 'unknown', completedAt: undefined }, receipt), false);
});

test('an older delayed receipt cannot replace a newer confirmed server cursor', () => {
  const next = { final: { ...final, revision: 3 }, cursor: { ...receipt.cursor, answerRevision: 3 } };
  assert.equal(newerReceipt(receipt, next), next);
  assert.equal(newerReceipt(next, receipt), next);
});
