import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

const { loadThemeRegistry } = createRequire(import.meta.url)("../../theme-registry.cjs");
const themeRegistry = loadThemeRegistry(fileURLToPath(new URL("../../assets/web-app/", import.meta.url)));
const base = fileURLToPath(new URL("../../WIP/cleanup-dialog-runs/", import.meta.url));
await mkdir(base, { recursive: true });
// Every execution owns a fresh mutable output. Reviewed bundles are copied to
// a different frozen directory; reruns never overwrite accepted evidence.
const output = await mkdtemp(path.join(base, "run-"));
console.log("Cleanup evidence output:", output);
const surfaces = [
  { name: "web-1280", width: 1280, surface: "web" },
  { name: "webview-520", width: 520, surface: "vscode" },
  { name: "webview-390", width: 390, surface: "vscode" },
  { name: "mobile-430", width: 430, surface: "web", touch: true },
  { name: "mobile-390", width: 390, surface: "web", touch: true },
  { name: "mobile-320", width: 320, surface: "web", touch: true },
];

async function setup(page, surface) {
  const diagnostics = await openFixture(page, { surface: surface.surface, themeRegistry });
  await page.evaluate(() => {
    const opener = document.createElement("button");
    opener.type = "button"; opener.textContent = "Открыть подтверждение";
    opener.setAttribute("data-cleanup-fixture-opener", "");
    document.body.append(opener);
    window.__cleanupCalls = [];
    window.__beginCleanup = (action, deleting = true) => {
      opener.focus();
      window.__cleanupOutcome = null; window.__cleanupError = null;
      const confirmation = { task: { taskNumber: "QA-122" }, cleanupToken: "EXACT-private-token",
        warning: "Complete closes the Task <literal server warning>",
        preview: { dirty: true, workspaces: [{ branch: "QA-122/ветка",
          projectRoot: "fixture/очень-длинная-папка/" + "long-path-".repeat(18),
          headCommit: "a".repeat(40), dirty: true, changedPaths: ["src/изменение.mjs"],
          untrackedPaths: ["new.mjs"], ignoredPaths: ["WIP/сохранить.txt"] }],
          gitReferences: [{ projectRoot: "fixture/repository", branch: "QA-122",
            resultCommit: "b".repeat(40), published: false,
            publishedRevision: "c".repeat(40), publicationGeneration: "raw-generation" }],
          deleting: deleting ? [{ kind: "future_kind", path: "fixture/удаляемый-путь",
            repositoryRoot: "fixture/repository" }] : [] },
      };
      window.__cleanupPending = window.AgentHubTaskCleanupConfirmation.confirm({
        action, params: { id: "exact-task", operationId: "exact-operation" }, confirmation,
        request: (requestedAction, params) => {
          window.__cleanupCalls.push({ action: requestedAction, params });
          return new Promise((resolve, reject) => {
            window.__cleanupResolve = () => resolve({ completed: requestedAction === "board-task-complete",
              deleted: requestedAction === "board-task-remove" });
            window.__cleanupReject = () => reject(new Error("Предпросмотр устарел. Откройте подтверждение заново."));
          });
        },
      }).then(value => { window.__cleanupOutcome = value; },
        error => { window.__cleanupError = error.message; });
    };
  });
  return diagnostics;
}

