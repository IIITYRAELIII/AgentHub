import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot } from './composer-production.fixture.mjs';

const fullHistory = {
  provider: 'codex', threadId: 'thread-a', streamId: 'stream-a',
  start: 0, end: 2, total: 2, messageTotal: 4, nextBefore: null, version: 'full-page',
  items: [1, 2].map(n => ({ id: `turn-${n}`, completed: true, terminalRevision: 1,
    startedAt: '2026-10-01T10:00:00.000Z',
    messages: [
      { role: 'user', itemId: `user-${n}`, clientUserMessageId: `client-${n}`, text: `Question ${n}`, time: '2026-10-01T10:00:00.000Z' },
      { role: 'agent', itemId: `final-${n}`, phase: 'final', text: `Answer ${n}`, time: '2026-10-01T10:00:00.000Z' },
    ] })),
};

async function fixtureOptions(fixtureSnapshot) {
  return { fixtureSnapshot,
    ...(process.env.AGENT_HUB_HISTORY_WEB_ROOT ? {
      webAppRoot: pathToFileURL(`${process.env.AGENT_HUB_HISTORY_WEB_ROOT.replaceAll('\\', '/')}/`),
      assetOverrides: process.env.AGENT_HUB_HISTORY_BASELINE === '1' ? {} : {
        'hub-client.js': await readFile(process.env.AGENT_HUB_HISTORY_CLIENT_FILE
          ?? new URL('../../assets/web-app/hub-client.js', import.meta.url)),
      },
    } : {}),
  };
}

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function holdHistory(page) {
  await page.addInitScript(() => {
    const held = [];
    window.__heldHistory = held;
    let bridge;
    Object.defineProperty(window, '__agentHubVscode', {
      configurable: true, get: () => bridge,
      set(value) {
        bridge = { ...value, postMessage(message) {
          if (['open-task', 'task-history'].includes(message.action)
            && message.params.streamId === 'stream-a') {
            held.push({ message, receivedAt: performance.now() });
          } else value.postMessage(message);
        } };
      },
    });
    window.__deliverHistory = ({ index, history }) => {
      const request = held[index].message;
      held[index].releasedAt = performance.now();
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'agenthub:control-result', id: request.id, ok: true,
        result: request.action === 'open-task'
          ? { history, snapshot: null, snapshotDeferred: true } : history,
      } }));
    };
  });
}

test('snapshot refreshes cannot starve a valid in-flight first history page', { timeout: 30000 }, async t => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const batches = [];
    page.on('request', request => {
      if (request.url().endsWith('/api/command-trace/client-events')) batches.push(request.postDataJSON());
    });
    await holdHistory(page);
    const initial = snapshot([{ provider: 'codex', threadId: 'thread-a', streamId: 'stream-a',
      clientUserMessageId: 'client-2', accepted: true, conflictKind: 'message-intake',
      clientProjectionIntent: 'conversation', displayText: 'Question 2',
      submittedAt: '2026-10-01T10:00:00.000Z' }]);
    const errors = await openFixture(page, await fixtureOptions(initial));
    await page.waitForFunction(() => window.__heldHistory.some(x => x.message.action === 'open-task'));
    // A slow navigation is still outstanding. Snapshot notifications request
    // the same exact history through the existing background single flight.
    await applyFixtureSnapshot(page, { ...initial, version: 'notification-1' });
    await page.waitForFunction(() => window.__heldHistory.some(x => x.message.action === 'task-history'));
    const index = await page.evaluate(() => window.__heldHistory.findIndex(x => x.message.action === 'task-history'));
    assert.ok((await page.locator('[data-chat-log]').innerText()).includes('Question 2'), 'receipt projection remains visible before canonical history');
    const loading = await page.locator('[data-history-loader]').getAttribute('data-loading');
    for (let n = 2; n <= 4; n += 1) {
      await applyFixtureSnapshot(page, { ...initial, version: `notification-${n}` });
      await frames(page);
    }
    await page.evaluate(({ index, history }) => window.__deliverHistory({ index, history }), { index, history: fullHistory });
    let painted = false;
    try {
      await page.waitForFunction(() => document.querySelector('[data-chat-log]')?.textContent.includes('Answer 2'), null, { timeout: 1500 });
      painted = true;
    } finally {
      const measurement = await page.evaluate(index => ({
        releasedAt: window.__heldHistory[index].releasedAt, observedAt: performance.now(),
        requests: window.__heldHistory.map(x => ({ action: x.message.action, traceId: x.message.params.clientTraceId,
          receivedAt: x.receivedAt, releasedAt: x.releasedAt })),
        messages: [...document.querySelectorAll('[data-chat-log] [data-role]')].map(n => ({
          id: n.dataset.messageId, role: n.dataset.role, turnId: n.dataset.turnId,
        })),
      }), index);
      t.diagnostic(JSON.stringify({ painted, loading: loading !== null, ...measurement }));
      if (process.env.AGENT_HUB_HISTORY_EVIDENCE_DIR) {
        await mkdir(process.env.AGENT_HUB_HISTORY_EVIDENCE_DIR, { recursive: true });
        await writeFile(path.join(process.env.AGENT_HUB_HISTORY_EVIDENCE_DIR, 'progress.json'), JSON.stringify({ painted, loading: loading !== null, ...measurement }, null, 2));
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_HISTORY_EVIDENCE_DIR, 'progress.png') });
      }
    }
    assert.notEqual(loading, null, 'an incomplete initial projection is visibly loading');
    assert.equal(await page.locator('[data-history-loader]').getAttribute('data-loading'), null,
      'the admitted canonical page clears initial loading while the follow-up is held');
    const ids = await page.locator('[data-chat-log] [data-message-id]').evaluateAll(nodes => nodes.map(n => n.dataset.messageId));
    assert.equal(new Set(ids).size, ids.length, 'same-page notifications do not duplicate canonical identities');
    const text = await page.locator('[data-chat-log]').innerText();
    assert.ok(text.indexOf('Question 1') < text.indexOf('Answer 1'));
    assert.ok(text.indexOf('Answer 1') < text.indexOf('Question 2'));
    assert.ok(text.indexOf('Question 2') < text.indexOf('Answer 2'));
    await frames(page);
    const traceId = await page.evaluate(index => window.__heldHistory[index].message.params.clientTraceId, index);
    await page.waitForFunction(() => window.AgentHubCommandTrace.diagnostics().pending === 0);
    const events = batches.flatMap(batch => batch.events);
    assert.ok(events.some(e => e.commandId === traceId && e.metadata?.action === 'history-queue'));
    assert.ok(events.some(e => e.commandId === traceId && e.metadata?.action === 'history-page-paint'
      && e.outcome === 'succeeded' && e.metadata?.render === 'viewport' && e.metadata?.count === 2));
    assert.ok(!JSON.stringify(events).includes('Question 1'), 'telemetry never includes message text');
    assert.deepEqual(errors, []);
  } finally { await page.close(); await browser.close(); }
});

