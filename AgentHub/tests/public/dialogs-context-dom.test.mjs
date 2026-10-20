import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { measureDrawerContrast } from "./mobile-navigation.metrics.mjs";
import { fileURLToPath } from "node:url";
import { launchBrowser, openFixture, snapshot, bridgeCalls } from "./composer-production.fixture.mjs";

const captures = fileURLToPath(new URL("../../WIP/direct-conversation-captures/", import.meta.url));
const longName = "ДлинноеНазваниеДиалогаБезПробелов🛰".repeat(4);
const workspaceName = "Hysteria · Рабочее пространство 🛰";
const { loadThemeRegistry } = createRequire(import.meta.url)("../../theme-registry.cjs");
const registry = loadThemeRegistry(fileURLToPath(new URL("../../assets/web-app/", import.meta.url)));
const surfaces = [
  { name: "mobile-320", width: 320, surface: "web", mobile: true },
  { name: "mobile-390", width: 390, surface: "web", mobile: true },
  { name: "mobile-430", width: 430, surface: "web", mobile: true },
  { name: "web-1280", width: 1280, surface: "web" },
  { name: "webview-390", width: 390, surface: "vscode" },
  { name: "webview-520", width: 520, surface: "vscode" },
];

function fixture() {
  const data = snapshot();
  const names = ["", "Вопрос", "Исследование", "Готовый ответ", "Прочитанный ответ", longName, "Stream пользователя"];
  data.tasks = names.map((name, index) => ({
    ...data.tasks[0], streamId: `stream-${String.fromCharCode(97 + index)}`,
    threadId: `thread-${String.fromCharCode(97 + index)}`,
    title: `Thread ${index + 1}`, selected: index === 0, streamOrdinal: index + 1,
    streamName: name, streamDisplayName: name, workspaceName,
    lastAnswerAt: null, lastAnswer: null, model: "gpt-test",
  }));
  data.workspaces[0].name = workspaceName;
  data.settings.modelOptionsByProvider.codex = [{ value: "gpt-test", label: "Sol" }];
  data.workspaces[0].streams = data.tasks.map((task) => ({
    id: task.streamId, name: task.streamName, displayName: task.streamDisplayName,
    ordinal: task.streamOrdinal, threads: [{ id: task.threadId, provider: task.provider }],
  }));
  data.workspaces.push({ id: "empty", name: "Пустой Workspace 🛰", streams: [] });
  return data;
}

async function capture(page, name) {
  await page.screenshot({ path: path.join(captures, `${name}.png`) });
}

async function assertDialogAccessibleCopy(page) {
  const attributes = await page.locator(
    "[data-dialog-settings], [data-stream-card-settings-menu], .stream-context-menu:not(.workspace-context-menu), .chat-overlay-actions, [data-mobile-stream-switch]",
  ).evaluateAll((roots) => roots.flatMap((root) => [root, ...root.querySelectorAll("[aria-label], [title], [placeholder]")])
    .flatMap((node) => ["aria-label", "title", "placeholder"].filter((name) => node.hasAttribute(name))
      .map((name) => ({ attribute: name, value: node.getAttribute(name) }))));
  for (const { attribute, value } of attributes) {
    const frameworkCopy = [workspaceName, longName, "Stream пользователя"]
      .reduce((text, authoredName) => text.replaceAll(authoredName, ""), value);
    assert.doesNotMatch(frameworkCopy, /Stream|Thread|диалог|Пока нет ответа|Ход выполняется/iu,
      `${attribute}: ${value}`);
  }
  return attributes;
}


async function chooseWorkspace(page, id) {
  const row = page.locator(`[data-workspace-select="${id}"]`);
  const name = await row.locator(".task-workspace-name").innerText();
  await row.locator("[data-mobile-workspace-select]").click();
  await page.waitForFunction((name) => document.querySelector("[data-mobile-workspace-name]")?.textContent === name, name);
}

