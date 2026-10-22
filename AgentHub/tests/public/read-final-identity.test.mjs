import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { taskHasUnreadAnswer } from '../../src/infrastructure/persistence/task-read-state-store.mjs';

const context = { window: {} };
const source = process.env.AGENT_HUB_READ_MARKER_SOURCE
  ? pathToFileURL(process.env.AGENT_HUB_READ_MARKER_SOURCE)
  : new URL('../../assets/web-app/messages/read-marker.js', import.meta.url);
vm.runInNewContext(await readFile(source, 'utf8'), context);
const { cursorCovers, newerReceipt } = context.window.AgentHubReadMarker;
const final = { provider: 'codex', threadId: 'thread', turnId: 'turn-b', revision: 2,
  completedAt: '2026-10-16T09:10:10.774Z' };
const receipt = { final, cursor: { answerAtMs: Date.parse(final.completedAt), answerTurnId: final.turnId, answerRevision: 2 } };

test('browser confirmed read and server agree when exact final completion time changes', () => {
  for (const completedAt of [final.completedAt, '2026-10-16T09:10:25.273Z', '2026-10-16T09:09:00.000Z']) {
    for (const revision of [1, 2, 3]) {
      const current = { ...final, completedAt, revision };
      assert.equal(cursorCovers(current, receipt), revision <= 2);
      assert.equal(cursorCovers(current, receipt), !taskHasUnreadAnswer({
        answerAt: current.completedAt, answerTurnId: current.turnId, answerRevision: revision,
      }, receipt.cursor));
    }
  }
  assert.equal(cursorCovers({ ...final, threadId: 'other' }, receipt), false);
  assert.equal(cursorCovers({ ...final, provider: 'claude' }, receipt), false);
  assert.equal(cursorCovers({ ...final, turnId: 'turn-new', completedAt: '2026-10-16T09:11:00Z' }, receipt), false);
  assert.equal(cursorCovers(final, { final, cursor: { ...receipt.cursor, answerRevision: NaN } }), false);
});

test('delayed receipt cannot replace a higher read revision by its later clock', () => {
  const next = { final: { ...final, revision: 3, completedAt: '2026-10-16T09:09:00Z' },
    cursor: { ...receipt.cursor, answerAtMs: Date.parse('2026-10-16T09:09:00Z'), answerRevision: 3 } };
  assert.equal(newerReceipt(receipt, next), next);
  assert.equal(newerReceipt(next, receipt), next);
  assert.equal(newerReceipt(receipt, { ...receipt, cursor: { ...receipt.cursor, answerAtMs: Date.parse('2026-10-16T09:12:00Z') } }), receipt);
});
