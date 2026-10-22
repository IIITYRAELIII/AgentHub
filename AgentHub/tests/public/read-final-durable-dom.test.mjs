import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskReadStateStore, taskHasUnreadAnswer } from '../../src/infrastructure/persistence/task-read-state-store.mjs';
import { DesktopReadModelService } from '../../src/interfaces/desktop/desktop-read-model-service.mjs';
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot } from './composer-production.fixture.mjs';

test('real durable ACK keeps both rendered ready markers clear after final time enrichment and reopen', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-read-dom-'));
  const store = new TaskReadStateStore({ dataDir: directory });
  const browser = await launchBrowser();
  let record = { provider: 'codex', threadId: 'thread-b', turnId: 'final-b',
    terminalRevision: 1, updatedAt: '2026-10-16T09:10:10.774Z' };
  let sequence = 0;
  const service = new DesktopReadModelService({
    readStateStore: store, trustedDeviceUserId: () => 'local',
    lastTaskMessage: task => task.threadId === 'thread-b' ? record : null,
    hasUnread: taskHasUnreadAnswer,
    snapshot: ({ projectTask = x => x } = {}) => {
      const value = snapshot();
      return { ...value, version: `durable-${++sequence}`, tasks: value.tasks.map(projectTask) };
    },
  });
  const markers = page => page.evaluate(() => ({
    tab: document.querySelector('[data-stream-task-id="stream-b"]')?.hasAttribute('data-answer-ready') ?? false,
    card: document.querySelector('[data-activity-task-id="stream-b"]')?.hasAttribute('data-answer-ready') ?? false,
  }));
  async function open(page) {
    const initial = await service.snapshot();
    const errors = await openFixture(page, { fixtureSnapshot: initial });
    // Optional exact installed-assets compatibility run. Serve bytes, never
    // assert source text or replace the production client with a fixture copy.
    if (process.env.AGENT_HUB_TEST_WEB_APP_ROOT) {
      const root = pathToFileURL(path.resolve(process.env.AGENT_HUB_TEST_WEB_APP_ROOT) + path.sep);
      await page.route('**/*', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname !== '/' && !/\.(js|css)$/u.test(pathname)) return route.fallback();
        if (pathname === '/work-log.css') return route.fallback();
        const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
        const file = relative === 'messages/read-marker.js' && !process.env.AGENT_HUB_TEST_BASELINE_READ_MARKER
          ? new URL('../../assets/web-app/messages/read-marker.js', import.meta.url)
          : new URL(relative, root);
        let body = await readFile(file, 'utf8');
        if (pathname === '/') {
          const catalog = [{ id: 'orbit', name: 'Orbit', color: '#080b11', aliases: [], assets: {},
            backgrounds: [{ id: 'none', name: 'None', assetUrl: '', preload: false }] }];
          body = body.replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, '')
            .replace('<!-- agent-hub-theme-catalog -->', `<script type="application/json" data-theme-catalog>${JSON.stringify(catalog)}</script>`);
        }
        await route.fulfill({ status: 200, contentType: pathname === '/' ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
      });
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.dataset.connection === 'online');
    }
    await page.exposeFunction('__durableRead318', params => service.markTaskRead(params));
    await page.evaluate(() => {
      window.__reads318 = [];
      const original = window.__agentHubVscode.postMessage;
      const respond = (m, result) => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'agenthub:control-result', id: m.id, ok: true, result },
      })));
      window.__agentHubVscode.postMessage = m => {
        if (m.action === 'mark-task-read') {
          window.__reads318.push(m.params);
          void window.__durableRead318(m.params).then(result => respond(m, result));
          return;
        }
        if (['open-task', 'task-history'].includes(m.action) && (m.params?.streamId === 'stream-b' || m.params?.threadId === 'thread-b')) {
          if (window.__holdHistory318) return;
          const value = window.__agentHubFixture.snapshot;
          const final = value.tasks.find(t => t.streamId === 'stream-b').latestFinal;
          const history = { streamId: 'stream-b', provider: 'codex', threadId: 'thread-b',
            items: [{ id: final.turnId, completed: true, status: 'completed', terminalRevision: final.revision,
              answer: `Final revision ${final.revision}`, completedAt: final.completedAt }],
            start: 0, end: 1, total: 1, nextBefore: null, version: `history-${final.revision}` };
          respond(m, m.action === 'open-task' ? { history, snapshot: value } : history);
          return;
        }
        original(m);
      };
    });
    return errors;
  }
  try {
    await store.initialize();
    let page = await browser.newPage();
    const errors = await open(page);
    assert.equal(await page.title(), 'Agent Hub');
    assert.ok((await page.locator('body').innerText()).length > 100);
    assert.equal(await page.locator('vite-error-overlay, #webpack-dev-server-client-overlay').count(), 0);
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.getByText('Final revision 1', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__reads318.length === 1);
    await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute('data-answer-ready'));
    assert.deepEqual(await markers(page), { tab: false, card: false });
    record = { ...record, updatedAt: '2026-10-16T09:10:25.273Z' };
    await applyFixtureSnapshot(page, await service.snapshot());
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.deepEqual(await markers(page), { tab: false, card: false });
    assert.equal(await page.evaluate(() => window.__reads318.length), 1);
    if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
      await mkdir(process.env.AGENT_HUB_UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, 'read-final-cleared.png') });
    }
    await page.evaluate(() => { window.__holdHistory318 = true; });
    const old = (await service.snapshot()).tasks.find(t => t.streamId === 'stream-b').latestFinal;
    record = { ...record, terminalRevision: 2, updatedAt: '2026-10-16T09:09:00.000Z' };
    await applyFixtureSnapshot(page, await service.snapshot());
    assert.deepEqual(await markers(page), { tab: true, card: true });
    if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, 'read-final-new-revision-unread.png') });
    }
    assert.equal((await service.markTaskRead({ final: old })).reason, 'stale-final');
    assert.deepEqual(await markers(page), { tab: true, card: true });
    await page.evaluate(() => { window.__holdHistory318 = false; });
    await page.locator('[data-stream-task-id="stream-a"]:visible').first().click();
    await page.locator('[data-stream-task-id="stream-b"]:visible').first().click();
    await page.getByText('Final revision 2', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute('data-answer-ready'));
    assert.deepEqual(await markers(page), { tab: false, card: false });
    await page.close();
    page = await browser.newPage();
    await open(page);
    assert.deepEqual(await markers(page), { tab: false, card: false });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
