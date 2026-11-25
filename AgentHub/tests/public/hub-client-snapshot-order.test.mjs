import assert from 'node:assert/strict';
import test from 'node:test';
import {
  launchBrowser, openFixture, snapshot, applyFixtureSnapshot,
} from './composer-production.fixture.mjs';


async function holdSelectionSnapshot(page) {
  await page.evaluate(() => {
    const original = window.__agentHubVscode.postMessage;
    let selectionRequested = false;
    window.__agentHubVscode.postMessage = message => {
      if (message.action === 'select-task' && message.params.streamId === 'stream-b') selectionRequested = true;
      if (selectionRequested && message.action === 'snapshot' && !window.__heldSelectionSnapshot) {
        window.__heldSelectionSnapshot = message;
        return;
      }
      original(message);
    };
  });
}

async function warmSelectionPage(page) {
  await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
  await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-b');
  await page.locator('[data-stream-task-id="stream-a"]:visible').first().click();
  await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-a');
}

async function applySelectionSnapshot(page, snapshot) {
  await page.evaluate(value => {
    window.__agentHubFixture.snapshot = value;
    document.querySelector('[data-stream-task-id="stream-b"]').click();
  }, snapshot);
}

test('late selection-triggered snapshot cannot replace a newer active run', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const idle = snapshot();
    await openFixture(page, { fixtureSnapshot: idle });
    await holdSelectionSnapshot(page);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.waitForFunction(() => Boolean(window.__heldSelectionSnapshot));
    const active = snapshot();
    active.version = 'active-run';
    active.tasks = active.tasks.map((item) => item.streamId === 'stream-b'
      ? { ...item, selected: true, running: true, run: {
        turnId: 'turn-current', operationKind: 'user-turn', projectionState: 'active',
        startedAt: '2026-09-29T12:00:54.420Z',
      } }
      : { ...item, selected: false });
    await applySelectionSnapshot(page, active);
    await page.waitForFunction(() => Boolean(document.querySelector('[data-activity-stream-list] [data-activity-task-id="stream-b"]')));
    await page.evaluate((old) => {
      const held = window.__heldSelectionSnapshot;
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'agenthub:control-result', id: held.id, ok: true,
        result: old,
      } }));
    }, idle);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-activity-stream-list] [data-activity-task-id="stream-b"]').count(), 1);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('late active snapshot cannot revive a completed final', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const active = snapshot();
    active.version = 'old-active';
    active.tasks = active.tasks.map((item) => item.streamId === 'stream-b'
      ? { ...item, running: true, run: {
        turnId: 'turn-old', operationKind: 'user-turn', projectionState: 'active',
        startedAt: '2026-09-29T12:00:54.420Z',
      } }
      : item);
    await openFixture(page, { fixtureSnapshot: active });
    await holdSelectionSnapshot(page);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.waitForFunction(() => Boolean(window.__heldSelectionSnapshot));
    const final = snapshot();
    final.version = 'new-final';
    final.tasks = final.tasks.map((item) => item.streamId === 'stream-b'
      ? { ...item, unread: true, lastAnswerAt: '2026-09-29T12:03:10.534Z',
        latestFinal: { provider: 'codex', threadId: 'thread-b', turnId: 'turn-old', revision: 'final-1' } }
      : item);
    await applySelectionSnapshot(page, final);
    const entry = page.locator('[data-activity-stream-list] [data-activity-task-id="stream-b"]');
    await page.waitForFunction(() => document.querySelector('[data-activity-stream-list] [data-activity-task-id="stream-b"]')?.title.includes('Ответ готов'));
    await page.evaluate((old) => {
      const held = window.__heldSelectionSnapshot;
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'agenthub:control-result', id: held.id, ok: true,
        result: old,
      } }));
    }, active);
    await page.waitForTimeout(100);
    assert.match(await entry.getAttribute('title'), /Ответ готов/u);
    assert.equal(await page.locator('[data-chat-pane]').getAttribute('data-stream-chat-task-id'), 'stream-b');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('cold selection applies its independent history and selects the chat', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.waitForFunction(() => document.querySelector('[data-chat-pane]')?.dataset.streamChatTaskId === 'stream-b');
    assert.equal(await page.locator('[data-chat-pane]').getAttribute('data-stream-chat-task-id'), 'stream-b');
  } finally {
    await page.close();
    await browser.close();
  }
});

