import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser } from "./composer-production.fixture.mjs";

const assets = new URL("../../assets/web-app/", import.meta.url);
const evidence = new URL("../../WIP/composer-shortcuts-captures/", import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = createRequire(import.meta.url)("../../theme-registry.cjs");
const registry = loadThemeRegistry(fileURLToPath(assets));
async function open(page, { vscode = false } = {}) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((vscode) => { if (vscode) window.__agentHubVscode = { postMessage() {} }; }, vscode);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    if (url.pathname === "/") {
      let body = await readFile(new URL("index.html", assets), "utf8");
      body = body.replace(/\s*<script src="\/(?:browser-device-auth|hub-client)\.js" defer><\/script>/gu, "");
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: renderThemeHtml(body, registry) });
    }
    try {
      const body = await readFile(url.pathname === "/work-log.css" ? new URL("../../work-log.css", import.meta.url) : new URL(url.pathname.slice(1), assets));
      return route.fulfill({ contentType: /\.css$/u.test(url.pathname) ? "text/css" : /\.js$/u.test(url.pathname) ? "text/javascript" : "image/png", body });
    } catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("https://agent-hub.test/");
  await page.waitForFunction(() => window.AgentHub && window.AgentHubComposerShortcuts);
  const mobile = await page.locator("html").getAttribute("data-mobile-dialogs-enabled") !== null;
  if (mobile) await page.locator(".mobile-dialogs-top").getByRole("button", { name: "Настройки AgentHub", exact: true }).click();
  else await page.locator('[data-panel-open="settings"]').click();
  await page.locator("[data-composer-shortcuts-open]").click();
  return errors;
}