async function metrics(page) {
  return page.evaluate(() => {
    const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const context = document.querySelector('[data-mobile-stream-switch]');
    const caret = context.querySelector('svg');
    const names = [document.querySelector('[data-mobile-workspace-name]'), document.querySelector('[data-mobile-stream-name]')];
    const controls = [...document.querySelectorAll('[data-mobile-workspaces-open], [data-mobile-stream-switch], [data-mobile-chat-stream-create], [data-mobile-dialogs-tab]')];
    const targets = controls.map((n) => ({ label: n.getAttribute('aria-label'), ...rect(n) }));
    const visible = (n) => n.getClientRects().length && !n.closest('[hidden]');
    const drawer = document.querySelector('[data-mobile-workspace-drawer]');
    const search = drawer.querySelector('[data-task-filter]');
    const sheet = document.querySelector('[data-mobile-stream-switcher]');
    return {
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), targets,
      oneLine: names.every((n) => rect(n).height <= parseFloat(getComputedStyle(n).lineHeight) + 1),
      caretVisible: rect(caret).width > 0 && rect(caret).right <= rect(context).right,
      collision: targets.slice(0, 3).some((r, i, a) => i && a[i - 1].right > r.x + 1),
      sheet: sheet.open ? { ...rect(sheet), rows: [...sheet.querySelectorAll('.mobile-stream-row')].map(rect),
        create: rect(sheet.querySelector('[data-mobile-switcher-create]')), viewport: visualViewport.height } : null,
      drawer: drawer.open ? { header: getComputedStyle(drawer.querySelector('header')).backgroundColor,
        input: getComputedStyle(search).backgroundColor, inputBorder: getComputedStyle(search).borderTopWidth,
        canvas: getComputedStyle(drawer).backgroundColor, rail: getComputedStyle(drawer.querySelector('.task-rail')).backgroundColor } : null,
      emptyComposerCount: document.documentElement.hasAttribute('data-mobile-empty')
        ? [...document.querySelectorAll('[data-composer-input], [data-composer-send]')].filter(visible).length : null,
    };
  });
}

