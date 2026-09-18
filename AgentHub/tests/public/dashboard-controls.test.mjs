import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { launchBrowser, openFixture, snapshot } from './composer-production.fixture.mjs';

async function choose(page, selector, value) {
  if (selector === '[data-task-board-scope-select]' && page.viewportSize().width >= 960) {
    await page.locator('[data-task-board-scopes] [data-board-scope="' + value + '"]').click();
    return;
  }
  const button = page.locator(selector).locator('..').getByRole('button');
  await button.click();
  const menu = await button.getAttribute('aria-controls');
  await page.locator(`#${menu} [data-value="${value}"]`).click();
}

const tasks = Array.from({ length: 35 }, (_, i) => ({
  id: `card-${i}`, taskNumber: `HUB-${i + 1}`, title: `Задача ${i + 1}`,
  description: 'Сохранённое описание', status: 'open', revision: 1,
  bucket: i === 0 ? 'backlog' : 'workspace', workspaceId: i === 0 ? null : 'workspace-1',
  workflowStatus: i % 2 ? 'testing' : 'new', attachments: [], checklist: [],
}));

for (const width of [1600, 390]) test(`status filter shows one full-width column at ${width}px`, { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const data = snapshot();
    data.boardTasks = tasks;
    const diagnostics = await openFixture(page, { fixtureSnapshot: data });
    await page.locator(width < 960 ? '[data-mobile-button="dashboard"]' : '[data-view-button="dashboard"]').click();
    const board = page.locator('[data-task-board]');
    for (const view of ['statuses', 'workspaces', 'list']) {
      await board.locator('[data-task-board-view="' + view + '"]').click();
      assert.equal(await board.locator('.task-board-scope-control').isVisible(), width < 960);
      assert.equal(await board.locator('.task-board-sidebar').isVisible(), width >= 960);
    }
    await board.locator('[data-task-board-view="statuses"]').click();
    for (const grouped of [false, true]) {
      await board.locator('[data-task-board-grouping-toggle]').setChecked(grouped);
      await choose(page, '[data-task-board-status-filter]', 'testing');
      assert.equal(await board.locator('.task-board-column.is-backlog').count(), 0);
      const headings = grouped ? board.locator('.task-board-matrix-head .task-board-column')
        : board.locator('.task-board-status-columns > .task-board-column');
      assert.equal(await headings.count(), 1);
      assert.equal(await headings.first().getAttribute('data-board-destination'), 'status:all:testing');
      assert.equal(await board.locator('[data-board-task-id]').count(), 17);
      const host = await board.locator('.task-board-columns').boundingBox();
      const column = await headings.first().boundingBox();
      assert.ok(column.width >= host.width - 45, JSON.stringify({ host, column }));
      await choose(page, '[data-task-board-status-filter]', 'done');
      assert.equal(await headings.count(), 1, 'empty selected status keeps its heading');
      assert.equal(await board.locator('[data-board-task-id]').count(), 0);
      await choose(page, '[data-task-board-status-filter]', 'new');
      assert.equal(await board.locator('[data-board-task-id]').count(), 18, 'matching Backlog tasks remain visible');
      if (grouped) assert.equal(await board.locator('[data-task-board-group="backlog"] .task-board-lane-heading').textContent(), 'Бэклог1');
      await choose(page, '[data-task-board-status-filter]', 'all');
      assert.equal(await headings.count(), grouped ? 5 : 6, 'all statuses restores the board');
      assert.equal(await board.locator('.task-board-column.is-backlog').count(), 1);
    }
    assert.deepEqual(diagnostics, []);
  } finally {
    await browser.close();
  }
});