test("personal shortcut modal saves atomically, confirms discard and retains failed draft", async () => {
  const browser = await launchBrowser();
  await mkdir(evidence, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = await open(page);
    assert.equal(await page.locator("#composer-shortcuts-intro").innerText(),
      "Настройте действия клавиш Enter в поле ввода. Изменения сохраняются только в этом браузере или WebView.");
    const modal = page.locator("[data-composer-shortcuts-dialog]");
    assert.equal(await modal.getAttribute("aria-describedby"), "composer-shortcuts-intro");
    assert.deepEqual(await modal.locator("select").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-describedby"))), [null, null, null]);
    assert.deepEqual(await modal.locator("#composer-shortcuts-helper p").allTextContents(), [
      "«В очередь» отправляет сообщение отдельным запросом.",
      "«В текущий ход» использует существующее действие продолжения активного хода.",
      "«Перенос строки» добавляет новую строку, не отправляя сообщение.",
      "Другие сочетания клавиш сохраняют текущее поведение и здесь не настраиваются.",
    ]);
    const values = () => modal.locator("[data-composer-shortcut]").evaluateAll((nodes) => nodes.map((n) => n.value));
    assert.deepEqual(await values(), ["queue", "newline", "newline"]);
    assert.equal(await page.getByLabel("Действие для Enter", { exact: true }).evaluate((n) => n === document.activeElement), true);
    await page.screenshot({ path: fileURLToPath(new URL("web-default-1280.png", evidence)) });
    await page.getByLabel("Действие для Control + Enter", { exact: true }).selectOption("steer");
    await modal.getByRole("heading", { name: "Сочетания клавиш", exact: true }).click();
    await page.screenshot({ path: fileURLToPath(new URL("web-author-override-1280.png", evidence)) });
    await page.keyboard.press("Escape");
    const discard = page.locator("[data-composer-shortcuts-discard]");
    assert.equal(await discard.evaluate((n) => n.open), true);
    assert.equal(await discard.getAttribute("aria-describedby"), "composer-shortcuts-discard-description");
    assert.equal(await discard.locator("#composer-shortcuts-discard-description").innerText(), "Изменения сочетаний будут потеряны.");
    assert.equal(await discard.locator("button").first().innerText(), "Продолжить настройку");
    assert.equal(await page.locator("[data-composer-shortcuts-keep]").evaluate((n) => n === document.activeElement), true);
    assert.equal(await page.locator("[data-composer-shortcuts-discard-confirm]").getAttribute("class"), "chip-button danger");
    assert.equal(await modal.evaluate((n) => n.open), true);
    await page.locator("[data-composer-shortcuts-keep]").click();
    assert.deepEqual(await values(), ["queue", "steer", "newline"]);
    await modal.getByRole("button", { name: "Сохранить", exact: true }).click();
    assert.equal(await modal.evaluate((n) => n.open), false);
    assert.equal(await page.locator("[data-composer-shortcuts-open]").evaluate((n) => n === document.activeElement), true);
    assert.equal(await page.locator("[data-composer-shortcuts-summary]").innerText(), "Настроено");
    assert.equal(await page.locator("[data-composer-shortcuts-saved]").innerText(), "Сочетания сохранены");
    await page.screenshot({ path: fileURLToPath(new URL("web-saved-entry-1280.png", evidence)) });
    await page.reload();
    await page.locator('[data-panel-open="settings"]').click(); await page.locator("[data-composer-shortcuts-open]").click();
    assert.deepEqual(await values(), ["queue", "steer", "newline"]);
    await modal.getByRole("button", { name: "Восстановить стандартные", exact: true }).click();
    assert.deepEqual(await values(), ["queue", "newline", "newline"]);
    assert.equal(await page.evaluate(() => window.AgentHubComposerShortcuts.stored(localStorage).mapping.ctrlEnter), "steer");
    await page.evaluate(() => AgentHub.navigateBack());
    await page.locator("[data-composer-shortcuts-discard-confirm]").click();
    await page.locator("[data-composer-shortcuts-open]").click();
    for (const select of await modal.locator("select").all()) await select.selectOption("queue");
    assert.equal(await modal.locator("[data-composer-shortcuts-warning]").isVisible(), true);
    assert.equal(await modal.locator("[data-composer-shortcuts-warning]").getAttribute("aria-live"), "polite");
    await page.screenshot({ path: fileURLToPath(new URL("web-duplicate-no-newline-1280.png", evidence)) });
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === window.AgentHubComposerShortcuts.STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
        return original.call(this, key, value);
      };
      window.restoreShortcutStorage = () => { Storage.prototype.setItem = original; };
    });
    await modal.getByRole("button", { name: "Сохранить", exact: true }).click();
    assert.equal(await modal.getByRole("alert").innerText(), "Не удалось сохранить сочетания. Попробуйте ещё раз.");
    assert.deepEqual(await values(), ["queue", "queue", "queue"]);
    assert.equal(await page.evaluate(() => window.AgentHubComposerShortcuts.stored(localStorage).mapping.ctrlEnter), "steer");
    await page.screenshot({ path: fileURLToPath(new URL("web-save-failure-1280.png", evidence)) });
    await page.evaluate(() => window.restoreShortcutStorage());
    await modal.getByRole("button", { name: "Сохранить", exact: true }).click();
    assert.deepEqual(errors, []);
    // A different browser profile/origin storage owner cannot inherit this override.
    const other = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    assert.deepEqual(await open(other), []);
    assert.deepEqual(await other.locator("[data-composer-shortcut]").evaluateAll((nodes) => nodes.map((n) => n.value)), ["queue", "newline", "newline"]);
  } finally { await browser.close(); }
});

