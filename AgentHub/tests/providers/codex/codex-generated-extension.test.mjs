import test, { after } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { parseCodexRolloutActivity, readCodexRolloutActivityOnCurrentThread } from '../../../src/providers/codex/codex-rollout-activity.mjs';
import { codexTurnUsageFromJsonl, scanCodexHistoricalRollout } from '../../../src/providers/codex/codex-turn-usage.mjs';
import { CodexTerminalAudit } from '../../../src/providers/codex/codex-terminal-audit.mjs';
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hub-extension-images-'));
after(() => rm(temporaryRoot, { recursive: true, force: true }));
// Codex event_msg/item_completed metadata shape observed for generatedImage().
const events = [1, 2, 3].map(index => ({
  timestamp: '2026-09-10T20:34:35Z', type: 'event_msg',
  payload: {
    type: 'item_completed', thread_id: '01a086df-bb48-7dc1-9427-0af9065789cd',
    turn_id: '01a08d03-da74-7f73-98d2-83a79c0ca20c',
    item: { type: 'Extension', kind: 'image_gen.generation', id: `exec-${index}`,
      status: 'completed', revisedPrompt: '', result: '', transparentBackground: false,
      failure: null, savedPath: path.join(temporaryRoot, `exec-${index}.png`) },
  },
}));
const turnId = events[0].payload.turn_id;
const expected = events.map(e => ({ type: 'generated-path', value: e.payload.item.savedPath }));
const jsonl = rows => rows.map(e => JSON.stringify(e)).join('\n') + '\n';
test('Extension imagegen metadata projects three exact paths through activity and terminal usage', () => {
  const text = jsonl(events);
  assert.deepEqual(parseCodexRolloutActivity(text).generatedImageSources, { [turnId]: expected });
  assert.deepEqual(codexTurnUsageFromJsonl(text, turnId).generatedImageSources, expected);
  assert.deepEqual(codexTurnUsageFromJsonl(text, 'other-turn').generatedImageSources, []);
});
test('failed, unrelated and unowned Extension events cannot become generated attachments', () => {
  for (const mutate of [e => { e.payload.item.status = 'failed'; }, e => { e.payload.item.failure = 'failed'; }, e => { e.payload.item.kind = 'other'; }, e => { delete e.payload.turn_id; }]) {
    const event = structuredClone(events[0]); mutate(event);
    assert.deepEqual(parseCodexRolloutActivity(jsonl([event])).generatedImageSources ?? {}, {});
    assert.deepEqual(codexTurnUsageFromJsonl(jsonl([event]), turnId).generatedImageSources, []);
  }
});
test('bounded oversized reader and historical scanner recover new Extension format without retaining base64', async () => {
  const file = path.join(temporaryRoot, 'oversized.jsonl');
  const rows = structuredClone(events);
  for (const e of rows) e.payload.item.result = 'a'.repeat(300_000);
  await writeFile(file, jsonl(rows));
  try {
    const result = await readCodexRolloutActivityOnCurrentThread(file, { maximumLineBytes: 2048, tailBytes: 2 * 1024 * 1024 });
    assert.deepEqual(result.generatedImageSources, { [turnId]: expected });
    assert.equal(JSON.stringify(result).includes('aaaaaa'), false);
    const historical = await scanCodexHistoricalRollout(file);
    assert.deepEqual(historical.attachmentCandidates.find(e => e.turnId === turnId)?.generatedImageSources, expected);
  } finally { await unlink(file); }
});
test('v17 completed historical checkpoint reopens and repairs existing Extension outputs after restart', async () => {
  const file = path.join(temporaryRoot, 'repair.jsonl');
  const threadId = events[0].payload.thread_id;
  const rows = [...events, { timestamp: '2026-09-10T20:34:40Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }];
  const text = jsonl(rows);
  await writeFile(file, text);
  try {
    const repaired = [];
    const candidate = { id: threadId, path: file, updatedAt: '2026-09-10T20:34:40Z' };
    const audit = new CodexTerminalAudit({
      now: () => Date.parse('2026-09-10T21:00:00Z'),
      discoverHistoricalThreads: async () => [candidate],
      resolveProject: async () => ({ path: 'D:/workspace' }),
      statFile: async () => ({ size: Buffer.byteLength(text), mtimeMs: Date.parse(candidate.updatedAt) }),
      scanHistoricalFile: (thread, options) => scanCodexHistoricalRollout(thread.path, options),
      reconcile: async (_thread, _project, terminal) => { repaired.push(terminal); return true; },
      prepareHistoricalBackfill: async () => ({}),
      auditTimeMs: 1000,
    });
    audit.restore({ version: 17, historicalSubagentBackfill: { pending: false, initialized: true, queue: [], processedTurnIdentities: [threadId + '\0' + turnId] } });
    assert.equal(audit.snapshot().historicalSubagentBackfill.pending, true);
    await audit.runHistoricalMaintenance();
    const exact = repaired.find(t => t.turnId === turnId);
    assert.deepEqual(exact?.usageResult?.generatedImageSources ?? exact?.generatedImageSources, expected);
    assert.equal(audit.snapshot().version, 18);
    assert.equal(audit.snapshot().historicalSubagentBackfill.pending, false);
  } finally { await unlink(file); }
});

