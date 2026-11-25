import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

const { loadThemeRegistry } = createRequire(import.meta.url)("../../theme-registry.cjs");
const themeRegistry = loadThemeRegistry(fileURLToPath(new URL("../../assets/web-app/", import.meta.url)));
const output = fileURLToPath(new URL("../../WIP/task-lifecycle-captures/", import.meta.url));
const surfaces = [
  { name: "web-1280", width: 1280, surface: "web" },
  { name: "webview-520", width: 520, surface: "vscode" },
  { name: "webview-390", width: 390, surface: "vscode" },
  { name: "mobile-430", width: 430, surface: "web" },
  { name: "mobile-390", width: 390, surface: "web" },
  { name: "mobile-320", width: 320, surface: "web" },
];
const title = "Проверить безопасное удаление — длинное название задачи с Unicode 🧭 и сохранением истории";
const makeTask = (id, name = id) => ({ id, title: name, text: name, description: "",
  taskNumber: "QA-122", status: "new", workflowStatus: "new", bucket: "workspace",
  workspaceId: "workspace-1", revision: 1, attachments: [], checklist: [] });

async function setup(page, surface) {
  await page.addInitScript(() => {
    localStorage.setItem("agent-hub.dashboard.task-open", "modal");
    localStorage.setItem("agent-hub.dashboard.view", "list");
  });
  const data = snapshot();
  data.boardTasks = [makeTask("before"), makeTask("subject", title), makeTask("after")];
  const diagnostics = await openFixture(page, { fixtureSnapshot: data, surface: surface.surface, themeRegistry });
  await page.locator('[data-mobile-dialogs-tab="dashboard"]:visible, [data-mobile-button="dashboard"]:visible, [data-view-button="dashboard"]:visible').first().click();
  await page.evaluate(() => {
    window.__lifecycleCalls = [];
    window.__lifecycleHeld = [];
    const previous = window.__fixtureBridge.postMessage;
    window.__fixtureBridge.postMessage = message => {
      if (!["board-task-complete", "board-task-remove"].includes(message.action)) return previous(message);
      window.__lifecycleCalls.push(structuredClone(message));
      window.__lifecycleHeld.push(message);
    };
    window.__settleLifecycle = ({ error = "", preview = false } = {}) => {
      const message = window.__lifecycleHeld.shift();
      if (!message) throw new Error("No held lifecycle command");
      let result = window.__agentHubFixture.snapshot;
      if (preview) result = { lifecycleResult: {
        confirmationRequired: true, cleanupToken: "exact-cleanup-token",
        task: { taskNumber: "QA-122" }, warning: "Cleanup requires explicit confirmation",
        preview: { deleting: [{ kind: "branch", name: "QA-122" }] },
      } };
      else if (!error) {
        const tasks = result.boardTasks;
        result = { ...result, version: String(Date.now()), boardTasks: message.action === "board-task-remove"
          ? tasks.filter(task => task.id !== message.params.id)
          : tasks.map(task => task.id === message.params.id ? { ...task, status: "done" } : task) };
        window.__agentHubFixture.snapshot = result;
      }
      window.dispatchEvent(new MessageEvent("message", { data: {
        type: "agenthub:control-result", id: message.id, ok: !error, result, error,
      } }));
    };
  });
  return diagnostics;
}

async function openCard(page, id = "subject") {
  await page.locator(`[data-task-board-columns] [data-board-task-id="${id}"]`).click();
  await page.locator("[data-task-card-modal]").waitFor({ state: "visible" });
  await page.locator("[data-task-delete-trigger]").scrollIntoViewIfNeeded();
}

