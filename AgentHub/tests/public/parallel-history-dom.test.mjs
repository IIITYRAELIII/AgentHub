import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { applyFixtureSnapshot, launchBrowser, openFixture, snapshot } from './composer-production.fixture.mjs';

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
      window.__holdColumnResponses = false;
      const post = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = message => {
        if (window.__holdColumnResponses && ['select-task', 'task-history'].includes(message.action)) {
          if (message.action === 'select-task') window.__heldColumnOpens.push(message.params.streamId);
          else window.__heldColumnHistory.push(message);
          return;
        }
        if (message.action === 'task-history') {
          const suffix = message.params.streamId.at(-1);
          queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'agenthub:control-result', id: message.id, ok: true,
            result: { provider: 'codex', threadId: `thread-${suffix}`, streamId: message.params.streamId,
              start: 0, end: 20, total: 20, nextBefore: null, version: `loaded-${suffix}`,
              items: Array.from({ length: 20 }, (_, index) => ({ id: `turn-${suffix}-${index}`, completed: true,
                messages: [{ role: 'agent', itemId: `${suffix}-${index}`, phase: 'final',
                  text: `History ${suffix} ${index}\n\n` + 'Retained paragraph content. '.repeat(60)
                    + '\n\n<details><summary>Retained detail</summary>Expanded detail body</details>' }] })) },
          } })));
          return;
        }
        if (message.action === 'mark-task-read') window.__columnReads.push(message.params);
        if (window.__holdColumnResponses && message.action === 'snapshot') {
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
    for (const suffix of ['a', 'b', 'c', 'd']) await page.getByText(`History ${suffix} 19`, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__columnReads.length), 0, 'the unseen final has not been rendered during warm-up');
    await page.evaluate(() => { window.__holdColumnResponses = true; });
    // These are already loaded open pages. Hold their ordinary selections and
    // background refreshes without inventing a UI-only history cache.
    for (const suffix of ['b', 'c', 'd', 'a']) {
      await page.locator(`.stream-chat-preview[data-stream-chat-task-id="stream-${suffix}"] .stream-chat-preview-head`).click();
    }
    const dispatched = await page.evaluate(() => window.__heldColumnOpens);
    for (const suffix of ['a', 'b', 'c', 'd']) {
      assert.ok(dispatched.includes(`stream-${suffix}`), 'later navigation dispatches while earlier replies remain held');
    }
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

test('a visible column keeps its coalesced source refresh across a quick A-B-A selection', { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5_000);
    const initial = snapshot();
    const errors = await openFixture(page, { fixtureSnapshot: initial });
    const a = page.locator('[data-stream-task-id="stream-a"]:visible').first();
    const b = page.locator('[data-stream-task-id="stream-b"]:visible').first();
    await b.click({ modifiers: ['Control'] });
    const previewA = page.locator('.stream-chat-preview[data-stream-chat-task-id="stream-a"] .stream-chat-preview-head');
    if (await previewA.count()) await previewA.click();
    await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-a');
    await page.evaluate(() => {
      const post = window.__agentHubVscode.postMessage;
      const sampleHistory = (text, version) => ({
        provider: 'codex', threadId: 'thread-a', streamId: 'stream-a', start: 0, end: 1,
        total: 1, messageTotal: 1, nextBefore: null, version,
        items: [{ id: 'turn-a', completed: true, status: 'completed', terminalRevision: 1, answer: text }],
      });
      const reply = (message, result) => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'agenthub:control-result', id: message.id, ok: true, result },
      })));
      const seen = [];
      window.heldAHistory = {
        seen,
        release: () => reply(seen[0], { ...sampleHistory('Old A', 'old-a'), notModified: true }),
      };
      window.__agentHubVscode.postMessage = message => {
        if (message.params?.streamId !== 'stream-a') return post(message);
        if (message.action === 'open-task') {
          reply(message, { history: sampleHistory('Opened A while refresh was held', 'old-a') });
          return;
        }
        if (message.action !== 'task-history') return post(message);
        seen.push(message);
        if (seen.length === 1) return;
        reply(message, message.params.refreshSource
          ? sampleHistory('Fresh history from A source', 'new-a')
          : { ...sampleHistory('Old A', 'old-a'), notModified: true });
      };
    });
    // Reopening a retained tab dispatches its ordinary read. Hold it while two
    // independent callers request the next read for A.
    await a.click();
    await page.waitForFunction(() => window.heldAHistory.seen.length === 1);
    const completedAt = new Date().toISOString();
    const changed = {
      ...initial, version: 'a-visible-column-change',
      tasks: initial.tasks.map(task => task.streamId === 'stream-a' ? {
        ...task, unread: true, lastAnswerAt: completedAt, lastAnswerTurnId: 'new-turn-a',
        latestFinal: { provider: 'codex', threadId: 'thread-a', turnId: 'new-turn-a', revision: 1, completedAt },
      } : task),
    };
    await applyFixtureSnapshot(page, changed);
    await page.locator('[data-stream-task-id="stream-a"][data-answer-ready]:visible').first().waitFor();
    await page.evaluate(() => {
      history.replaceState(null, '', '#/chat/stream/stream-a');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await page.getByText('Opened A while refresh was held', { exact: true }).first().waitFor();
    await b.click();
    await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-b');
    await a.click();
    await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-a');
    await page.evaluate(() => window.heldAHistory.release());
    await page.waitForFunction(() => window.heldAHistory.seen.length >= 2);
    assert.equal(await page.evaluate(() => window.heldAHistory.seen[1].params.refreshSource), true);
    await page.getByText('Fresh history from A source', { exact: true }).first().waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
