import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot } from './composer-production.fixture.mjs';

function readySnapshot(revision = 1) {
  const next = snapshot();
  next.version = `ready-${revision}`;
  next.tasks = next.tasks.map((entry) => entry.streamId === 'stream-b' ? {
    ...entry, unread: true, lastAnswerAt: '2026-10-06T07:00:00.000Z',
    latestFinal: { provider: 'codex', threadId: 'thread-b', turnId: 'final-turn', revision,
      completedAt: '2026-10-06T07:00:00.000Z' },
  } : entry);
  return next;
}

async function readFixture(page, next = readySnapshot()) {
  const diagnostics = await openFixture(page, { fixtureSnapshot: next });
  await page.waitForFunction(() => document.documentElement.dataset.connection === 'online');
  await page.evaluate(() => {
    window.__readRequests = [];
    window.__readTrace = [];
    window.AgentHubCommandTrace.bindReporter(async (batch) => window.__readTrace.push(...batch.events));
    window.__readMode = 'success';
    const original = window.__agentHubVscode.postMessage;
    const respond = (message, result) => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'agenthub:control-result', id: message.id, ok: true, result },
    })));
    window.__agentHubVscode.postMessage = (message) => {
      const historyTask = window.__agentHubFixture.snapshot.tasks.find((entry) => (
        (!message.params?.provider || entry.provider === message.params.provider) && entry.threadId === message.params?.threadId
      ));
      if (['open-task', 'task-history'].includes(message.action) && historyTask?.latestFinal) {
        if (window.__historyMode === 'hold') return;
        const final = historyTask.latestFinal;
        const history = { provider: historyTask.provider, threadId: historyTask.threadId, streamId: historyTask.streamId,
          items: [{ id: final.turnId, completed: true, status: 'completed', terminalRevision: final.revision,
            answer: `Exact final revision ${final.revision}`, completedAt: final.completedAt }],
          start: 0, end: 1, total: 1, messageTotal: 1, nextBefore: null, version: `history-${final.revision}` };
        respond(message, message.action === 'open-task' ? {
          history, snapshot: window.__historyOnly ? null : window.__agentHubFixture.snapshot,
        } : history);
        return;
      }
      if (message.action === 'mark-task-read') {
        window.__readRequests.push(message);
        if (window.__readMode === 'hold') return;
        if (window.__readMode === 'unconfirmed') {
          if (window.__holdFirstRead && message.params.streamId === 'stream-capacity-0') return;
          respond(message, { marked: false, reason: 'unconfirmed' });
          return;
        }
        if (window.__readMode === 'fail-once') {
          window.__readMode = 'success';
          queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'agenthub:control-result', id: message.id, ok: false, error: 'Fixture response lost',
          } })));
          return;
        }
        const final = message.params.final;
        respond(message, { marked: true, final, cursor: {
          answerAtMs: Date.parse(final.completedAt), answerTurnId: final.turnId, answerRevision: final.revision,
        } });
        return;
      }
      original(message);
    };
  });
  return diagnostics;
}

async function selectReady(page) {
  await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
  await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-b');
  await page.waitForFunction(() => window.__readRequests.length > 0);
}

async function markerState(page) {
  return page.evaluate(() => ({
    tab: document.querySelector('[data-stream-task-id="stream-b"]')?.hasAttribute('data-answer-ready'),
    card: document.querySelector('[data-activity-task-id="stream-b"]')?.hasAttribute('data-answer-ready') ?? false,
  }));
}