async function metrics(page) {
  return page.evaluate(() => {
    const rect = n => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const zone = document.querySelector(".task-lifecycle-actions");
    const dialog = document.querySelector("[data-task-delete-modal]");
    const visible = n => n.checkVisibility() && n.getBoundingClientRect().height > 0;
    const buttons = [...document.querySelectorAll(".task-lifecycle-button, [data-task-delete-modal] button")].filter(visible);
    const rows = [...zone.querySelectorAll(".task-lifecycle-row")].map(n => ({
      helper: rect(n.querySelector("p")), button: rect(n.querySelector("button")),
    }));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = color => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const over = (front, back) => front.slice(0, 3).map((v, i) => v * front[3] / 255 + back[i] * (1 - front[3] / 255));
    const bg = element => {
      const chain = []; for (let n = element; n; n = n.parentElement) chain.unshift(n);
      let result = rgba(getComputedStyle(document.documentElement).getPropertyValue("--bg"));
      for (const n of chain) result = over(rgba(getComputedStyle(n).backgroundColor), result);
      return result;
    };
    const lum = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const ratio = (color, background) => {
      const a = lum(over(rgba(color), background)), b = lum(background);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const texts = [...zone.querySelectorAll("p, button, h3"),
      ...(dialog.open ? dialog.querySelectorAll("h2, p, button") : [])].filter(visible);
    const contrast = texts.map(n => ({ text: n.textContent, color: getComputedStyle(n).color,
      ratio: ratio(getComputedStyle(n).color, bg(n)) }));
    const accentProbe = document.createElement("span");
    accentProbe.style.color = "var(--accent)"; zone.append(accentProbe);
    const accentColor = getComputedStyle(accentProbe).color;
    accentProbe.style.color = "var(--task-lifecycle-danger)";
    const taskLifecycleDanger = getComputedStyle(accentProbe).color; accentProbe.remove();
    const danger = zone.querySelector(".is-danger");
    return { targets: buttons.map(n => ({ text: n.textContent, ...rect(n) })),
      contrast,
      focusContrast: ratio(accentColor, bg(zone)),
      boundaryContrast: buttons.filter(n => n === danger || n.matches(".task-delete-confirm"))
        .map(n => ratio(getComputedStyle(n).borderTopColor, bg(n))),
      taskLifecycleDanger,
      accentColor,
      zone: rect(zone), rows, dialog: dialog.open ? rect(dialog) : null,
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      dialogOverflow: dialog.open ? dialog.scrollWidth - dialog.clientWidth : 0,
      primaryBackground: getComputedStyle(document.querySelector(".task-primary-actions .board-task-primary")).backgroundColor,
      deleteBackground: getComputedStyle(zone.querySelector(".is-danger")).backgroundColor,
      dangerColor: getComputedStyle(zone.querySelector(".is-danger")).color,
      focusColor: getComputedStyle(zone.querySelector(".is-danger")).outlineColor,
      viewport: { width: innerWidth, height: innerHeight },
      copy: [...zone.querySelectorAll("button")].map(n => ({ text: n.textContent,
        describedBy: n.getAttribute("aria-describedby"), helper: document.getElementById(n.getAttribute("aria-describedby")).textContent })),
    };
  });
}

function assertMetrics(m, width) {
  assert.ok(m.targets.every(r => r.width >= 44 && r.height >= 44), JSON.stringify(m.targets));
  assert.equal(m.overflow, 0);
  for (const row of m.rows) {
    if (width <= 600) {
      assert.ok(row.helper.bottom <= row.button.y);
      assert.ok(Math.abs(row.button.width - m.zone.width) <= 1);
    } else assert.ok(row.helper.right <= row.button.x);
  }
  assert.equal(m.deleteBackground, "rgba(0, 0, 0, 0)");
  assert.ok(m.contrast.every(n => n.ratio >= 4.5), JSON.stringify(m.contrast));
  assert.ok(m.focusContrast >= 3);
  assert.ok(m.boundaryContrast.every(ratio => ratio >= 3));
  assert.notEqual(m.dangerColor, m.accentColor);
  if (m.dialog) {
    assert.ok(m.dialog.x >= 11 && m.dialog.right <= width - 11, JSON.stringify(m.dialog));
    assert.ok(m.dialog.y >= 0 && m.dialog.bottom <= m.viewport.height);
    assert.equal(m.dialogOverflow, 0);
  }
}

for (const surface of surfaces) test(`lifecycle actions preserve archive/delete safety on ${surface.name}`, { timeout: 60000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: surface.width, height: 900 },
      isMobile: surface.name.startsWith("mobile"), hasTouch: surface.name.startsWith("mobile") });
    page.setDefaultTimeout(8000);
    const diagnostics = await setup(page, surface);
    await mkdir(output, { recursive: true });
    const measurements = {};
    for (const theme of ["nebula", "orange"]) {
      await page.locator("[data-theme-select]").evaluate((n, value) => {
        n.value = value; n.dispatchEvent(new Event("change", { bubbles: true }));
      }, theme);
      await openCard(page);
      const group = page.getByRole("group", { name: "Действия с карточкой" });
      assert.equal(await group.getByRole("button").count(), 2);
      assert.equal(await page.getByRole("button", { name: "Закрыть в архив", exact: true }).count(), 1);
      const trigger = page.locator("[data-task-delete-trigger]");
      await trigger.focus();
      await trigger.press("Shift+Tab");
      assert.equal(await page.locator("[data-task-archive-trigger]").evaluate(n => n === document.activeElement), true);
      await page.keyboard.press("Tab");
      await trigger.press("Enter");
      const dialog = page.locator("[data-task-delete-modal]");
      const cancel = page.locator("[data-task-delete-cancel]");
      const confirm = page.locator("[data-task-delete-confirm]");
      assert.equal(await cancel.evaluate(n => n === document.activeElement), true);
      assert.equal(await dialog.getAttribute("aria-describedby"), "task-delete-description");
      assert.match(await dialog.innerText(), /Удалить задачу безвозвратно\?/u);
      assert.ok((await dialog.innerText()).includes(`Карточка «${title}»`));
      assert.ok((await dialog.innerText()).includes("Закрыть в архив"));
      await cancel.press("Shift+Tab");
      assert.equal(await confirm.evaluate(n => n === document.activeElement), true);
      await confirm.press("Tab");
      assert.equal(await cancel.evaluate(n => n === document.activeElement), true);
      assert.equal(await page.evaluate(() => window.__lifecycleCalls.length), 0);
      measurements[theme + "-dialog"] = await metrics(page);
      assertMetrics(measurements[theme + "-dialog"], surface.width);
      await page.screenshot({ path: `${output}/${surface.name}-${theme}-delete.png` });
      await cancel.press("Enter");
      assert.equal(await dialog.isVisible(), false, "Enter on Cancel cannot delete");
      assert.equal(await trigger.evaluate(n => n === document.activeElement), true);
      measurements[theme + "-footer"] = await metrics(page);
      assertMetrics(measurements[theme + "-footer"], surface.width);
      await page.screenshot({ path: `${output}/${surface.name}-${theme}-footer.png` });
      await trigger.click();
      await cancel.press("Escape");
      assert.equal(await trigger.evaluate(n => n === document.activeElement), true);
      await trigger.click();
      await page.mouse.click(1, 1);
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate(n => n === document.activeElement), true);
      assert.equal(await page.evaluate(() => window.__lifecycleCalls.length), 0);
      await page.locator("[data-task-card-close]").click();
    }

    await openCard(page);
    const trigger = page.locator("[data-task-delete-trigger]");
    await trigger.click();
    const dialog = page.locator("[data-task-delete-modal]");
    const confirm = page.locator("[data-task-delete-confirm]");
    await confirm.focus();
    await confirm.press("Space");
    await page.waitForFunction(() => window.__lifecycleCalls.length === 1);
    assert.equal(await dialog.getAttribute("aria-busy"), "true");
    assert.equal(await confirm.isDisabled(), true);
    await confirm.evaluate(n => { n.click(); n.click(); });
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await page.evaluate(() => window.__lifecycleCalls.length), 1);
    await page.evaluate(() => window.__settleLifecycle({ error: "Deletion refused by server" }));
    await page.locator("[data-task-delete-error]").waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-task-delete-error]").innerText(), "Deletion refused by server");
    assert.equal(await page.locator("[data-task-delete-cancel]").evaluate(n => n === document.activeElement), true);
    assert.equal(await confirm.isDisabled(), false);
    measurements["orange-failure"] = await metrics(page);
    assertMetrics(measurements["orange-failure"], surface.width);
    await page.screenshot({ path: `${output}/${surface.name}-orange-failure.png` });
    // Existing exact cleanup confirmation remains an independent mandatory boundary.
    await confirm.click();
    await page.waitForFunction(() => window.__lifecycleCalls.length === 2);
    await page.evaluate(() => window.__settleLifecycle({ preview: true }));
    await page.locator("[data-task-cleanup-modal]").waitFor({ state: "visible" });
    await page.locator("[data-task-cleanup-cancel]").click();
    await page.waitForFunction(() => document.querySelector("[data-task-delete-modal]").getAttribute("aria-busy") === "false");
    assert.equal(await page.evaluate(() => window.__lifecycleCalls.length), 2);
    await confirm.click();
    await page.waitForFunction(() => window.__lifecycleCalls.length === 3);
    await page.evaluate(() => window.__settleLifecycle());
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.dataset.boardTaskId === "after");
    assert.equal(await page.locator("[data-task-lifecycle-status]").textContent(), "Задача удалена.");
    assert.equal(await page.locator('[data-task-board-columns] [data-board-task-id="subject"]').count(), 0);

    await openCard(page, "after");
    await page.locator("[data-task-archive-trigger]").click();
    await page.waitForFunction(() => window.__lifecycleCalls.length === 4);
    assert.equal(await dialog.isVisible(), false, "archive does not open delete confirmation");
    assert.equal(await page.evaluate(() => window.__lifecycleCalls.at(-1).action), "board-task-complete");
    await page.evaluate(() => window.__settleLifecycle());
    await page.waitForFunction(() => document.activeElement?.dataset.boardTaskId === "before");
    assert.equal(await page.locator("[data-task-lifecycle-status]").textContent(), "Задача закрыта и сохранена в архиве.");
    await openCard(page, "before");
    await page.locator("[data-task-archive-trigger]").click();
    await page.waitForFunction(() => window.__lifecycleCalls.length === 5);
    await page.evaluate(() => window.__settleLifecycle());
    await page.waitForFunction(() => document.activeElement?.tagName === "H2");
    assert.equal(await page.evaluate(() => document.activeElement.tabIndex), -1);
    // Web's deliberately refused control request produces one HTTP 400 console
    // diagnostic; the WebView bridge returns the same typed error without HTTP.
    assert.deepEqual(diagnostics, surface.surface === "web"
      ? ["Failed to load resource: the server responded with a status of 400 (Bad Request)"] : []);
    await writeFile(`${output}/${surface.name}-metrics.json`, JSON.stringify(measurements, null, 2));
  } finally { await browser.close(); }
});

