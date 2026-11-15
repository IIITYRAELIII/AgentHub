import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser, openFixture, submit } from './composer-production.fixture.mjs';

test('accepted send reconciles its unchanged history once after snapshot synchronization', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const history = { provider: 'codex', threadId: 'thread-a', streamId: 'stream-a',
      start: 0, end: 20, total: 20, nextBefore: null, version: 'retained-page',
      items: Array.from({ length: 20 }, (_, index) => ({ id: `retained-${index}`, completed: true,
        terminalRevision: 1, status: 'completed', prompt: `Retained prompt ${index}`,
        answer: `Retained answer ${index} ` + 'paragraph '.repeat(500) })) };
    const errors = await openFixture(page, { fixtureHistory: history });
    await page.getByText('Retained prompt 19', { exact: true }).waitFor();
    await page.evaluate(() => {
      const probe = window.__sendProjection = { calls: [], phase: 'idle', done: false, snapshots: 0, sends: 0 };
      const setMessages = window.AgentHub.setMessages;
      window.AgentHub.setMessages = function(id, messages) {
        const started = performance.now();
        const result = setMessages.call(this, id, messages);
        if (probe.phase === 'synchronize') probe.calls.push({ id, count: messages.length,
          elapsedMs: performance.now() - started });
        return result;
      };
      const run = window.AgentHubMessageSendTransaction.run;
      window.AgentHubMessageSendTransaction.run = options => run({ ...options,
        synchronize: async result => {
          probe.phase = 'synchronize';
          try { await options.synchronize(result); }
          finally { probe.phase = 'idle'; probe.done = true; }
        },
      });
      const post = window.__agentHubVscode.postMessage;
      const respond = (message, result) => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'agenthub:control-result', id: message.id, ok: true, result },
      })));
      window.__agentHubVscode.postMessage = message => {
        if (message.action === 'task-history') return; // isolate the post-receipt synchronization, not a later page
        if (message.action === 'snapshot') {
          probe.snapshots += 1;
          respond(message, { notModified: true, version: window.__agentHubFixture.snapshot.version });
          return;
        }
        if (message.action === 'send-message') {
          probe.sends += 1;
          probe.clientUserMessageId = message.params.clientUserMessageId;
          respond(message, { accepted: true, provider: message.params.provider, threadId: message.params.threadId,
            streamId: message.params.streamId, clientUserMessageId: message.params.clientUserMessageId,
            itemId: `item-${message.params.clientUserMessageId}` });
          return;
        }
        post(message);
      };
    });
    await submit(page, { text: 'New exact command' });
    await page.waitForFunction(() => window.__sendProjection.done);
    const result = await page.evaluate(() => window.__sendProjection);
    assert.equal(result.sends, 1);
    assert.ok(result.snapshots > 0);
    assert.equal(result.calls.length, 1, 'unchanged canonical history must not be reconciled twice in one synchronization');
    assert.equal(await page.getByText('New exact command', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Retained prompt 19', { exact: true }).count(), 1);
    assert.equal(await page.locator('[data-composer-input]').inputValue(), '');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ synchronizedProjections: result.calls.length,
      renderedMessages: result.calls[0]?.count, projectionMs: result.calls.reduce((sum, call) => sum + call.elapsedMs, 0) }));
  } finally { await browser.close(); }
});