for (const surface of surfaces) {
  test(`direct conversation, context, picker and copy: ${surface.name}`, { timeout: 120_000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: surface.width, height: 900 },
      ...(surface.mobile ? { isMobile: true, hasTouch: true } : {}) });
    page.setDefaultTimeout(5_000);
    await mkdir(captures, { recursive: true });
    try {
      const data = fixture();
      const compact = surface.width < 860;
      const diagnostics = await openFixture(page, { fixtureSnapshot: data, surface: surface.surface, themeRegistry: registry, followSelection: true });
      const context = page.locator('[data-mobile-stream-switch]');
      const picker = page.locator('[data-mobile-stream-switcher]');
      const rows = picker.locator('[data-mobile-stream-id]');
      const filter = picker.locator('[data-mobile-stream-filter]');
      if (compact) {
        assert.equal(await page.locator('[data-composer-input]').isVisible(), true);
        assert.equal(await page.locator('[data-mobile-dialogs], [data-mobile-conversation-back]').count(), 0);
        assert.equal(await context.locator('[data-mobile-workspace-name]').innerText(), workspaceName);
        assert.equal(await context.locator('[data-mobile-stream-name]').innerText(), 'Поток 1');
        assert.equal(await context.getAttribute('aria-label'), `Workspace ${workspaceName} / Поток 1`);
        assert.equal(await page.locator('[data-mobile-dialogs-tab="chat"]').getAttribute('aria-label'), 'Чат');
        assert.deepEqual(await page.locator('[data-mobile-dialogs-tab] span').allTextContents(), ['Чат', 'Задачи', 'Журнал', 'Статистика', 'Ещё']);
        await context.click();
        assert.equal(await picker.locator('header strong').evaluate((n) => document.activeElement === n), true);
        await page.keyboard.press('Tab');
        assert.equal(await filter.evaluate((n) => document.activeElement === n), true);
        assert.equal(await rows.count(), 7);
        assert.equal(await picker.locator('.mobile-stream-preview').count(), 0);
        assert.equal(await picker.locator('[data-mobile-stream-id="stream-a"]').getAttribute('aria-current'), 'true');
        await filter.fill('пОТоК 1');
        assert.equal(await rows.count(), 1);
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.mobileStreamId), 'stream-a');
        await page.keyboard.press('Enter');
        assert.equal(await picker.evaluate((d) => d.open), false);
        assert.equal(await context.evaluate((n) => document.activeElement === n), true);
        await page.keyboard.press('Enter');
        assert.equal(await filter.inputValue(), '');
        assert.equal(await filter.evaluate((n) => document.activeElement === n), true);
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Home');
        assert.equal(await rows.first().evaluate((n) => document.activeElement === n), true);
        await page.keyboard.press('End');
        assert.equal(await rows.last().evaluate((n) => document.activeElement === n), true);
        await page.keyboard.press('Escape');
        assert.equal(await context.evaluate((n) => document.activeElement === n), true);
        // Preserve state authority; the picker intentionally omits content previews.
        await page.evaluate(() => {
          const patch = { running: true, run: { turnId: 'active-turn', operationKind: 'user-turn', projectionState: 'active' } };
          Object.assign(window.__agentHubFixture.snapshot.tasks.find((t) => t.streamId === 'stream-c'), patch);
          AgentHub.patchTask('stream-c', patch);
          AgentHub.setMessages('stream-c', [{ id: 'u', role: 'user', turnId: 'active-turn', text: 'Текущий вопрос' }]);
        });
        await context.click();
        assert.equal(await picker.locator('[data-mobile-stream-id="stream-c"] .mobile-stream-running').innerText(), 'Готовит ответ');
        await page.evaluate(() => AgentHub.setLive('stream-c', { provider: 'codex', threadId: 'thread-c', turnId: 'active-turn', projectionState: 'active', operationKind: 'user-turn', text: 'Первый фрагмент ответа' }));
        assert.equal(await picker.locator('[data-mobile-stream-id="stream-c"] .mobile-stream-running').innerText(), 'Отвечает');
        assert.equal(await picker.locator('[data-mobile-stream-id="stream-g"] strong').innerText(), 'Stream пользователя');
        assert.equal(await picker.locator('[data-mobile-stream-id="stream-f"] strong').getAttribute('title'), longName);
        await page.keyboard.press('Escape');
        const allMetrics = [];
        for (const theme of ['nebula', 'orange']) {
          await page.locator('[data-theme-select]').evaluate((n, value) => { n.value = value; n.dispatchEvent(new Event('change', { bubbles: true })); }, theme);
          await capture(page, `${surface.name}-${theme}-direct`);
          await writeFile(path.join(captures, `${surface.name}-${theme}-direct-accessible.json`), JSON.stringify({ ariaLabel: await context.getAttribute('aria-label'), title: await context.getAttribute('title') }, null, 2));
          const m = await metrics(page);
          assert.equal(m.overflow, 0); assert.equal(m.oneLine, true); assert.equal(m.caretVisible, true); assert.equal(m.collision, false);
          for (const r of m.targets) assert.ok(r.width >= 44 && r.height >= 44, JSON.stringify(r));
          await page.locator('[data-mobile-workspaces-open]').click();
          const drawerMetrics = await metrics(page);
          const contrast = await measureDrawerContrast(page);
          for (const item of contrast.results) assert.ok(item.ratio >= item.minimum, JSON.stringify({ surface: surface.name, theme, item }));
          assert.equal(drawerMetrics.drawer.canvas, drawerMetrics.drawer.rail);
          assert.equal(drawerMetrics.drawer.header, 'rgba(0, 0, 0, 0)');
          assert.equal(drawerMetrics.drawer.input, 'rgba(0, 0, 0, 0)');
          assert.equal(drawerMetrics.drawer.inputBorder, '0px');
          await capture(page, `${surface.name}-${theme}-drawer`);
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('[data-mobile-workspaces-open]').evaluate((n) => document.activeElement === n), true);
          await context.click();
          const sheetMetrics = await metrics(page);
          assert.ok(sheetMetrics.sheet.bottom <= sheetMetrics.sheet.viewport + 1);
          assert.ok(sheetMetrics.sheet.create.bottom <= sheetMetrics.sheet.bottom);
          for (const r of sheetMetrics.sheet.rows) assert.ok(r.height >= 52);
          await capture(page, `${surface.name}-${theme}-switcher`);
          assert.equal(await picker.locator('[data-mobile-stream-filter-clear]:visible').count(), 0);
          await filter.fill('stream пользователя');
          const clear = picker.getByRole('button', { name: 'Очистить поиск по потокам', exact: true });
          assert.equal(await clear.count(), 1); assert.equal(await clear.isVisible(), true);
          const searchRect = await filter.boundingBox();
          await page.mouse.click(searchRect.x + searchRect.width - 12, searchRect.y + searchRect.height / 2);
          assert.equal(await filter.inputValue(), 'stream пользователя', 'the native cancel hit area must not clear the query');
          const clearRect = await clear.boundingBox(); assert.ok(clearRect.width >= 44 && clearRect.height >= 44);
          assert.equal(await rows.count(), 1);
          await capture(page, `${surface.name}-${theme}-search`);
          await filter.fill('нет совпадений');
          assert.equal(await picker.locator('.mobile-dialogs-empty').innerText(), 'Потоки не найдены');
          assert.equal(await picker.locator('[data-mobile-switcher-create]').isVisible(), true);
          await capture(page, `${surface.name}-${theme}-no-results`);
          if (theme === 'nebula') { await clear.focus(); await page.keyboard.press('Enter'); } else await clear.click();
          assert.equal(await filter.inputValue(), ''); assert.equal(await rows.count(), 7);
          assert.equal(await clear.isVisible(), false); assert.equal(await filter.evaluate((n) => document.activeElement === n), true);
          await page.keyboard.press('Escape');
          await page.locator('[data-mobile-workspaces-open]').click();
          await chooseWorkspace(page, "empty");
          assert.equal(await page.locator('[data-mobile-conversation-empty] h2').innerText(), 'В этом Workspace пока нет потоков');
          assert.equal(await page.locator('[data-mobile-conversation-empty] h2').evaluate((n) => document.activeElement === n), true);
          assert.equal((await metrics(page)).emptyComposerCount, 0);
          assert.equal(await context.locator('[data-mobile-stream-name]').innerText(), 'Нет потоков');
          assert.equal(await context.getAttribute('aria-label'), 'Workspace Пустой Workspace 🛰 / Нет потоков');
          await writeFile(path.join(captures, `${surface.name}-${theme}-empty-accessible.json`), JSON.stringify({ ariaLabel: await context.getAttribute('aria-label'), title: await context.getAttribute('title') }, null, 2));
          await capture(page, `${surface.name}-${theme}-empty`);
          await context.click();
          assert.equal(await picker.locator('.mobile-dialogs-empty').innerText(), 'В этом Workspace пока нет потоков.');
          assert.equal(await picker.locator('[data-mobile-switcher-create]').isEnabled(), true);
          await page.keyboard.press('Escape');
          await page.locator('[data-mobile-workspaces-open]').click();
          await chooseWorkspace(page, "workspace-1");
          assert.equal(await page.locator('[data-composer-input]').isVisible(), true);
          allMetrics.push({ theme, direct: m, drawer: drawerMetrics.drawer, contrast: contrast.results, sheet: sheetMetrics.sheet });
        }
        await writeFile(path.join(captures, `${surface.name}-metrics.json`), JSON.stringify(allMetrics, null, 2));
        await context.click();
        await picker.locator('[data-mobile-stream-id="stream-f"]').click();
        await page.waitForFunction((name) => document.querySelector('[data-mobile-stream-switch]')?.title === `Переключить поток: ${name}`, longName, { timeout: 5_000 });
        assert.equal(await context.getAttribute('title'), `Переключить поток: ${longName}`);
        const longMetrics = await metrics(page);
        assert.equal(longMetrics.oneLine, true); assert.equal(longMetrics.caretVisible, true); assert.equal(longMetrics.collision, false);
        await capture(page, `${surface.name}-long-opened`);
      } else {
        assert.equal(await page.locator('[data-view-title]').innerText(), 'Диалоги');
        assert.equal(await page.locator('[data-view-button="chat"]').innerText(), 'Диалоги');
        assert.equal(await page.locator('[data-mobile-workspaces-open]').isVisible(), false);
        assert.equal(await page.locator('[data-stream-tabs]').isVisible(), true);
        assert.equal(await page.locator('[data-action="stream-create"]').getAttribute('aria-label'), 'Новый поток');
        await page.evaluate(() => AgentHub.showSelectedTask());
        assert.equal(await page.locator('.stream-chat-workspace-label').isVisible(), true);
        assert.equal(await page.locator('[data-stream-header-workspace]').innerText(), workspaceName);
        await capture(page, `${surface.name}-direct`);
        await page.locator('.stream-tabs-track .stream-tab:visible').first().dispatchEvent('contextmenu', { clientX: 100, clientY: 100 });
        const rotate = page.locator('.stream-context-menu:not([hidden]) [data-stream-menu-action="replace-thread"]');
        assert.equal(await rotate.getAttribute('title'), 'Завершить текущую работу агента и продолжить поток в новом контексте Codex');
        await page.keyboard.press('Escape');
        await page.locator('[data-composer-input]').click();
      }
      await page.locator('[data-dialog-settings-toggle]').click();
      const settings = page.locator('[data-dialog-settings]');
      assert.equal(await settings.getAttribute('aria-label'), 'Карточка потока');
      assert.doesNotMatch(await settings.innerText(), /Stream|Thread|диалог|Пока нет ответа|Ход выполняется/iu);
      assert.equal(await settings.locator('[data-dialog-working-directory-note]').innerText(), 'Новая директория начнёт использоваться после следующего запуска агента. Текущая работа продолжится в прежней директории.');
      const attributes = await assertDialogAccessibleCopy(page);
      const gapToggle = page.locator('[data-stream-gap-toggle]');
      if (!compact) assert.equal(await gapToggle.getAttribute('aria-label'), 'Отступ между карточками потоков');
      else assert.equal(await gapToggle.count(), 0);
      await writeFile(path.join(captures, `${surface.name}-accessible-copy.json`), JSON.stringify(attributes, null, 2));
      await capture(page, `${surface.name}-settings`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal((await bridgeCalls(page, 'send-message')).length, 0);
      assert.deepEqual(diagnostics, []);
    } finally { await page.close(); await browser.close(); }
  });
}