test('late poll response cannot replace a newer action snapshot', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const idle = snapshot();
    await openFixture(page, { fixtureSnapshot: idle });
    await warmSelectionPage(page);
    await page.evaluate(() => {
      const original = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === 'snapshot' && !window.__heldPoll) {
          window.__heldPoll = message;
          return;
        }
        original(message);
      };
      document.querySelector('[data-provider-connection-retry]').click();
    });
    await page.waitForFunction(() => Boolean(window.__heldPoll));
    const active = snapshot();
    active.version = 'newer-action';
    active.tasks = active.tasks.map((item) => item.streamId === 'stream-b'
      ? { ...item, running: true, run: { turnId: 'turn-current', operationKind: 'user-turn',
        projectionState: 'active', startedAt: '2026-09-29T12:00:54.420Z' } }
      : item);
    await page.evaluate((next) => { window.__agentHubFixture.snapshot = next; }, active);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.waitForFunction(() => Boolean(document.querySelector('[data-activity-stream-list] [data-activity-task-id="stream-b"]')));
    await page.evaluate((old) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'agenthub:control-result', id: window.__heldPoll.id, ok: true, result: old,
      } }));
    }, idle);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-activity-stream-list] [data-activity-task-id="stream-b"]').count(), 1);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('late fallback reset cannot replace a newer active snapshot', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const idle = snapshot();
    await openFixture(page, { fixtureSnapshot: resetWire(idle, 'idle') });
    await warmSelectionPage(page);
    await page.evaluate(() => {
      const original = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action !== 'snapshot') { original(message); return; }
        window.__snapshotRequests ??= [];
        window.__snapshotRequests.push(message);
        if (window.__snapshotRequests.length !== 1) return;
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'agenthub:control-result', id: message.id, ok: true,
          result: { apiVersion: 4, version: 'broken-delta', collectionDeltas: {
            conversations: { baseVersion: 'missing-baseline', version: 'broken-c', upserts: [], removed: [] },
          } },
        } }));
      };
      document.querySelector('[data-provider-connection-retry]').click();
    });
    await page.waitForFunction(() => window.__snapshotRequests?.length >= 2, undefined, { timeout: 5000 });
    const active = snapshot();
    active.version = 'newer-active';
    active.tasks = active.tasks.map((item) => item.streamId === 'stream-b'
      ? { ...item, running: true, run: { turnId: 'current-turn', operationKind: 'user-turn',
        projectionState: 'active', startedAt: '2026-09-29T12:00:54.420Z' } }
      : item);
    await page.evaluate((next) => { window.__agentHubFixture.snapshot = next; }, active);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.waitForFunction(() => Boolean(document.querySelector('[data-activity-stream-list] [data-activity-task-id="stream-b"]')), undefined, { timeout: 5000 });
    await page.evaluate((oldReset) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'agenthub:control-result', id: window.__snapshotRequests[1].id,
        ok: true, result: oldReset,
      } }));
    }, resetWire(idle, 'old-reset'));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-activity-stream-list] [data-activity-task-id="stream-b"]').count(), 1);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('late independent history cannot replace a newer displayed final', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await openFixture(page);
    await page.evaluate(() => {
      const original = window.__agentHubVscode.postMessage;
      window.__historyRequests = [];
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === 'task-history' && message.params.threadId === 'thread-b') {
          window.__historyRequests.push(message);
          if (window.__historyRequests.length === 1) return;
          window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'agenthub:control-result', id: message.id, ok: true,
            result: { provider: 'codex', threadId: 'thread-b', streamId: 'stream-b',
              items: [{ id: 'finished-turn', completed: true, status: 'completed',
                answer: 'Свежий финальный ответ', completedAt: '2026-09-29T12:03:10.534Z' }],
              start: 0, end: 1, total: 1, messageTotal: 1, nextBefore: null, version: 'fresh-history' },
          } }));
          return;
        }
        original(message);
      };
    });
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.waitForFunction(() => window.__historyRequests.length === 1);
    // A new selection has its own history read and navigation generation.
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.waitForFunction(() => window.__historyRequests.length >= 2);
    await page.getByText('Свежий финальный ответ', { exact: true }).waitFor({ state: 'visible' });
    await page.evaluate(() => {
      const held = window.__historyRequests[0];
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'agenthub:control-result', id: held.id, ok: true,
        result: { provider: 'codex', threadId: 'thread-b', streamId: 'stream-b',
          items: [], start: 0, end: 0, total: 0, messageTotal: 0, nextBefore: null, version: 'old-history' },
      } }));
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('Свежий финальный ответ', { exact: true }).count(), 1);
    assert.equal(await page.locator('[data-chat-pane]').getAttribute('data-stream-chat-task-id'), 'stream-b');
  } finally { await page.close(); await browser.close(); }
});