test('confirmed exact read cannot be resurrected by a late unread snapshot on either surface', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const next = readySnapshot();
    await readFixture(page, next);
    assert.equal(await page.evaluate(() => window.__readRequests.length), 0, 'snapshot before terminal history is not read evidence');
    await selectReady(page);
    await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]')?.hasAttribute('data-answer-ready'));
    assert.deepEqual(await markerState(page), { tab: false, card: false });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(async () => {
      for (let index = 0; index < 12 && window.AgentHubCommandTrace.diagnostics().pending; index += 1) await window.AgentHubCommandTrace.flush();
    });
    const events = await page.evaluate(() => window.__readTrace);
    const viewed = events.find((entry) => entry.metadata?.action === 'read-marker-view' && entry.metadata.render === 'viewed');
    const cleared = events.find((entry) => entry.metadata?.action === 'read-marker-clear' && entry.outcome === 'succeeded');
    assert.ok(viewed && cleared);
    assert.equal(viewed.commandId, cleared.commandId);
    assert.equal(cleared.metadata.terminalRevision, 1);
    assert.equal(cleared.metadata.codeMarker, 'hub291.read-marker.3');
    assert.equal(cleared.metadata.tabReady, false);
    assert.equal(cleared.metadata.cardReady, false);
    assert.ok(cleared.monotonicDurationMs < 1000, 'isolated ack-to-paint should finish without polling delay');
    console.log('read-marker isolated timings', JSON.stringify({ viewAt: viewed.observedAtMs,
      clearAt: cleared.observedAtMs, viewToClearMs: cleared.monotonicDurationMs }));
    if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
      await mkdir(process.env.AGENT_HUB_UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, 'read-marker-desktop-cleared.png') });
    }
    await applyFixtureSnapshot(page, { ...next, version: 'late-unread' });
    await page.waitForFunction(() => document.documentElement.dataset.connection === 'online');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await markerState(page), { tab: false, card: false });
  } finally { await page.close(); await browser.close(); }
});

test('lost reply times out and retries only the same acknowledgement identity', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await readFixture(page);
    await page.evaluate(() => {
      window.__readMode = 'hold';
      const nativeTimeout = window.setTimeout;
      const nativeClear = window.clearTimeout;
      const original = window.__agentHubVscode.postMessage;
      let lastDeadline;
      window.setTimeout = (callback, ms, ...args) => {
        const id = nativeTimeout(callback, ms, ...args);
        if (ms === 45000) lastDeadline = { id, callback };
        return id;
      };
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === 'mark-task-read' && !window.__droppedReadReply) {
          window.__droppedReadReply = true;
          const deadline = lastDeadline;
          nativeClear(deadline.id);
          nativeTimeout(() => { window.__readTimeoutFired = true; deadline.callback(); }, 60);
        }
        original(message);
      };
    });
    await selectReady(page);
    await page.waitForFunction(() => window.__readTimeoutFired);
    await page.evaluate(async () => {
      await window.AgentHubCommandTrace.flush();
      window.__readMode = 'success';
      document.querySelector('[data-provider-connection-retry]').click();
    });
    await page.waitForFunction(() => window.__readRequests.length === 2);
    assert.equal(await page.evaluate(() => window.__readRequests[0].params.clientTraceId), await page.evaluate(() => window.__readRequests[1].params.clientTraceId));
    await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute('data-answer-ready'));
    await page.evaluate(async () => {
      for (let index = 0; index < 12 && window.AgentHubCommandTrace.diagnostics().pending; index += 1) await window.AgentHubCommandTrace.flush();
    });
    assert.ok(await page.evaluate(() => window.__readTrace.some((event) => event.metadata?.action === 'mark-task-read'
      && event.outcome === 'failed' && event.metadata.failureKind === 'timeout')));
  } finally { await page.close(); await browser.close(); }
});