test("shortcut settings reflow on narrow WebView/mobile with hardware note and touch targets", async () => {
  const browser = await launchBrowser();
  await mkdir(evidence, { recursive: true });
  try {
    for (const [width, vscode, height = 1000] of [[520, true], [390, true], [320, false], [390, false], [320, false, 568], [320, false, 640]]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: !vscode, hasTouch: !vscode });
      const errors = await open(page, { vscode });
      await page.locator("[data-theme-select]").evaluate((select, theme) => { select.value = theme; select.dispatchEvent(new Event("change", { bubbles: true })); }, vscode ? "orbit" : "orange");
      await page.waitForFunction(() => {
        const modal = document.querySelector("[data-composer-shortcuts-dialog]");
        const probe = document.createElement("i"); probe.style.color = "var(--text)"; modal.append(probe);
        const expected = getComputedStyle(probe).color; probe.remove();
        return getComputedStyle(modal.querySelector("footer [data-composer-shortcuts-cancel]")).color === expected;
      });
      assert.deepEqual(await page.locator("[data-composer-shortcut]").evaluateAll((nodes) => nodes.map((n) => n.value)), [vscode ? "queue" : "newline", "newline", "newline"]);
      assert.equal(await page.getByLabel("Действие для Enter", { exact: true }).isDisabled(), !vscode);
      assert.equal(await page.getByLabel("Действие для Control + Enter", { exact: true }).isEnabled(), true);
      const modal = page.locator("[data-composer-shortcuts-dialog]");
      assert.equal(await modal.getByRole("button", { name: "Восстановить стандартные", exact: true }).isDisabled(), true);
      assert.equal(await modal.getByRole("button", { name: "Отмена", exact: true }).isEnabled(), true);
      const contrast = await modal.evaluate((node) => {
        const parse = (value) => value.match(/[\d.]+/g).map(Number);
        const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
        const lum = (c) => c.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const probe = document.createElement("i");
        probe.style.backgroundColor = "var(--space-base)"; node.append(probe);
        const base = parse(getComputedStyle(probe).backgroundColor); probe.remove();
        const cancel = node.querySelector("footer [data-composer-shortcuts-cancel]");
        const restore = node.querySelector("[data-composer-shortcuts-restore]");
        const style = getComputedStyle(cancel);
        const bg = over(parse(style.backgroundColor), base), fg = over(parse(style.color), bg);
        return { color: style.color, background: style.backgroundColor, base, fg, bg, ratio: (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05),
          enabledOpacity: Number(style.opacity), disabledOpacity: Number(getComputedStyle(restore).opacity) };
      });
      assert.ok(contrast.ratio >= 4.5, JSON.stringify({ width, vscode, contrast }));
      assert.ok(contrast.enabledOpacity > contrast.disabledOpacity);
      assert.equal(await page.locator(".composer-shortcuts-mobile-helper").isVisible(), !vscode);
      assert.equal(await page.locator("[data-composer-shortcuts-dialog]").evaluate((modal) => {
        const rect = modal.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && modal.scrollWidth <= modal.clientWidth
          && [...modal.querySelectorAll("select, footer button")].every((n) => n.getBoundingClientRect().height >= 44)
          && [...modal.querySelectorAll(".composer-shortcut-row")].every((n) => {
            const label = n.querySelector("span").getBoundingClientRect(), select = n.querySelector("select").getBoundingClientRect();
            return label.bottom <= select.top;
          });
      }), true);
      assert.equal(await modal.evaluate((node) => {
        const rect = node.getBoundingClientRect(), header = node.querySelector("header").getBoundingClientRect(), footer = node.querySelector("footer").getBoundingClientRect();
        const fields = node.querySelector(".composer-shortcuts-fields");
        return rect.top >= 0 && rect.bottom <= innerHeight && header.top >= rect.top && footer.bottom <= rect.bottom
          && (fields.scrollHeight <= fields.clientHeight || getComputedStyle(fields).overflowY === "auto");
      }), true);
      await page.screenshot({ path: fileURLToPath(new URL(`${vscode ? "webview" : "mobile"}-${width}${height === 1000 ? "" : "-" + height}.png`, evidence)) });
      if (height < 1000) {
        await modal.locator(".composer-shortcuts-fields").evaluate((node) => { node.scrollTop = node.scrollHeight; });
        assert.equal(await modal.locator(".composer-shortcuts-mobile-note").isVisible(), true);
        await page.screenshot({ path: fileURLToPath(new URL(`mobile-${width}-${height}-scrolled.png`, evidence)) });
      }
      if (!vscode) {
        // Disabled display is never persisted as a false desktop Enter override.
        await page.getByLabel("Действие для Control + Enter", { exact: true }).selectOption("queue");
        await modal.getByRole("button", { name: "Сохранить", exact: true }).click();
        assert.equal(await page.evaluate(() => AgentHubComposerShortcuts.stored(localStorage).mapping.enter), "queue");
        await page.locator("[data-composer-shortcuts-open]").click();
      }
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("[data-composer-shortcuts-open]").evaluate((n) => document.activeElement === n), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