test('warm history refresh paints new canonical messages despite repeated final notifications', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await holdHistory(page);
    const initial = snapshot();
    const errors = await openFixture(page, await fixtureOptions(initial));
    await page.waitForFunction(() => window.__heldHistory.some(x => x.message.action === 'open-task'));
    const firstPage = { ...fullHistory, end: 1, total: 1, messageTotal: 2, items: fullHistory.items.slice(0, 1), version: 'old-page' };
    await page.evaluate(history => window.__deliverHistory({ index: 0, history }), firstPage);
    await page.waitForFunction(() => document.querySelector('[data-chat-log]')?.textContent.includes('Answer 1'));
    await page.waitForFunction(() => window.__heldHistory.some(x => x.message.action === 'task-history'));
    const index = await page.evaluate(() => window.__heldHistory.findIndex(x => x.message.action === 'task-history'));
    for (let n = 1; n <= 3; n += 1) {
      const next = structuredClone(initial);
      next.version = `warm-notification-${n}`;
      // Re-observation of the same final changes the old timestamp projection,
      // not the provider/Thread binding or the returned canonical page.
      next.tasks[0].lastAnswerAt = `2026-10-01T10:00:0${n}.000Z`;
      await applyFixtureSnapshot(page, next);
      await frames(page);
    }
    await page.evaluate(({ index, history }) => window.__deliverHistory({ index, history }), { index, history: fullHistory });
    await page.waitForFunction(() => document.querySelector('[data-chat-log]')?.textContent.includes('Answer 2'), null, { timeout: 1500 });
    const messages = await page.locator('[data-chat-log] [data-role]').evaluateAll(nodes => nodes.map(n => n.dataset.messageId));
    assert.equal(messages.length, 4);
    assert.equal(new Set(messages).size, 4);
    assert.deepEqual(errors, []);
  } finally { await page.close(); await browser.close(); }
});