test('old read reply arriving during a new active turn preserves running projection', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await readFixture(page);
    await page.evaluate(() => { window.__readMode = 'hold'; window.__historyMode = undefined; });
    await selectReady(page);
    await page.evaluate(() => { window.__historyMode = 'hold'; });
    const active = readySnapshot();
    active.version = 'running-before-ack';
    active.tasks = active.tasks.map((entry) => entry.streamId === 'stream-b' ? { ...entry, running: true,
      run: { turnId: 'new-active', operationKind: 'user-turn', projectionState: 'active', startedAt: '2026-10-06T07:01:00.000Z' } } : entry);
    await applyFixtureSnapshot(page, active);
    await page.waitForFunction(() => document.querySelector('[data-activity-task-id="stream-b"]')?.hasAttribute('data-running'));
    await page.evaluate(() => {
      const message = window.__readRequests[0];
      const final = message.params.final;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'agenthub:control-result', id: message.id, ok: true,
        result: { marked: true, final, cursor: { answerAtMs: Date.parse(final.completedAt),
          answerTurnId: final.turnId, answerRevision: final.revision } } } }));
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('[data-activity-task-id="stream-b"]').evaluate((node) => node.hasAttribute('data-running')), true);
  } finally { await page.close(); await browser.close(); }
});

test('same-Stream new revision before paint cannot acknowledge the obsolete final', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await readFixture(page);
    await holdFrames(page);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.getByText('Exact final revision 1', { exact: true }).waitFor();
    await page.evaluate(() => { window.__historyMode = 'hold'; });
    await applyFixtureSnapshot(page, readySnapshot(2));
    await page.evaluate(() => window.__releaseFrames());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__readRequests.length), 0);
    assert.deepEqual(await markerState(page), { tab: true, card: true });
  } finally { await page.close(); await browser.close(); }
});

test('hidden document becomes read after visibility return without reopening the Stream', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await readFixture(page);
    await page.evaluate(() => {
      window.__fixtureVisible = false;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__fixtureVisible ? 'visible' : 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => !window.__fixtureVisible });
    });
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.getByText('Exact final revision 1', { exact: true }).waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__readRequests.length), 0);
    assert.deepEqual(await markerState(page), { tab: true, card: true });
    await page.evaluate(() => { window.__fixtureVisible = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.__readRequests.length === 1);
    await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute('data-answer-ready'));
  } finally { await page.close(); await browser.close(); }
});

test('persisted cursor learned from a snapshot settles a lost reply and survives later raw unread', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await readFixture(page);
    await page.evaluate(() => { window.__readMode = 'hold'; });
    await selectReady(page);
    const committed = readySnapshot();
    committed.version = 'server-read-persisted';
    committed.tasks = committed.tasks.map((entry) => entry.streamId === 'stream-b' ? { ...entry, unread: false,
      readCursor: { answerAtMs: Date.parse(entry.latestFinal.completedAt),
        answerTurnId: entry.latestFinal.turnId, answerRevision: entry.latestFinal.revision } } : entry);
    await applyFixtureSnapshot(page, committed);
    await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute('data-answer-ready'));
    await applyFixtureSnapshot(page, { ...readySnapshot(), version: 'late-before-server-read' });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await markerState(page), { tab: false, card: false });
    assert.equal(await page.evaluate(() => window.__readRequests.length), 1);
  } finally { await page.close(); await browser.close(); }
});

test('late prior-revision acknowledgement cannot clear a new unread revision or active run', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await readFixture(page);
    await page.evaluate(() => { window.__readMode = 'hold'; });
    await selectReady(page);
    await page.evaluate(() => { window.__historyMode = 'hold'; });
    const next = readySnapshot(2);
    await applyFixtureSnapshot(page, next);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      const message = window.__readRequests[0];
      const final = message.params.final;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'agenthub:control-result',
        id: message.id, ok: true, result: { marked: true, final, cursor: {
          answerAtMs: Date.parse(final.completedAt), answerTurnId: final.turnId, answerRevision: final.revision,
        } } } }));
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await markerState(page), { tab: true, card: true });
    assert.equal(await page.evaluate(() => window.__readRequests.length), 1);
    const active = readySnapshot(2);
    active.version = 'new-running';
    active.tasks = active.tasks.map((entry) => entry.streamId === 'stream-b' ? { ...entry, running: true,
      run: { turnId: 'active-next', operationKind: 'user-turn', projectionState: 'active',
        startedAt: '2026-10-06T07:01:00.000Z' } } : entry);
    await applyFixtureSnapshot(page, active);
    await page.waitForFunction(() => document.querySelector('[data-activity-task-id="stream-b"]')?.hasAttribute('data-running'));
  } finally { await page.close(); await browser.close(); }
});