async function measure(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector("[data-task-cleanup-modal]");
    const cancel = dialog.querySelector("[data-task-cleanup-cancel]");
    const confirm = dialog.querySelector("[data-task-cleanup-confirm]");
    const rect = n => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const over = (front, back) => front.slice(0, 3).map((v, i) => v * front[3] / 255 + back[i] * (1 - front[3] / 255));
    const bg = n => {
      const chain = []; for (let e = n; e; e = e.parentElement) chain.unshift(e);
      let rgb = rgba(getComputedStyle(document.documentElement).getPropertyValue("--bg"));
      for (const e of chain) rgb = over(rgba(getComputedStyle(e).backgroundColor), rgb);
      return rgb;
    };
    const lum = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const ratio = (color, background) => { const a = lum(over(rgba(color), background)), b = lum(background);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
    const probe = document.createElement("span"); probe.style.color = "var(--accent)"; dialog.append(probe);
    const accent = getComputedStyle(probe).color; probe.remove();
    const visibleText = [...dialog.querySelectorAll("h2, p, summary")].filter(n => n.checkVisibility());
    return { action: dialog.dataset.taskCleanupAction, dialog: rect(dialog), cancel: rect(cancel), confirm: rect(confirm),
      section: rect(dialog.querySelector("section")), footer: rect(dialog.querySelector("footer")),
      bodyScrollTop: dialog.querySelector("section").scrollTop,
      bodyScrollHeight: dialog.querySelector("section").scrollHeight,
      bodyClientHeight: dialog.querySelector("section").clientHeight,
      color: getComputedStyle(confirm).color, background: getComputedStyle(confirm).backgroundColor,
      border: getComputedStyle(confirm).borderTopColor, accent,
      contrast: ratio(getComputedStyle(confirm).color, bg(confirm)),
      cancelContrast: ratio(getComputedStyle(cancel).color, bg(cancel)),
      textContrast: visibleText.map(n => ratio(getComputedStyle(n).color, bg(n))),
      boundaryContrast: ratio(getComputedStyle(confirm).borderTopColor, bg(dialog)),
      focusContrast: ratio(accent, bg(dialog)),
      staticDeleteCount: document.querySelectorAll("[data-task-delete-modal]").length,
      dangerAlias: getComputedStyle(confirm).getPropertyValue("--task-lifecycle-danger"),
      confirmClasses: confirm.className, viewport: { width: innerWidth, height: innerHeight },
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      dialogOverflow: Math.max(0, dialog.scrollWidth - dialog.clientWidth),
      busy: dialog.getAttribute("aria-busy"), disabled: confirm.disabled,
    };
  });
}

function check(m) {
  assert.equal(m.staticDeleteCount, 1);
  assert.equal(m.overflow, 0); assert.equal(m.dialogOverflow, 0);
  assert.ok(m.dialog.x >= 11 && m.dialog.right <= m.viewport.width - 11);
  assert.ok(m.dialog.y >= 0 && m.dialog.bottom <= m.viewport.height);
  assert.ok(m.cancel.width >= 44 && m.cancel.height >= 44);
  assert.ok(m.confirm.width >= 44 && m.confirm.height >= 44);
  assert.ok(m.section.bottom <= m.footer.y + 1);
  assert.ok(m.confirm.y >= m.cancel.bottom + 8 || m.confirm.x >= m.cancel.right + 8);
  if (!m.disabled) assert.ok(m.contrast >= 4.5, JSON.stringify(m));
  if (m.busy !== "true") assert.ok(m.cancelContrast >= 4.5);
  assert.ok(m.textContrast.every(n => n >= 4.5), JSON.stringify(m.textContrast));
  assert.ok(m.boundaryContrast >= 3);
  assert.ok(m.focusContrast >= 3);
  if (m.action === "complete") {
    assert.ok(m.confirmClasses.includes("board-task-primary"));
    assert.equal(m.confirmClasses.includes("task-delete-confirm"), false);
    assert.equal(m.dangerAlias, "");
  } else {
    assert.ok(m.confirmClasses.includes("task-delete-confirm"));
    assert.ok(m.dangerAlias.length > 0);
  }
}

const capture = (page, name) => page.screenshot({ path: path.join(output, name + ".png"),
  animations: "disabled", caret: "hide" });

