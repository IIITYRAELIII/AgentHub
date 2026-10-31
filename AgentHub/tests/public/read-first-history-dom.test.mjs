import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskReadStateStore, taskHasUnreadAnswer } from '../../src/infrastructure/persistence/task-read-state-store.mjs';
import { DesktopReadModelService } from '../../src/interfaces/desktop/desktop-read-model-service.mjs';
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot } from './composer-production.fixture.mjs';

// A held provider refresh must not be necessary to display a valid first local
// page. Only the control transport is held; selection, projection, rendering,
// after-paint eligibility and the durable read owner are production code.
for (const scenario of ['first', 'newer-final', 'rotated', 'navigation', 'existing-older', 'older-window', 'incomplete-window', 'foreign-provider']) {
  test(`first history vs unrelated snapshot: ${scenario}`, { timeout: 30000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-first-history-'));
    const store = new TaskReadStateStore({ dataDir: directory });
    const browser = await launchBrowser();
    let stage = 'initialize';
    let page;
    let errors = [];
    let revision = 1;
    let sequence = 0;
    const completedAt = new Date().toISOString();
    const service = new DesktopReadModelService({
      resolveReadTask: ({ provider, threadId }) => snapshot().tasks.find(task => (
        task.provider === provider && task.threadId === threadId
      )),
      readStateStore: store, trustedDeviceUserId: () => 'local', hasUnread: taskHasUnreadAnswer,
      lastTaskMessage: task => task.threadId === 'thread-b' ? {
        provider: 'codex', threadId: 'thread-b', turnId: 'final-b',
        terminalRevision: revision, updatedAt: completedAt,
      } : null,
      snapshot: ({ projectTask = x => x } = {}) => {
        const value = snapshot();
        return { ...value, version: `first-${++sequence}`, tasks: value.tasks.map(task => projectTask(
          task.threadId === 'thread-b' ? { ...task, lastAnswerAt: completedAt,
            lastAnswerTurnId: 'final-b', orderingActivityAtMs: Date.parse(completedAt) } : task,
        )) };
      },
    });
    try {
      await store.initialize();
      page = await browser.newPage({ viewport: process.env.AGENT_HUB_TEST_MOBILE === '1'
        ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
      page.setDefaultTimeout(5000);
      const first = await service.snapshot();
      errors = await openFixture(page, { fixtureSnapshot: first });
      stage = 'assets';
      // Optional current-runtime compatibility: exact served assets with only
      // the candidate client delta, rather than an old whole-client donor.
      if (process.env.AGENT_HUB_TEST_WEB_APP_ROOT) {
        const root = pathToFileURL(path.resolve(process.env.AGENT_HUB_TEST_WEB_APP_ROOT) + path.sep);
        await page.route('**/*', async route => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname !== '/' && !/\.(js|css)$/u.test(pathname)) return route.fallback();
          if (pathname === '/work-log.css') return route.fallback();
          const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
        const candidate = relative === 'hub-client.js'
            && !process.env.AGENT_HUB_TEST_FIRST_HISTORY_BASELINE;
          const file = candidate
            ? new URL(relative, pathToFileURL(path.resolve(process.env.AGENT_HUB_TEST_CANDIDATE_WEB_APP_ROOT) + path.sep))
            : new URL(relative, root);
          let body = await readFile(file, 'utf8');
          if (pathname === '/') body = body
            .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, '')
            .replace('<!-- agent-hub-theme-catalog -->', '<script type="application/json" data-theme-catalog>[{"id":"orbit","name":"Orbit","color":"#080b11","aliases":[],"assets":{},"backgrounds":[{"id":"none","name":"None","assetUrl":"","preload":false}]}]</script>');
          await route.fulfill({ status: 200, contentType: pathname === '/' ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
        });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.documentElement.dataset.connection === 'online', null, { timeout: 5000 });
      }
      await page.exposeFunction('__firstHistoryRead', params => service.markTaskRead(params));
      if (process.env.AGENT_HUB_TEST_MOBILE === '1') {
        await page.locator('[data-mobile-button="chat"]').click();
      }
      assert.equal(await page.locator('[data-stream-task-id="stream-b"][data-answer-ready]:visible').count(), 1);
      if (process.env.AGENT_HUB_TEST_MOBILE === '1') {
        assert.ok(await page.locator('[data-activity-task-id="stream-b"][data-answer-ready]').count() >= 1);
      } else {
        assert.equal(await page.locator('[data-activity-task-id="stream-b"][data-answer-ready]:visible').count(), 1);
      }
      stage = 'intercept';
      const batches = [];
      await page.route('**/api/command-trace/client-events', async route => {
        batches.push(route.request().postDataJSON());
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.evaluate(() => {
        window.__firstHistory = { opens: [], held: [], reads: [], results: [], applied: [] };
        const probe = window.__firstHistory;
        const setTasks = window.AgentHub.setTasks;
        window.AgentHub.setTasks = function(tasks) {
          const result = setTasks.call(this, tasks);
          probe.applied.push(tasks.map(t => ({ id: t.id, title: t.title })));
          return result;
        };
        const original = window.__agentHubVscode.postMessage;
        const respond = (m, result) => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'agenthub:control-result', id: m.id, ok: true, result },
        })));
        probe.respond = respond;
        window.__agentHubVscode.postMessage = m => {
          if (m.action === 'mark-task-read') {
            probe.reads.push(m.params);
            void window.__firstHistoryRead(m.params).then(result => { probe.results.push(result); respond(m, result); });
            return;
          }
          if (['open-task', 'task-history'].includes(m.action) && m.params?.streamId === 'stream-b') {
            if (m.action === 'task-history' && m.params.before == null && probe.setupHistory) {
              respond(m, probe.setupHistory);
              return;
            }
            (m.action === 'open-task' ? probe.opens : probe.held).push(m);
            return;
          }
          original(m);
        };
      });
      stage = 'open';
      const history = { streamId: 'stream-b', provider: 'codex', threadId: 'thread-b',
        items: [{ id: 'final-b', completed: true, status: 'completed', terminalRevision: 1,
          // Keep bootstrap content taller than the viewport in the older-page
          // case: automatic underfill must not race its explicit setup click.
          prompt: scenario === 'existing-older' ? 'Retained user input\n\n'.repeat(80) : 'Retained user input',
          answer: 'First canonical final', completedAt }],
        start: 1, end: 2, total: 2, nextBefore: 1, version: 'latest-one' };
      const click = id => page.locator(`[data-stream-task-id="${id}"]:visible`).first().click();
      const releaseOpen = async (index, body = history) => {
        await page.evaluate(({ index, history, initial }) => {
          const p = window.__firstHistory;
          p.respond(p.opens[index], { history, snapshot: initial });
        }, { index, history: body, initial: first });
      };
      if (scenario === 'existing-older') {
        // Bootstrap this already-open window with an ordinary fast refresh.
        // Provider reads are held only for the later stale-open crossing under
        // test; the first-page-positive case holds them from the beginning.
        await page.evaluate(value => { window.__firstHistory.setupHistory = value; }, history);
        await click('stream-b');
        await page.waitForFunction(() => window.__firstHistory.opens.length === 1);
        await releaseOpen(0);
        await page.getByText('First canonical final', { exact: true }).waitFor();
        await page.waitForFunction(() => window.__firstHistory.results.length === 1);
        // A short page can already have requested viewport filling. Both that
        // request and the explicit button use the same older-page owner.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (!await page.evaluate(() => window.__firstHistory.held.some(m => m.params.before === 1))) {
          await page.locator('[data-history-load]').evaluate(button => button.click());
        }
        await page.waitForFunction(() => window.__firstHistory.held.some(m => m.params.before === 1), null, { timeout: 3000 });
        await page.evaluate(() => {
          const p = window.__firstHistory;
          p.respond(p.held.findLast(m => m.params.before === 1), {
            provider: 'codex', threadId: 'thread-b', streamId: 'stream-b', start: 0, end: 1, total: 2,
            nextBefore: null, items: [{ id: 'older', completed: true, answer: 'Explicit older page' }],
          });
        });
        await page.getByText('Explicit older page', { exact: true }).waitFor({ timeout: 3000 });
        await page.evaluate(() => { delete window.__firstHistory.setupHistory; });
        // This case protects an existing open window. Ordinary replacement
        // legitimately releases a closed column's canonical pages (ADR-HUB-343).
        await page.locator('[data-stream-task-id="stream-a"]:visible').first().click({ modifiers: ['Control'] });
        assert.equal(await page.locator('.stream-tabs-track [data-stream-tab-id="stream-b"]').getAttribute('aria-pressed'), 'true');
      }
      await click('stream-b');
      const count = scenario === 'existing-older' ? 2 : 1;
      await page.waitForFunction(n => window.__firstHistory.opens.length === n, count);
      if (scenario === 'navigation') await click('stream-a');
      if (scenario === 'newer-final') revision = 2;
      const advanced = await service.snapshot();
      advanced.tasks[0].title = advanced.tasks[0].displayTitle = 'Advanced unrelated task';
      if (scenario === 'rotated') {
        advanced.tasks[1].threadId = 'thread-b-new';
        advanced.tasks[1].threadPosition = 2;
        advanced.tasks[1].latestFinal = null;
        advanced.workspaces[0].streams[1].threads.push({ id: 'thread-b-new' });
      }
      await applyFixtureSnapshot(page, advanced);
      stage = 'advanced-snapshot';
      await page.waitForFunction(() => window.__firstHistory.applied.some(tasks => tasks.some(t => t.title === 'Advanced unrelated task')));
      let body = scenario === 'existing-older'
        ? { ...history, items: [{ ...history.items[0], answer: 'Stale replacement final' }] }
        : history;
      if (scenario === 'older-window') body = { ...body, start: 0, end: 1 };
      if (scenario === 'incomplete-window') body = { ...body, items: [] };
      if (scenario === 'foreign-provider') body = { ...body, provider: 'claude' };
      await releaseOpen(count - 1, body);
      stage = 'released';
      if (scenario === 'first') {
        await page.getByText('First canonical final', { exact: true }).waitFor({ timeout: 3000 });
        await page.waitForFunction(() => window.__firstHistory.results.some(r => r.marked === true));
        await page.waitForFunction(() => !document.querySelector('[data-stream-task-id="stream-b"]').hasAttribute('data-answer-ready'));
        assert.equal(await page.locator('[data-activity-task-id="stream-b"][data-answer-ready]').count(), 0);
        if (process.env.AGENT_HUB_TEST_MOBILE === '1') {
          assert.ok(await page.locator('[data-activity-task-id="stream-b"]').count() >= 1);
        } else {
          assert.equal(await page.locator('[data-activity-task-id="stream-b"]:visible').count(), 1,
            'the card remains rendered in Recent after its ready marker clears');
        }
        assert.deepEqual(await page.evaluate(() => window.__firstHistory.reads.map(r => r.final)), [first.tasks[1].latestFinal]);
        assert.ok(await page.evaluate(() => window.__firstHistory.applied.at(-1).some(t => t.title === 'Advanced unrelated task')),
          'the stale embedded snapshot must remain unapplied');
        if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
          await mkdir(process.env.AGENT_HUB_UI_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, 'first-history-read-cleared.png') });
        }
        const current = await service.snapshot();
        assert.equal(current.tasks[1].unread, false);
        // Existing paired diagnostics join actual history admission, rendered
        // final and the exact SQLite receipt. This measures the isolated page,
        // not server availability or production latency.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        // One flush consumes one bounded batch, not the whole diagnostic queue.
        // Drain only this fixture's reporter; production timers/limits stay put.
        for (let batch = 0; batch < 16; batch += 1) {
          await page.waitForFunction(() => !window.AgentHubCommandTrace.diagnostics().flushing);
          await page.evaluate(() => window.AgentHubCommandTrace.flush());
          if (await page.evaluate(() => window.AgentHubCommandTrace.diagnostics().pending === 0)) break;
        }
        const events = batches.flatMap(batch => batch.events ?? []);
        const opened = await page.evaluate(() => window.__firstHistory.opens[0].params.clientTraceId);
        const decision = events.filter(event => event.commandId === opened
          && event.metadata?.action === 'history-page-decision');
        assert.equal(decision.length, 1);
        assert.equal(decision[0].metadata.render, 'current');
        const read = await page.evaluate(() => window.__firstHistory.reads[0].clientTraceId);
        const clear = events.find(event => event.commandId === read
          && event.metadata?.action === 'read-marker-clear' && event.outcome === 'succeeded');
        assert.ok(clear);
        assert.equal(clear.metadata.tabReady, false);
        assert.equal(clear.metadata.cardReady, false);
        assert.doesNotMatch(JSON.stringify(events), /First canonical final|Retained user input/);
        console.log(JSON.stringify({ scenario, viewport: page.viewportSize(), openRoot: opened,
          readRoot: read, readToClearMs: clear.monotonicDurationMs,
          decision: decision[0].metadata.render, pageUrl: page.url() }));
      } else {
        // Drain the original navigation through its public route update, not a
        // timed absence assertion. Background reads remain held throughout.
        await page.waitForFunction(() => !document.querySelector('[data-provider-connection-retry]')?.disabled);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (scenario === 'existing-older') {
          assert.equal(await page.getByText('Explicit older page', { exact: true }).count(), 1);
          assert.equal(await page.getByText('Stale replacement final', { exact: true }).count(), 0);
        } else {
          assert.equal(await page.getByText('First canonical final', { exact: true }).count(), 0);
          assert.equal(await page.evaluate(() => window.__firstHistory.reads.length), 0);
          assert.equal((await service.snapshot()).tasks[1].unread, true);
        }
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error(JSON.stringify({ scenario, stage, errors, state: page && !page.isClosed() ? await page.evaluate(() => ({
        connection: document.documentElement.dataset.connection,
        opens: window.__firstHistory?.opens?.length,
        held: window.__firstHistory?.held?.map(m => m.params),
        applied: window.__firstHistory?.applied,
      })).catch(() => null) : null }));
      throw error;
    } finally {
      // Context close aborts held transport requests; no pending test polling or
      // provider Promise is left alive after success or assertion failure.
      await browser.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