for (const width of [1600, 390]) test(`board filters and list work at ${width}px`, { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(5000);
    const data = snapshot();
    data.boardTasks = tasks;
    const diagnostics = await openFixture(page, { fixtureSnapshot: data });
    await page.locator(width < 960 ? '[data-mobile-button="dashboard"]' : '[data-view-button="dashboard"]').click();
    const board = page.locator('[data-task-board]');
    const cards = board.locator('[data-board-task-id]');
    assert.equal(await board.locator('[data-task-board-view="list"]').isVisible(), true);
    if (width < 960) assert.equal(await board.locator('[data-task-board-view="list"]').getAttribute('aria-pressed'), 'true');
    else await board.locator('[data-task-board-view="list"]').click();
    assert.equal(await cards.count(), 35);
    await choose(page, '[data-task-board-status-filter]', 'testing');
    assert.equal(await cards.count(), 17);
    await choose(page, '[data-task-board-scope-select]', 'backlog');
    assert.equal(await cards.count(), 0);
    await choose(page, '[data-task-board-status-filter]', 'all');
    assert.equal(await cards.count(), 1);
    await choose(page, '[data-task-board-scope-select]', 'workspace:workspace-1');
    assert.equal(await cards.count(), 34);
    await board.getByRole('button', { name: 'Создать', exact: true }).click();
    assert.equal(await board.locator('.task-board-inline-create textarea').isVisible(), true);
    await board.getByRole('button', { name: 'Отмена', exact: true }).click();
    await cards.last().scrollIntoViewIfNeeded();
    assert.equal(await cards.last().isVisible(), true);
    const fits = await board.evaluate(node => ({
      page: document.documentElement.scrollWidth <= innerWidth,
      list: node.querySelector('.task-board-column-list').scrollWidth <= node.querySelector('.task-board-column-list').clientWidth + 1,
    }));
    assert.deepEqual(fits, { page: true, list: true });
    await cards.first().click();
    assert.equal(await page.locator('[data-task-card-modal]').isVisible(), true);
    assert.equal(await page.locator('[data-task-card-status]').locator('..').getByRole('button').isVisible(), true);
    await page.locator('[data-task-card-close]').click();
    await board.locator('[data-task-board-view="workspaces"]').click();
    assert.equal(await cards.count(), 35, 'Workspace view filters Workspaces and keeps the separate Backlog');
    await board.locator('[data-task-board-view="list"]').click();
    await page.reload();
    await page.locator(width < 960 ? '[data-mobile-button="dashboard"]' : '[data-view-button="dashboard"]').click();
    assert.equal(await board.locator('[data-task-board-view="list"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await cards.count(), 35);
    if (process.env.AGENT_HUB_QA_DIR) {
      await mkdir(process.env.AGENT_HUB_QA_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_QA_DIR, `dashboard-${width}.png`) });
    }
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});

test('overflow Stream can be dragged into visible manual tab order', { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const data = snapshot();
    for (let i = 0; i < 15; i++) {
      const streamId = `extra-${i}`;
      data.tasks.push({ ...data.tasks[1], streamId, threadId: `thread-extra-${i}`, streamName: `Extra ${i}`, streamOrdinal: i + 3 });
      data.workspaces[0].streams.push({ id: streamId, name: `Extra ${i}`, displayName: `Extra ${i}`, ordinal: i + 3, threads: [{ id: `thread-extra-${i}` }] });
    }
    data.settings.streamOrderMode = 'manual';
    data.selected.streamOrderMode = 'manual';
    const diagnostics = await openFixture(page, { fixtureSnapshot: data });
    await page.evaluate(() => {
      window.__streamMoves = [];
      window.__dragSelections = [];
      document.addEventListener('agenthub:intent', event => {
        if (event.detail.type === 'stream:move') window.__streamMoves.push(event.detail);
        if (event.detail.type === 'task:select') window.__dragSelections.push(event.detail);
      });
    });
    await page.waitForFunction(() => document.documentElement.dataset.streamOrderMode === 'manual');
    await page.locator('[data-stream-overflow-toggle]').click();
    const source = page.locator('.stream-overflow-item:visible').first();
    const destination = page.locator('.stream-tab:visible[data-stream-tab-id]').first();
    const streamId = await source.getAttribute('data-stream-tab-id');
    const beforeStreamId = await destination.getAttribute('data-stream-tab-id');
    assert.equal(await source.getAttribute('draggable'), 'true');
    await source.dragTo(destination, { targetPosition: { x: 4, y: 12 } });
    const moves = await page.evaluate(() => window.__streamMoves);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].streamId, streamId);
    assert.equal(moves[0].beforeStreamId, beforeStreamId);
    assert.equal(moves[0].workspaceId, 'workspace-1');
    assert.deepEqual(await page.evaluate(() => window.__dragSelections), [], 'drag does not select its source');
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});