for (const surface of surfaces) test("canonical cleanup confirmation: " + surface.name, { timeout: 90000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: surface.width, height: 900 },
      isMobile: !!surface.touch, hasTouch: !!surface.touch });
    page.setDefaultTimeout(6000);
    const diagnostics = await setup(page, surface);
    const metrics = {};
    for (const theme of ["nebula", "orange"]) for (const action of ["complete", "remove"]) {
      await page.locator("[data-theme-select]").evaluate((n, value) => {
        n.value = value; n.dispatchEvent(new Event("change", { bubbles: true }));
      }, theme);
      const prefix = surface.name + "-" + theme + "-" + action;
      const initialCalls = await page.evaluate(() => window.__cleanupCalls.length);
      await page.mouse.move(0, 0);
      await page.evaluate(value => window.__beginCleanup("board-task-" + value), action);
      const dialog = page.locator("[data-task-cleanup-modal]");
      const cancel = dialog.locator("[data-task-cleanup-cancel]");
      const confirm = dialog.locator("[data-task-cleanup-confirm]");
      const details = dialog.locator("details");
      assert.equal(await cancel.evaluate(n => n === document.activeElement), true);
      assert.equal(await dialog.locator("h2").count(), 1);
      assert.equal(await details.getAttribute("open"), null);
      assert.ok((await dialog.innerText()).includes(action === "complete"
        ? "Задача будет закрыта и останется доступной в архиве."
        : "Задача и её карточка будут удалены без возможности восстановления."));
      assert.ok((await dialog.innerText()).includes("Будут удалены только Git-артефакты, перечисленные в предпросмотре."));
      assert.equal((await dialog.innerText()).includes("Complete closes"), false);
      assert.equal((await dialog.textContent()).includes("EXACT-private-token"), false);
      metrics[prefix + "-normal"] = await measure(page); check(metrics[prefix + "-normal"]);
      await capture(page, prefix + "-normal");
      await cancel.press("Enter");
      assert.equal(await dialog.count(), 0);
      assert.equal(await page.locator("[data-cleanup-fixture-opener]").evaluate(n => n === document.activeElement), true);
      assert.equal(await page.evaluate(() => window.__cleanupCalls.length), initialCalls);
      await page.evaluate(value => window.__beginCleanup("board-task-" + value, false), action);
      assert.equal(await dialog.locator("#task-cleanup-helper").innerText(), "Git-артефакты не будут удалены.");
      await cancel.press("Escape");
      assert.equal(await page.locator("[data-cleanup-fixture-opener]").evaluate(n => n === document.activeElement), true);
      await page.evaluate(value => window.__beginCleanup("board-task-" + value), action);
      await page.mouse.click(1, 1);
      assert.equal(await dialog.count(), 0);
      assert.equal(await page.evaluate(() => window.__cleanupCalls.length), initialCalls);
      assert.equal(await page.locator("[data-cleanup-fixture-opener]").evaluate(n => n === document.activeElement), true);
      await page.evaluate(value => window.__beginCleanup("board-task-" + value), action);
      await confirm.focus();
      metrics[prefix + "-focus"] = await measure(page); check(metrics[prefix + "-focus"]);
      await capture(page, prefix + "-focus");
      await confirm.press("Tab");
      assert.equal(await details.locator("summary").evaluate(n => n === document.activeElement), true);
      await details.locator("summary").press("Enter");
      assert.equal(await details.getAttribute("open"), "");
      const raw = await details.innerText();
      for (const value of ["fixture/удаляемый-путь", "QA-122/ветка", "a".repeat(40), "b".repeat(40),
        "Тип: future_kind", "WIP/сохранить.txt", "Сообщение сервера:", "<literal server warning>"]) assert.ok(raw.includes(value));
      metrics[prefix + "-expanded"] = await measure(page); check(metrics[prefix + "-expanded"]);
      await capture(page, prefix + "-expanded");
      await dialog.locator("section").evaluate(n => { n.scrollTop = n.scrollHeight; });
      metrics[prefix + "-scrolled"] = await measure(page); check(metrics[prefix + "-scrolled"]);
      assert.ok(metrics[prefix + "-scrolled"].bodyScrollTop > 0);
      assert.deepEqual(metrics[prefix + "-scrolled"].footer, metrics[prefix + "-expanded"].footer);
      assert.deepEqual(metrics[prefix + "-scrolled"].confirm, metrics[prefix + "-expanded"].confirm);
      await capture(page, prefix + "-scrolled");
      await dialog.locator("section").evaluate(n => { n.scrollTop = 0; });
      await details.locator("summary").press("Enter");
      await confirm.hover();
      metrics[prefix + "-hover"] = await measure(page); check(metrics[prefix + "-hover"]);
      await capture(page, prefix + "-hover");
      await confirm.click();
      await page.waitForFunction(() => document.querySelector("[data-task-cleanup-modal]")?.getAttribute("aria-busy") === "true");
      assert.equal(await confirm.isDisabled(), true); assert.equal(await cancel.isDisabled(), true);
      assert.equal(await details.evaluate(n => n.inert), true);
      const count = await page.evaluate(() => window.__cleanupCalls.length);
      await confirm.evaluate(n => { n.click(); n.click(); });
      await page.keyboard.press("Escape");
      await page.mouse.click(1, 1);
      assert.equal(await dialog.count(), 1);
      assert.equal(await page.evaluate(() => window.__cleanupCalls.length), count);
      metrics[prefix + "-pending"] = await measure(page); check(metrics[prefix + "-pending"]);
      await capture(page, prefix + "-pending");
      await page.evaluate(() => window.__cleanupResolve());
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await page.locator("[data-cleanup-fixture-opener]").evaluate(n => n === document.activeElement), true);
      const request = await page.evaluate(() => window.__cleanupCalls.at(-1));
      assert.deepEqual(request, { action: "board-task-" + action,
        params: { id: "exact-task", operationId: "exact-operation", confirmCleanup: true, expectedCleanupToken: "EXACT-private-token" } });
    }
    await page.evaluate(() => window.__beginCleanup("board-task-complete"));
    await page.locator("[data-task-cleanup-confirm]").click();
    await page.evaluate(() => window.__cleanupReject());
    await page.locator("[data-task-cleanup-modal] [role=alert]").waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-task-cleanup-modal] [role=alert]").innerText(),
      "Не удалось выполнить действие. Отмените подтверждение и откройте его заново.");
    assert.ok((await page.locator(".task-cleanup-preview").textContent()).includes("Предпросмотр устарел."));
    assert.equal(await page.locator("[data-task-cleanup-cancel]").evaluate(n => n === document.activeElement), true);
    assert.equal(await page.locator("[data-task-cleanup-confirm]").isDisabled(), true);
    await page.locator("[data-task-cleanup-cancel]").press("Escape");
    assert.equal(await page.locator("[data-cleanup-fixture-opener]").evaluate(n => n === document.activeElement), true);
    assert.deepEqual(diagnostics, []);
    await writeFile(path.join(output, surface.name + "-metrics.json"), JSON.stringify(metrics, null, 2));
  } finally { await browser.close(); }
});

