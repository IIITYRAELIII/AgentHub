import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodexRolloutActivity, readCodexRolloutActivityOnCurrentThread } from '../../../src/providers/codex/codex-rollout-activity.mjs';

const turnId = 'synthetic-long-turn';
const entry = (index, payload) => JSON.stringify({
  type: 'response_item', timestamp: '2026-09-29T00:00:00Z',
  payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turnId } },
});

test('long rollout keeps a bounded recent activity projection without changing the latest block', () => {
  for (const count of [100, 1000, 5000]) {
    const rows = Array.from({ length: count }, (_, index) => entry(index, {
      type: 'message', id: `analysis-${index}`, role: 'assistant', phase: 'analysis',
      content: [{ type: 'output_text', text: 'x'.repeat(1000) }],
    }));
    const groups = parseCodexRolloutActivity(rows.join('\n')).activityGroups[turnId];
    assert.ok(groups.length <= 256, `count=${count}, groups=${groups.length}`);
    assert.equal(groups.at(-1).id, `commentary:analysis-${count - 1}`);
    assert.equal(groups.at(-1).reasoning, 'x'.repeat(1000));
    assert.ok(Buffer.byteLength(JSON.stringify(groups)) < 300_000);
  }
});

test('one block with many tools stays bounded and retains the newest tool', () => {
  const rows = [entry(0, {
    type: 'message', id: 'analysis', role: 'assistant', phase: 'analysis',
    content: [{ type: 'output_text', text: 'working' }],
  })];
  for (let index = 0; index < 1000; index += 1) rows.push(entry(index + 1, {
    type: 'custom_tool_call', id: `tool-${index}`, name: 'exec', status: 'completed',
    input: 'await tools.shell_command({command:"true"})',
  }));
  const groups = parseCodexRolloutActivity(rows.join('\n')).activityGroups[turnId];
  assert.ok(groups[0].activities.length <= 128);
  assert.equal(groups[0].activities.at(-1).id, 'item:tool-999');
});

test('one long visible reasoning block remains complete for source annotation ranges', () => {
  const reasoning = 'r'.repeat(50_000);
  const groups = parseCodexRolloutActivity(entry(0, {
    type: 'message', id: 'long-analysis', role: 'assistant', phase: 'analysis',
    content: [{ type: 'output_text', text: reasoning }],
  })).activityGroups[turnId];
  assert.equal(groups[0].reasoning, reasoning);
});

test('partial append preserves previous snapshot and completes the newest activity once', async () => {
  const fixtureRoot = fileURLToPath(new URL('../../../../WIP/sol-benchmark/', import.meta.url));
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(path.join(fixtureRoot, 'append-'));
  const file = path.join(directory, 'rollout.jsonl');
  const commentary = index => entry(index, {
    type: 'message', id: `analysis-${index}`, role: 'assistant', phase: 'analysis',
    content: [{ type: 'output_text', text: 'x'.repeat(1000) }],
  });
  try {
    await writeFile(file, `${Array.from({ length: 1000 }, (_, index) => commentary(index)).join('\n')}\n`);
    const first = await readCodexRolloutActivityOnCurrentThread(file);
    const firstBytes = JSON.stringify(first.activityGroups[turnId]);
    const last = commentary(1000);
    await appendFile(file, last.slice(0, 100));
    const partial = await readCodexRolloutActivityOnCurrentThread(file);
    assert.equal(partial.activityGroups[turnId].at(-1).id, 'commentary:analysis-999');
    await appendFile(file, `${last.slice(100)}\n`);
    const second = await readCodexRolloutActivityOnCurrentThread(file);
    assert.equal(second.activityGroups[turnId].at(-1).id, 'commentary:analysis-1000');
    assert.equal(second.activityGroups[turnId].length, 256);
    assert.equal(JSON.stringify(first.activityGroups[turnId]), firstBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