async function holdFrames(page) {
  await page.evaluate(() => {
    const nativeRequest = window.requestAnimationFrame;
    const nativeCancel = window.cancelAnimationFrame;
    const pending = new Map();
    let sequence = 1000000;
    window.requestAnimationFrame = (callback) => { pending.set(++sequence, callback); return sequence; };
    window.cancelAnimationFrame = (id) => { if (!pending.delete(id)) nativeCancel(id); };
    window.__releaseFrames = () => {
      window.requestAnimationFrame = nativeRequest;
      window.cancelAnimationFrame = nativeCancel;
      for (const callback of pending.values()) nativeRequest(callback);
      pending.clear();
    };
  });
}

test('navigation before paint does not acknowledge a final from the old Stream', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await readFixture(page);
    await holdFrames(page);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.getByText('Exact final revision 1', { exact: true }).waitFor();
    await page.locator('[data-stream-task-id="stream-a"]:visible').first().click();
    await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-a');
    await page.evaluate(() => window.__releaseFrames());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__readRequests.length), 0);
    assert.deepEqual(await markerState(page), { tab: true, card: true });
  } finally { await page.close(); await browser.close(); }
});

test('retry of an unconfirmed acknowledgement uses the original ID on unchanged reconnect snapshot', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await readFixture(page);
    await page.evaluate(() => { window.__readMode = 'fail-once'; });
    await selectReady(page);
    await page.waitForFunction(() => window.__readTrace.some((event) => event.metadata?.action === 'mark-task-read' && event.outcome === 'failed')
      || window.AgentHubCommandTrace.diagnostics().pending > 0);
    await page.evaluate(() => {
      const original = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === 'snapshot') {
          queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'agenthub:control-result', id: message.id, ok: true, result: { notModified: true },
          } })));
          return;
        }
        original(message);
      };
      document.querySelector('[data-provider-connection-retry]').click();
    });
    await page.waitForFunction(() => window.__readRequests.length === 2);
    assert.equal(await page.evaluate(() => window.__readRequests[0].params.clientTraceId), await page.evaluate(() => window.__readRequests[1].params.clientTraceId));
    await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute('data-answer-ready'));
  } finally { await page.close(); await browser.close(); }
});

test('diagnostic paint saturation cannot block read admission; mobile clears both marker surfaces', { timeout: 20000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const diagnostics = await readFixture(page);
    await page.locator('[data-mobile-button="chat"]').click();
    await holdFrames(page);
    await page.evaluate(() => {
      for (let index = 0; index < 40; index += 1) window.AgentHubCommandTrace.afterPaint('ui-render', 'saturation',
        performance.now(), 'saturation-' + index);
    });
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.getByText('Exact final revision 1', { exact: true }).waitFor();
    await page.evaluate(() => window.__releaseFrames());
    await page.waitForFunction(() => window.__readRequests.length === 1);
    await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute('data-answer-ready'));
    assert.deepEqual(await markerState(page), { tab: false, card: false });
    assert.ok(await page.evaluate(() => window.AgentHubCommandTrace.diagnostics().droppedCount) > 0);
    assert.deepEqual(diagnostics, []);
    if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
      await mkdir(process.env.AGENT_HUB_UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, 'read-marker-mobile-cleared.png') });
    }
  } finally { await page.close(); await browser.close(); }
});