test("cleanup dialog contains long preview at short height and 200 percent text", { timeout: 30000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 420 }, isMobile: true, hasTouch: true });
    const diagnostics = await setup(page, { surface: "web" });
    const metrics = {};
    for (const theme of ["nebula", "orange"]) for (const action of ["complete", "remove"]) {
      await page.locator("[data-theme-select]").evaluate((n, value) => {
        n.value = value; n.dispatchEvent(new Event("change", { bubbles: true }));
      }, theme);
      await page.evaluate(value => window.__beginCleanup("board-task-" + value), action);
      await page.locator(".task-cleanup-technical > summary").press("Enter");
      metrics[theme + "-" + action + "-short"] = await measure(page);
      check(metrics[theme + "-" + action + "-short"]);
      await capture(page, "short-" + theme + "-" + action);
      await page.addStyleTag({ content: "html { font-size:200% !important; }" });
      metrics[theme + "-" + action + "-zoom"] = await measure(page);
      check(metrics[theme + "-" + action + "-zoom"]);
      await capture(page, "zoom-" + theme + "-" + action);
      await page.locator("[data-task-cleanup-cancel]").press("Escape");
      await page.addStyleTag({ content: "html { font-size:100% !important; }" });
    }
    assert.deepEqual(diagnostics, []);
    await writeFile(path.join(output, "short-zoom-metrics.json"), JSON.stringify(metrics, null, 2));
  } finally { await browser.close(); }
});
