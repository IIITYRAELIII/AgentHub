import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { chromium } from 'playwright';

const source = await readFile(new URL('../../assets/web-app/file-transfer-owner.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../../assets/web-app/styles.css', import.meta.url), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

async function pageFixture(t) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.setContent(`<!doctype html><html data-theme="orbit"><head><style>${css}</style></head><body><button id="open">Open</button></body></html>`);
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    window.calls = [];
    window.snapshot = (id, state = 'ready', share = false) => ({ file: { name: `${id}.bin`, size: 10 },
      artifact: { id, state, size: 10 }, ttlOptions: [3600000], share: share ? window.share(id) : null });
    window.share = id => ({ id: `share-${id}`, artifactId: id, state: 'ready', size: 10,
      expiresAt: Date.now() + 3600000, url: `https://files.example.test/#${id}` });
    window.next = 'A'; window.heldAction = ''; window.holdNextStatus = false;
    window.AgentHubFileTransferOwner.configure(async (action, args) => {
      window.calls.push({ action, args });
      const captured = window.next;
      if (action === window.heldAction || (action === 'status' && window.holdNextStatus)) {
        window.heldAction = ''; window.holdNextStatus = false;
        return new Promise(resolve => { window.releaseOld = () => resolve(action === 'status'
          ? window.snapshot(captured) : action === 'prepare' ? { artifact: { id: captured, state: 'preparing', size: 10 } }
            : { share: window.share(captured) }); });
      }
      if (action === 'status') return window.snapshot(window.next, window.preparing ? 'preparing' : 'ready', window.withShare);
      if (action === 'prepare') return { artifact: { id: captured, state: 'preparing', size: 10 } };
      if (action === 'create') return { share: window.share(args.artifactId) };
      if (action === 'revoke') return { share: { ...window.share(captured), state: 'revoked' } };
      throw new Error('Unexpected synthetic action');
    });
  });
  return page;
}
async function open(page, path) {
  await page.evaluate(path => window.AgentHubFileTransferOwner.open({ path, trigger: document.querySelector('#open') }), path);
}
async function close(page) {
  // Escape dismisses the confirmation first, if present, then the owning dialog.
  if (await page.locator('.file-transfer-revoke-dialog[open]').count()) await page.keyboard.press('Escape');
  await page.locator('.file-transfer-owner-close').click();
  await page.waitForFunction(() => !document.querySelector('.file-transfer-owner-dialog').open);
}

