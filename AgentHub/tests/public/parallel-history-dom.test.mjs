import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser, openFixture, snapshot } from './composer-production.fixture.mjs';

test('a live update in one open Stream preserves the other visible history columns', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const initial = snapshot();
    const unseenFinal = { provider: 'codex', threadId: 'thread-b', turnId: 'final-b',
      revision: 1, completedAt: new Date().toISOString() };
    Object.assign(initial.tasks[1], { unread: true, latestFinal: unseenFinal,
      lastAnswerAt: unseenFinal.completedAt, lastAnswerTurnId: unseenFinal.turnId });
    for (const suffix of ['c', 'd']) {
      initial.tasks.push({ ...initial.tasks[1], streamId: `stream-${suffix}`, threadId: `thread-${suffix}`,
        unread: false, latestFinal: null, lastAnswerTurnId: null,
        title: `Thread ${suffix}`, displayTitle: `Thread ${suffix}`, streamName: `Stream ${suffix}`,
        streamDisplayName: `Stream ${suffix}`, streamOrdinal: suffix === 'c' ? 3 : 4 });
      initial.workspaces[0].streams.push({ id: `stream-${suffix}`, name: `Stream ${suffix}`,
        threads: [{ id: `thread-${suffix}` }] });
    }
    const errors = await openFixture(page, { fixtureSnapshot: initial });
    await page.evaluate(() => {
      window.__heldColumnOpens = [];
      window.__heldColumnHistory = [];
      window.__columnReads = [];
      const post = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = message => {
        if (['open-task', 'task-history'].includes(message.action)) {
          if (message.action === 'open-task') window.__heldColumnOpens.push(message.params.streamId);
          else window.__heldColumnHistory.push(message);
          return;
        }
        if (message.action === 'mark-task-read') window.__columnReads.push(message.params);
        if (message.action === 'snapshot') {
          queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'agenthub:control-result', id: message.id, ok: true,
            result: { notModified: true, version: window.__agentHubFixture.snapshot.version },
          } })));
          return;
        }
        post(message);
      };
    });
    for (const suffix of ['b', 'c', 'd']) {
      await page.locator(`[data-stream-task-id="stream-${suffix}"]:visible`).first().click({ modifiers: ['Control'] });
    }
    await page.locator('.stream-chat-preview[data-stream-chat-task-id="stream-a"] .stream-chat-preview-head').click();
    const dispatched = await page.evaluate(() => window.__heldColumnOpens);
    for (const suffix of ['a', 'b', 'c', 'd']) {
      assert.ok(dispatched.includes(`stream-${suffix}`), 'later navigation dispatches while earlier replies remain held');
    }
    await page.evaluate(() => {
      for (const suffix of ['a', 'b', 'c', 'd']) {
        window.AgentHub.setMessages(`stream-${suffix}`, Array.from({ length: 20 }, (_, index) => ({
          id: `${suffix}-${index}`, role: 'agent', author: 'Agent',
          text: `History ${suffix} ${index}\n\n` + 'Retained paragraph content. '.repeat(60)
            + '\n\n<details><summary>Retained detail</summary>Expanded detail body</details>',
        })));
      }
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('[data-composer-input]').fill('Keep this draft and caret');
    await page.locator('[data-composer-input]').evaluate(input => input.setSelectionRange(5, 9));
    const before = await page.evaluate(() => {
      const refs = {};
      for (const suffix of ['b', 'c', 'd']) refs[suffix] = document.querySelector(`.stream-chat-preview[data-stream-chat-task-id="stream-${suffix}"]`);
      const scroll = refs.c.querySelector('.stream-chat-preview-log');
      scroll.scrollTop = 73;
      const detail = refs.c.querySelector('details');
      detail.open = true;
      window.__columnRefs = refs;
      return { scrollTop: scroll.scrollTop, scrollable: scroll.scrollHeight > scroll.clientHeight };
    });
    assert.equal(before.scrollable, true);
    const result = await page.evaluate(async () => {
      const started = performance.now();
      window.AgentHub.setLive('stream-b', { author: 'Agent', stage: 'Answering', text: 'Fresh B live update' });
      const elapsedMs = performance.now() - started;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const node = suffix => document.querySelector(`.stream-chat-preview[data-stream-chat-task-id="stream-${suffix}"]`);
      return { elapsedMs, unchangedC: node('c') === window.__columnRefs.c,
        unchangedD: node('d') === window.__columnRefs.d,
        cScrollTop: node('c').querySelector('.stream-chat-preview-log').scrollTop,
        cDetailOpen: node('c').querySelector('details').open,
        bUpdated: node('b').textContent.includes('Fresh B live update'),
        selected: document.querySelector('[data-chat-pane]').dataset.streamChatTaskId,
        draft: document.querySelector('[data-composer-input]').value,
        selection: [document.querySelector('[data-composer-input]').selectionStart, document.querySelector('[data-composer-input]').selectionEnd] };
    });
    console.log(JSON.stringify({ elapsedMs: result.elapsedMs, unchangedC: result.unchangedC,
      unchangedD: result.unchangedD, cScrollTop: result.cScrollTop, cDetailOpen: result.cDetailOpen }));
    assert.equal(result.unchangedC, true, 'unrelated visible history must retain its DOM and scroll owner');
    assert.equal(result.unchangedD, true);
    assert.equal(result.cScrollTop, before.scrollTop);
    assert.equal(result.cDetailOpen, true);
    assert.equal(result.bUpdated, true);
    assert.equal(result.selected, 'stream-a');
    assert.equal(result.draft, 'Keep this draft and caret');
    assert.deepEqual(result.selection, [5, 9]);
    // The normal background history owner may render an unread final in B's
    // read-only preview. Only the selected visible chat grants read evidence.
    await page.waitForFunction(() => window.__heldColumnHistory.some(message => message.params.streamId === 'stream-b'));
    await page.evaluate(final => {
      const message = window.__heldColumnHistory.find(message => message.params.streamId === 'stream-b');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'agenthub:control-result',
        id: message.id, ok: true, result: { provider: final.provider, threadId: final.threadId,
          streamId: 'stream-b', start: 0, end: 1, total: 1, nextBefore: null, version: 'unseen-b',
          items: [{ id: final.turnId, completed: true, status: 'completed', terminalRevision: final.revision,
            prompt: 'B user input', answer: 'Canonical unseen B', completedAt: final.completedAt }] } } }));
    }, unseenFinal);
    await page.locator('.stream-chat-preview[data-stream-chat-task-id="stream-b"]').getByText('Canonical unseen B', { exact: true }).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__columnReads.length), 0);
    assert.ok(await page.locator('[data-stream-task-id="stream-b"][data-answer-ready]').count() > 0);
    if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
      await mkdir(process.env.AGENT_HUB_UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, 'parallel-history-retained.png') });
    }
    const later = await page.evaluate(() => {
      const refs = window.__columnRefs;
      const unchanged = () => ['c', 'd'].every(suffix => document.querySelector(
        `.stream-chat-preview[data-stream-chat-task-id="stream-${suffix}"]`) === refs[suffix]);
      window.AgentHub.setMessages('stream-b', [{ id: 'new-b', role: 'agent', author: 'Agent', text: 'Fresh B history' }]);
      const afterHistory = unchanged();
      window.AgentHub.setQueue('stream-b', [{ id: 'queued-b', state: 'queued', text: 'Pending B input' }]);
      const afterQueue = unchanged();
      // A lost physical column must still heal through the canonical deck owner.
      document.querySelector('.stream-chat-preview[data-stream-chat-task-id="stream-c"]').remove();
      window.AgentHub.setLive('stream-b', { author: 'Agent', stage: 'Answering', text: 'Next B update' });
      const healed = document.querySelectorAll('.stream-chat-preview').length === 3
        && Boolean(document.querySelector('.stream-chat-preview[data-stream-chat-task-id="stream-c"]'));
      // A same-count stale/foreign physical binding also requires the full
      // canonical repair, rather than trusting the stable layout key alone.
      const badColumn = document.querySelector('.stream-chat-preview[data-stream-chat-task-id="stream-c"]');
      badColumn.dataset.streamChatThreadId = 'foreign-thread';
      window.AgentHub.setLive('stream-b', { author: 'Agent', stage: 'Answering', text: 'After physical binding drift' });
      const identityHealed = document.querySelector(
        '.stream-chat-preview[data-stream-chat-task-id="stream-c"]')?.dataset.streamChatThreadId === 'thread-c';
      window.AgentHub.selectTask('stream-c');
      const oldD = document.querySelector('.stream-chat-preview[data-stream-chat-task-id="stream-d"]');
      window.AgentHub.setLive('stream-b', { author: 'Agent', stage: 'Answering', text: 'Final B update' });
      return { afterHistory, afterQueue, healed, identityHealed,
        selected: document.querySelector('[data-chat-pane]').dataset.streamChatTaskId,
        currentOwnerPreserved: document.querySelector('.stream-chat-preview[data-stream-chat-task-id="stream-d"]') === oldD };
    });
    assert.deepEqual(later, { afterHistory: true, afterQueue: true, healed: true, identityHealed: true,
      selected: 'stream-c', currentOwnerPreserved: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