test('old server response cannot roll back a newer server identity while reload is deferred', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const idle = snapshot();
    await openFixture(page, { fixtureSnapshot: idle });
    await holdSelectionSnapshot(page);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.waitForFunction(() => Boolean(window.__heldSelectionSnapshot));
    await page.evaluate(() => window.AgentHub.openDialogSettings());
    const newer = snapshot();
    newer.version = 'new-server-active';
    newer.server.process.instanceId = 'new-server-instance';
    newer.tasks = newer.tasks.map((item) => item.streamId === 'stream-b'
      ? { ...item, running: true, run: { turnId: 'turn-new', operationKind: 'user-turn',
        projectionState: 'active', startedAt: '2026-09-29T12:00:54.420Z' } }
      : item);
    await applySelectionSnapshot(page, newer);
    await page.waitForFunction(() => Boolean(document.querySelector('[data-activity-stream-list] [data-activity-task-id="stream-b"]')));
    await page.evaluate((old) => {
      const held = window.__heldSelectionSnapshot;
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'agenthub:control-result', id: held.id, ok: true,
        result: old,
      } }));
    }, idle);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-activity-stream-list] [data-activity-task-id="stream-b"]').count(), 1);
  } finally {
    await page.close();
    await browser.close();
  }
});

function resetWire(base, version) {
  const { tasks, workspaces, boardTasks, messageReceipts, messagePins = [], ...rest } = base;
  return {
    ...rest, apiVersion: 4, version,
    collectionDeltas: {
      conversations: { reset: tasks, version: `${version}-c` },
      workspaces: { reset: workspaces, version: `${version}-w` },
      boardTasks: { reset: boardTasks, version: `${version}-b` },
      messageReceipts: { reset: messageReceipts, version: `${version}-r` },
      messagePins: { reset: messagePins, version: `${version}-p` },
    },
  };
}

function taskDelta(base, nextTask, from, to) {
  const { tasks, workspaces, boardTasks, messageReceipts, messagePins, ...rest } = base;
  return {
    ...rest, apiVersion: 4, version: to,
    collectionDeltas: {
      conversations: {
        baseVersion: `${from}-c`, version: `${to}-c`,
        upserts: [nextTask], removed: [],
        order: tasks.map((item) => [item.streamId, item.provider, item.threadId].join('\0')),
      },
      ...Object.fromEntries(['workspaces', 'boardTasks', 'messageReceipts', 'messagePins'].map((key) => {
        const suffix = { workspaces: 'w', boardTasks: 'b', messageReceipts: 'r', messagePins: 'p' }[key];
        return [key, { baseVersion: `${from}-${suffix}`, version: `${to}-${suffix}` }];
      })),
    },
  };
}

test('protocol4 active, notModified, request failure, recovery and final remain visible', { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const idle = snapshot();
    idle.tasks[0].lastAnswerAt = '2026-09-29T12:00:00.000Z';
    await openFixture(page, { fixtureSnapshot: resetWire(idle, 'idle') });
    const activeTask = {
      ...idle.tasks[0], running: true,
      run: { turnId: 'turn-active', operationKind: 'user-turn', projectionState: 'active',
        startedAt: '2026-09-29T12:00:54.420Z' },
    };
    await applyFixtureSnapshot(page, taskDelta(idle, activeTask, 'idle', 'active'));
    await page.waitForFunction(() => Boolean(document.querySelector('[data-activity-stream-list] [data-activity-task-id="stream-a"]')));
    await applyFixtureSnapshot(page, { notModified: true, version: 'active' });
    assert.equal(await page.locator('[data-activity-stream-list] [data-activity-task-id="stream-a"]').count(), 1);
    await page.evaluate(() => {
      const original = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === 'snapshot' && !window.__failedOnce) {
          window.__failedOnce = true;
          window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'agenthub:control-result', id: message.id, ok: false, error: 'temporary fixture failure',
          } }));
          return;
        }
        original(message);
      };
      document.querySelector('[data-provider-connection-retry]').click();
    });
    await page.waitForFunction(() => window.__failedOnce === true);
    assert.equal(await page.locator('[data-activity-stream-list] [data-activity-task-id="stream-a"]').count(), 1);
    const finalTask = {
      ...idle.tasks[0], unread: true,
      lastAnswerAt: '2026-09-29T12:03:10.534Z',
      latestFinal: { provider: 'codex', threadId: 'thread-a', turnId: 'turn-active',
        revision: 'final-1' },
    };
    await applyFixtureSnapshot(page, taskDelta(idle, finalTask, 'active', 'final'));
    await page.waitForFunction(() => Boolean(document.querySelector('[data-activity-stream-list] [data-activity-task-id="stream-a"]')));
    assert.equal(await page.locator('[data-activity-stream-list] [data-activity-task-id="stream-a"]').count(), 1);
  } finally {
    await page.close();
    await browser.close();
  }
});