test('rotation still rejects an old Thread reply and admits the current Thread page', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await holdHistory(page);
    const initial = snapshot();
    const errors = await openFixture(page, await fixtureOptions(initial));
    await applyFixtureSnapshot(page, { ...initial, version: 'old-binding-read' });
    await page.waitForFunction(() => window.__heldHistory.some(x => x.message.action === 'task-history'));
    const index = await page.evaluate(() => window.__heldHistory.findIndex(x => x.message.action === 'task-history'));
    const rotated = structuredClone(initial);
    rotated.version = 'new-binding';
    rotated.tasks[0].threadId = 'thread-next';
    rotated.workspaces[0].streams[0].threads.push({ id: 'thread-next' });
    rotated.selected.threadId = 'thread-next';
    await applyFixtureSnapshot(page, rotated);
    await frames(page);
    await page.evaluate(({ index, history }) => window.__deliverHistory({ index, history }), { index, history: fullHistory });
    await page.waitForFunction(() => window.__heldHistory.some(x => x.message.action === 'task-history' && x.message.params.threadId === 'thread-next'));
    await frames(page);
    assert.equal(await page.locator('[data-chat-log] [data-role="agent"]').count(), 0, 'foreign old binding never paints');
    const nextIndex = await page.evaluate(() => window.__heldHistory.findIndex(x => x.message.action === 'task-history' && x.message.params.threadId === 'thread-next'));
    await page.evaluate(({ index, history }) => window.__deliverHistory({ index, history }), {
      index: nextIndex, history: { ...fullHistory, threadId: 'thread-next', version: 'rotated-page' },
    });
    await page.waitForFunction(() => document.querySelector('[data-chat-log]')?.textContent.includes('Answer 2'), null, { timeout: 1500 });
    assert.deepEqual(await page.locator('[data-chat-log] [data-role="agent"]').evaluateAll(nodes => [...new Set(nodes.map(n => n.dataset.threadId))]), ['thread-next']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); await browser.close(); }
});

for (const notificationTiming of ['before', 'during']) {
  test(`explicit older-page intent survives background notification queued ${notificationTiming} pagination`, { timeout: 30000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await holdHistory(page);
      const initial = snapshot();
      const errors = await openFixture(page, await fixtureOptions(initial));
      await page.waitForFunction(() => window.__heldHistory.some(x => x.message.action === 'open-task'));
      const open = await page.evaluate(() => window.__heldHistory.findIndex(x => x.message.action === 'open-task'));
      const historyPage = (start, end) => ({
        ...fullHistory, start, end, total: 22, messageTotal: 44, nextBefore: start || null,
        version: `page-${start}-${end}`,
        items: Array.from({ length: end - start }, (_, index) => {
          const n = start + index + 1;
          return { ...fullHistory.items[0], id: `turn-${n}`, messages: [
            { ...fullHistory.items[0].messages[0], itemId: `user-${n}`,
              clientUserMessageId: `client-${n}`, text: `Question ${n}. ${'content '.repeat(80)}` },
            { ...fullHistory.items[0].messages[1], itemId: `final-${n}`,
              text: `Answer ${n}. ${'content '.repeat(80)}` },
          ] };
        }),
      });
      const latest = historyPage(20, 22);
      await page.evaluate(({ index, history }) => window.__deliverHistory({ index, history }), { index: open, history: latest });
      await page.waitForFunction(() => document.querySelector('[data-chat-log]')?.textContent.includes('Answer 22.'));
      await page.waitForFunction(() => window.__heldHistory.some(x => x.message.action === 'task-history' && x.message.params.before == null));
      const background = await page.evaluate(() => window.__heldHistory.findIndex(x => x.message.action === 'task-history' && x.message.params.before == null));
      const notify = async () => {
        const next = structuredClone(initial);
        next.version = `pagination-${notificationTiming}`;
        next.tasks[0].lastAnswerAt = '2026-10-02T10:00:00.000Z';
        await applyFixtureSnapshot(page, next);
        await frames(page);
      };
      if (notificationTiming === 'before') await notify();
      await page.locator('[data-history-load]').click();
      await page.waitForFunction(() => window.__heldHistory.some(x => x.message.params.before === 20));
      const older = await page.evaluate(() => window.__heldHistory.findIndex(x => x.message.params.before === 20));
      if (notificationTiming === 'during') await notify();
      // Finish A so the single flight can process queued B. B may be dropped as
      // obsolete; the newer explicit request must still admit its valid page.
      await page.evaluate(({ index, history }) => window.__deliverHistory({ index, history }), { index: background, history: latest });
      await frames(page);
      await page.evaluate(({ index, history }) => window.__deliverHistory({ index, history }), { index: older, history: historyPage(0, 20) });
      await page.waitForFunction(() => document.querySelector('[data-chat-log]')?.textContent.includes('Answer 1.'), null, { timeout: 1500 });
      const messages = await page.locator('[data-chat-log] [data-role]').evaluateAll(nodes => nodes.map(n => n.dataset.messageId));
      assert.equal(messages.length, 44);
      assert.equal(new Set(messages).size, 44);
      const text = await page.locator('[data-chat-log]').innerText();
      assert.ok(text.indexOf('Answer 1.') < text.indexOf('Question 21.'));
      assert.equal(await page.locator('[data-history-loader]').getAttribute('data-loading'), null);
      assert.deepEqual(errors, []);
    } finally { await page.close(); await browser.close(); }
  });
}