for (const samePath of [false, true]) for (const action of ['status', 'create', 'prepare', 'poll', 'revoke']) {
  test(`late ${action} cannot change reopened dialog; samePath=${samePath}`, { timeout: 15000 }, async t => {
    const page = await pageFixture(t);
    const pathA = '/workspace/A.bin', pathB = samePath ? pathA : '/workspace/B.bin';
    if (action === 'status') {
      await page.evaluate(path => {
        window.heldAction = 'status';
        window.oldOpen = window.AgentHubFileTransferOwner.open({ path });
      }, pathA);
    } else {
      await page.evaluate(action => { window.preparing = action === 'poll'; window.withShare = action === 'revoke'; }, action);
      await open(page, pathA);
      if (action === 'poll') await page.evaluate(() => { window.holdNextStatus = true; });
      else {
        await page.evaluate(action => { window.heldAction = action; }, action);
        if (action === 'prepare') {
          // Current source has no prepared artifact: explicit create starts preparation.
          await close(page);
          await page.evaluate(() => {
            window.preparing = false;
            const handler = async (act, args) => {
              window.calls.push({ action: act, args });
              if (act === 'status') return { ...window.snapshot(window.next), artifact: window.next === 'A' ? null : window.snapshot('B').artifact };
              if (act === 'prepare') return new Promise(resolve => { window.releaseOld = () => resolve({ artifact: { id: 'A', state: 'preparing', size: 10 } }); });
              if (act === 'create') return { share: window.share(args.artifactId) };
              throw new Error('Unexpected synthetic action');
            };
            window.AgentHubFileTransferOwner.configure(handler);
          });
          await open(page, pathA);
        }
        await page.getByRole('button', { name: action === 'revoke' ? 'Отозвать ссылку' : 'Создать ссылку', exact: true }).click();
        if (action === 'revoke') await page.locator('[data-transfer-confirm-revoke]').click();
      }
    }
    await page.waitForFunction(() => Boolean(window.releaseOld));
    await close(page);
    await page.evaluate(() => { window.next = 'B'; window.preparing = false; window.withShare = false; });
    await open(page, pathB);
    assert.equal(await page.locator('.file-transfer-owner-file strong').innerText(), 'B.bin');
    const before = await page.evaluate(() => window.calls.length);
    await page.evaluate(async () => { window.releaseOld(); if (window.oldOpen) await window.oldOpen; await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.locator('.file-transfer-owner-file strong').innerText(), 'B.bin');
    assert.equal(await page.locator('[data-transfer-url]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Создать ссылку', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.calls.length), before, 'late result must not dispatch a new intent or poll');
    const capture = process.env.AGENT_HUB_TRANSFER_RACE_CAPTURE_DIR;
    if (capture && ['status', 'create'].includes(action)) {
      await mkdir(capture, { recursive: true });
      await page.screenshot({ path: `${capture}/late-${action}-${samePath ? 'same' : 'different'}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: 'Создать ссылку', exact: true }).click();
    await page.getByRole('button', { name: 'Копировать ссылку', exact: true }).waitFor();
    assert.equal(await page.locator('[data-transfer-url]').inputValue(), 'https://files.example.test/#B');
    const creates = await page.evaluate(() => window.calls.filter(c => c.action === 'create'));
    assert.equal(creates.at(-1).args.artifactId, 'B');
  });
}

for (const samePath of [false, true]) test(`late revoke cannot dismiss a newer confirmation; samePath=${samePath}`, { timeout: 15000 }, async t => {
  const page = await pageFixture(t);
  await page.evaluate(() => { window.withShare = true; });
  await open(page, '/workspace/A.bin');
  await page.evaluate(() => { window.heldAction = 'revoke'; });
  await page.getByRole('button', { name: 'Отозвать ссылку', exact: true }).click();
  await page.locator('[data-transfer-confirm-revoke]').click();
  await page.waitForFunction(() => Boolean(window.releaseOld));
  await close(page);
  await page.evaluate(() => { window.next = 'B'; });
  await open(page, samePath ? '/workspace/A.bin' : '/workspace/B.bin');
  await page.getByRole('button', { name: 'Отозвать ссылку', exact: true }).click();
  await page.evaluate(async () => { window.releaseOld(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(await page.locator('.file-transfer-revoke-dialog[open]').count(), 1);
  assert.equal(await page.locator('[data-transfer-confirm-revoke]').isEnabled(), true);
  await page.locator('[data-transfer-confirm-revoke]').click();
  await page.waitForFunction(() => !document.querySelector('.file-transfer-revoke-dialog').open);
  const calls = await page.evaluate(() => window.calls.filter(c => c.action === 'revoke'));
  assert.deepEqual(calls.map(c => c.args.shareId), ['share-A', 'share-B']);
});

test('ambiguous create keeps its exact idempotency envelope in the same opening', { timeout: 15000 }, async t => {
  const page = await pageFixture(t);
  await page.evaluate(() => {
    window.AgentHubFileTransferOwner.configure(async (action, args) => {
      window.calls.push({ action, args });
      if (action === 'status') return window.snapshot('A');
      if (action === 'create') {
        if (window.calls.filter(c => c.action === 'create').length === 1) throw new Error('synthetic lost reply');
        return { share: window.share('A') };
      }
      throw new Error('Unexpected synthetic action');
    });
  });
  await open(page, '/workspace/A.bin');
  await page.getByRole('button', { name: 'Создать ссылку', exact: true }).click();
  await page.getByRole('button', { name: 'Копировать ссылку', exact: true }).waitFor();
  const creates = await page.evaluate(() => window.calls.filter(c => c.action === 'create'));
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1].args, creates[0].args);
});