for (const target of ["after", "subject"]) {
  for (const succeeded of [true, false]) {
    test(`late archive ${succeeded ? "success" : "refusal"} preserves the new opening of ${target}`, { timeout: 30000 }, async () => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const diagnostics = await setup(page, { surface: "web" });
        const modal = page.locator("[data-task-card-modal]");
        const editor = modal.locator("[data-task-card-title]");
        await openCard(page);
        await modal.locator("[data-task-archive-trigger]").click();
        await page.waitForFunction(() => window.__lifecycleHeld.length === 1);
        await modal.locator("[data-task-card-close]").click();
        await openCard(page, target);
        await editor.fill("Unsaved title for the new opening");

        const refusal = "Archive refused by server";
        await page.evaluate(error => window.__settleLifecycle({ error }), succeeded ? "" : refusal);
        await page.waitForFunction(({ succeeded, refusal }) => succeeded
          ? document.querySelector("[data-task-lifecycle-status]").textContent.includes("архиве")
          : document.querySelector("[data-toast]").textContent.includes(refusal), { succeeded, refusal });

        assert.equal(await modal.isVisible(), true);
        assert.equal(await editor.inputValue(), "Unsaved title for the new opening");
        assert.equal(await editor.evaluate(input => input === document.activeElement), true);
        const board = page.locator("[data-task-board-columns]");
        assert.equal(await board.locator('[data-board-task-id="subject"]').count(), succeeded ? 0 : 1);
        assert.equal(await board.locator('[data-board-task-id="after"]').count(), 1);
        if (!succeeded && target === "subject") {
          assert.equal(await modal.locator("[data-task-archive-trigger]").isEnabled(), true);
        }
        const calls = await page.evaluate(() => window.__lifecycleCalls.map(({ action, params }) => [action, params.id]));
        assert.deepEqual(calls, [["board-task-complete", "subject"]]);
        assert.deepEqual(diagnostics, succeeded
          ? [] : ["Failed to load resource: the server responded with a status of 400 (Bad Request)"]);
      } finally { await browser.close(); }
    });
  }
}

test("card opened from the conversation Task rail returns focus to its own next Task", { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const diagnostics = await setup(page, { width: 1280, surface: "vscode" });
    await page.locator('[data-view-button="chat"]:visible').click();
    const railTask = page.locator('.workspace-task-list [data-board-task-id="subject"]:visible').first();
    await railTask.click();
    await page.locator("[data-task-archive-trigger]").click();
    await page.waitForFunction(() => window.__lifecycleCalls.length === 1);
    await page.evaluate(() => window.__settleLifecycle());
    await page.waitForFunction(() => document.activeElement?.dataset.boardTaskId === "after"
      && document.activeElement.closest(".workspace-task-list"));
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});

test("long delete confirmation fits a short mobile viewport and text zoom", { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 420 }, isMobile: true, hasTouch: true });
    const diagnostics = await setup(page, { width: 320, surface: "web" });
    await openCard(page);
    await page.locator("[data-task-delete-trigger]").click();
    assertMetrics(await metrics(page), 320);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/mobile-320-short-delete.png` });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    assertMetrics(await metrics(page), 320);
    await page.screenshot({ path: `${output}/mobile-320-text-zoom-delete.png` });
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});
