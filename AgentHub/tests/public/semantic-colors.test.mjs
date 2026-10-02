import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser, openFixture, snapshot } from './composer-production.fixture.mjs';

const { loadThemeRegistry } = createRequire(import.meta.url)('../../theme-registry.cjs');
const registry = loadThemeRegistry(fileURLToPath(new URL('../../assets/web-app/', import.meta.url)));
const statuses = {
  new: 'rgb(133, 139, 148)',
  in_progress: 'rgb(66, 133, 244)',
  testing: 'rgb(212, 162, 13)',
  awaiting_implementation: 'rgb(232, 120, 35)',
  done: 'rgb(46, 164, 79)',
};

test('Task status badges and provider dots retain their colors across every theme', { timeout: 60_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const data = snapshot();
    data.tasks[1].provider = 'claude';
    data.boardTasks = Object.keys(statuses).map((status, index) => ({
      id: 'color-' + status, taskNumber: 'HUB-' + (index + 1), title: status,
      description: '', status: 'open', workflowStatus: status, revision: 1,
      bucket: 'workspace', workspaceId: 'workspace-1', attachments: [], checklist: [],
    }));
    const missing = [];
    page.on('response', response => { if (response.status() >= 400) missing.push(response.url()); });
    const diagnostics = await openFixture(page, { fixtureSnapshot: data });
    await page.route('**/themes/**', async route => {
      const resource = registry.resources.get(new URL(route.request().url()).pathname);
      // CSS custom-property URLs may resolve at their shared styles.css use site.
      // Keep this fixture's texture requests within the owning theme package.
      if (resource?.contentType === 'text/css; charset=utf-8') {
        const css = await readFile(resource.file, 'utf8');
        return route.fulfill({ contentType: resource.contentType, body: css.replace(
          /url\((["']?)(\.\.?\/[^"')]+)\1\)/gu,
          (_, quote, relative) => 'url("' + new URL(relative, route.request().url()).href + '")') });
      }
      return resource ? route.fulfill({ contentType: resource.contentType, path: resource.file })
        : route.abort();
    });
    for (const theme of registry.themes) {
      for (const stylesheet of theme.styles) {
        const ruleCount = await page.evaluate(url => new Promise((resolve, reject) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = url;
          link.onload = () => resolve(link.sheet.cssRules.length);
          link.onerror = () => reject(new Error('Stylesheet failed: ' + url));
          document.head.append(link);
        }), '/themes/' + theme.id + '/' + stylesheet);
        assert.ok(ruleCount > 0, theme.id + ' stylesheet loaded');
      }
    }
    await page.addStyleTag({ content: '* { transition: none !important; }' });
    await page.locator('[data-view-button="dashboard"]').click();
    await page.locator('[data-task-board-view="list"]').click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const theme of registry.themes) {
        await page.evaluate(({ id, assets }) => {
          document.documentElement.dataset.theme = id;
          for (const asset of assets) document.documentElement.style.setProperty(
            '--' + id + '-' + asset.id + '-asset', 'url("/themes/' + id + '/' + asset.file + '")');
        }, theme);
        const colors = await page.locator('[data-task-board] .board-task-status').evaluateAll(nodes =>
          Object.fromEntries(nodes.map(node => [node.dataset.workflowStatus, getComputedStyle(node).color])));
        assert.deepEqual(colors, statuses, theme.id + ' at ' + width);
        for (const [provider, color] of [['codex', 'rgb(108, 178, 255)'], ['claude', 'rgb(224, 138, 99)']]) {
          const dots = page.locator('.stream-tab .provider-dot[data-provider="' + provider + '"]');
          assert.ok(await dots.count(), provider + ' dot is rendered');
          for (const actual of await dots.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor))) {
            assert.equal(actual, color, theme.id + ' / ' + provider + ' at ' + width);
          }
        }
      }
    }
    assert.deepEqual(diagnostics, [], missing.join('\n'));
  } finally {
    await browser.close();
  }
});