test('short-height picker and empty shell remain within the viewport', { timeout: 60_000 }, async () => {
  const browser = await launchBrowser();
  try {
    for (const [width, height] of [[320, 568], [390, 420]]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
      const diagnostics = await openFixture(page, { fixtureSnapshot: fixture(), surface: 'web', themeRegistry: registry });
      await page.locator('[data-theme-select]').evaluate((n) => { n.value = 'orange'; n.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.locator('[data-mobile-stream-switch]').click();
      const m = await metrics(page);
      assert.equal(m.overflow, 0);
      assert.ok(m.sheet.bottom <= height && m.sheet.y >= 0);
      assert.ok(m.sheet.create.bottom <= m.sheet.bottom);
      const list = page.locator('[data-mobile-stream-list]');
      assert.equal(await list.evaluate((n) => getComputedStyle(n).overflowY), 'auto');
      await list.evaluate((n) => n.scrollTop = n.scrollHeight);
      assert.equal(await page.locator('[data-mobile-stream-switcher] [data-mobile-switcher-create]').isVisible(), true);
      await capture(page, `mobile-${width}x${height}-switcher`);
      await page.keyboard.press('Escape');
      await page.locator('[data-mobile-workspaces-open]').click();
      await chooseWorkspace(page, "empty");
      assert.equal(await page.locator('[data-composer-input]').isVisible(), false);
      const r = await page.locator('[data-mobile-stream-create]').boundingBox();
      assert.ok(r.y + r.height < height - 44);
      await capture(page, `mobile-${width}x${height}-empty`);
      assert.deepEqual(diagnostics, []);
      await page.close();
    }
  } finally { await browser.close(); }
});


test('Stream admission waits for the exact overlay history entry to close before changing the canonical route', { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 520, height: 844 } });
  page.setDefaultTimeout(5_000);
  try {
    const diagnostics = await openFixture(page, { surface: 'vscode', followSelection: true });
    await page.evaluate(() => {
      history.replaceState({ previous: true }, '', '/#/chat/stream/stream-a');
      history.pushState({ conversation: true }, '', '/#/chat/stream/stream-a');
      const nativeBack = history.back.bind(history);
      history.back = () => { window.__releaseHistoryBack = nativeBack; };
    });
    await page.locator('[data-mobile-stream-switch]').click();
    await page.locator('[data-mobile-stream-switcher] [data-mobile-stream-id="stream-b"]').click();
    await page.waitForFunction(() => typeof window.__releaseHistoryBack === 'function');
    assert.equal((await bridgeCalls(page, 'open-task')).filter((r) => r.params.threadId === 'thread-b').length, 0);
    assert.equal(await page.locator('[data-mobile-stream-name]').innerText(), 'Stream A');
    await page.evaluate(() => window.__releaseHistoryBack());
    await page.waitForFunction(() => location.hash === '#/chat/stream/stream-b' && document.querySelector('[data-mobile-stream-name]')?.textContent === 'Stream B');
    assert.equal(await page.evaluate(() => Boolean(history.state?.mobileDialogs)), false);
    await page.evaluate(() => window.__releaseHistoryBack());
    await page.waitForFunction(() => history.state?.previous === true && location.hash === '#/chat/stream/stream-a');
    assert.equal(await page.locator('[data-mobile-dialogs], [data-mobile-conversation-back]').count(), 0);
    assert.equal((await bridgeCalls(page, 'send-message')).length, 0);
    assert.deepEqual(diagnostics, []);
  } finally { await page.close(); await browser.close(); }
});