for (const pending of [false, true]) {
  test(`257 canonical finals preserve ${pending ? 'pending single-flight and' : 'unconfirmed'} original read identity`, { timeout: 120000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    try {
      const next = readySnapshot();
      const template = next.tasks.find((entry) => entry.streamId === 'stream-b');
      const finals = Array.from({ length: 257 }, (_, index) => ({
        ...template, streamId: `stream-capacity-${index}`, threadId: `thread-capacity-${index}`,
        streamName: `Capacity ${index}`, streamDisplayName: `Capacity ${index}`, streamOrdinal: index + 2,
        latestFinal: { ...template.latestFinal, threadId: `thread-capacity-${index}`, turnId: `final-capacity-${index}` },
      }));
      next.tasks = [next.tasks[0], ...finals];
      next.workspaces[0].streams = [next.workspaces[0].streams[0], ...finals.map((entry) => ({
        id: entry.streamId, name: entry.streamName, displayName: entry.streamDisplayName,
        ordinal: entry.streamOrdinal, threads: [{ id: entry.threadId }],
      }))];
      await readFixture(page, next);
      await page.evaluate(async (holdFirst) => {
        window.__readMode = 'unconfirmed';
        window.__holdFirstRead = holdFirst;
        window.__historyOnly = true;
        // Hold the first request genuinely pending across slow 257-card DOM
        // navigation; ordinary deadline behavior is covered by the timeout case.
        if (holdFirst) {
          const nativeTimeout = window.setTimeout;
          const nativeClear = window.clearTimeout;
          const original = window.__agentHubVscode.postMessage;
          let deadline;
          window.setTimeout = (callback, ms, ...args) => {
            const id = nativeTimeout(callback, ms, ...args);
            if (ms === 45000) deadline = { id, callback };
            return id;
          };
          window.__agentHubVscode.postMessage = (message) => {
            if (message.action === 'mark-task-read' && message.params.streamId === 'stream-capacity-0') {
              nativeClear(deadline.id);
              nativeTimeout(() => { window.__firstReadDeadlineFired = true; deadline.callback(); }, 180000);
            }
            original(message);
          };
        }
        const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        for (let index = 0; index < 257; index += 1) {
          const id = `stream-capacity-${index}`;
          document.querySelector(`[data-stream-task-id="${id}"]`).click();
          // Wait for the actual shipped history application and admission, not an extracted callback.
          while (!window.__readRequests.some((message) => message.params.streamId === id)) await paint();
          await paint();
        }
      }, pending);
      const firstId = await page.evaluate(() => window.__readRequests[0].params.clientTraceId);
      if (!pending) {
        const withoutFinal = { ...next, version: 'capacity-final-unknown', tasks: next.tasks.map((entry) => (
          entry.streamId === 'stream-capacity-0' ? { ...entry, latestFinal: null } : entry
        )) };
        await applyFixtureSnapshot(page, withoutFinal);
        await applyFixtureSnapshot(page, { ...next, version: 'capacity-final-restored' });
      }
      await page.evaluate(() => document.querySelector('[data-stream-task-id="stream-capacity-0"]').click());
      await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-capacity-0');
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      if (pending) {
        assert.equal(await page.evaluate(() => window.__firstReadDeadlineFired === true), false,
          'the single-flight assertion runs before the held request deadline');
        assert.equal(await page.evaluate(() => window.__readRequests.filter((message) => message.params.streamId === 'stream-capacity-0').length), 1,
          'returning to a pending final cannot admit a second concurrent request');
        await page.evaluate(() => {
          const message = window.__readRequests[0];
          window.__holdFirstRead = false;
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'agenthub:control-result', id: message.id,
            ok: true, result: { marked: false, reason: 'unconfirmed' } } }));
        });
        await page.evaluate(() => document.querySelector('[data-stream-task-id="stream-capacity-256"]').click());
        await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-capacity-256');
        await page.evaluate(() => document.querySelector('[data-stream-task-id="stream-capacity-0"]').click());
      }
      await page.waitForFunction(() => window.__readRequests.filter((message) => message.params.streamId === 'stream-capacity-0').length >= 2);
      const retriedId = await page.evaluate(() => window.__readRequests.filter((message) => message.params.streamId === 'stream-capacity-0')[1].params.clientTraceId);
      assert.equal(retriedId, firstId, 'current unresolved exact final retains its original operation ID past 256 entries');
    } finally { await page.close(); await browser.close(); }
  });
}
