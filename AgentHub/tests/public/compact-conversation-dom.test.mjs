import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { launchBrowser, openFixture, snapshot, bridgeCalls } from "./composer-production.fixture.mjs";

const output = fileURLToPath(new URL("../../WIP/compact-header-captures/", import.meta.url));
const { loadThemeRegistry } = createRequire(import.meta.url)("../../theme-registry.cjs");
const themeRegistry = loadThemeRegistry(fileURLToPath(new URL("../../assets/web-app/", import.meta.url)));
const surfaces = [
  { name: "mobile-320", width: 320 }, { name: "mobile-390", width: 390 },
  { name: "mobile-430", width: 430 }, { name: "webview-390", width: 390, surface: "vscode" },
  { name: "webview-520", width: 520, surface: "vscode" },
];

async function measure(page) {
  return page.evaluate(() => {
    const $ = (s) => document.querySelector(s);
    const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const visible = (n) => n.checkVisibility() && !n.closest("[hidden]");
    const header = $("[data-stream-chat-header]"), meta = $(".stream-chat-meta"), scroller = $("[data-chat-scroll]");
    const opener = $("[data-mobile-stream-switch]"), name = $("[data-mobile-stream-name]"), caret = opener.querySelector("svg");
    const cluster = $(".composer-primary-actions"), meter = $("[data-context-usage]");
    const primaries = [...cluster.querySelectorAll("[data-composer-send], [data-chat-stop]")].filter(visible);
    const primary = primaries[0];
    const headerRect = rect(header), scrollerRect = rect(scroller);
    // Message rectangles are clipped to their owning scroll viewport before
    // testing painted intersections; off-screen rows may have negative rects.
    const intersections = [...scroller.querySelectorAll(".msg")].map(rect).filter((r) =>
      Math.min(r.bottom, scrollerRect.bottom, headerRect.bottom) > Math.max(r.y, scrollerRect.y, headerRect.y));
    const tokens = [...meta.children].filter(visible);
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
    const rgba = (color) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
    const background = luminance(rgba(getComputedStyle(header).backgroundColor));
    const ratio = (color) => { const foreground = luminance(rgba(color)); return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05); };
    const probe = document.createElement("span"); probe.style.color = "var(--accent)"; header.append(probe);
    const focusContrast = ratio(getComputedStyle(probe).color); probe.remove();
    const textContrast = [name, ...meta.querySelectorAll("[data-mobile-workspace-name], [data-stream-header-provider], [data-stream-header-model], [data-stream-header-branch], [data-stream-header-message-count], [data-provider-connection-label], [data-mobile-current-runtime], [data-mobile-current-status]")].filter(visible).map((n) => ({ text: n.textContent, ratio: ratio(getComputedStyle(n).color) }));
    const iconContrast = [...header.querySelectorAll("button svg")].filter((n) => visible(n) && !n.closest("button").disabled).map((n) => ({ label: n.closest("button").title, color: getComputedStyle(n).color, ratio: ratio(getComputedStyle(n).color) }));
    return {
      focusContrast, textContrast, iconContrast, header: headerRect, meta: rect(meta), scroller: scrollerRect, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, scrollClientHeight: scroller.clientHeight,
      metaPaintOwned: [...meta.querySelectorAll("[data-mobile-workspace-name], [data-stream-header-provider]")].filter(visible).every((n) => { const r = n.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + Math.min(2, r.width / 2), r.y + r.height / 2); return header.contains(hit); }),
      headerStyle: { background: getComputedStyle(header).backgroundColor, isolation: getComputedStyle(header).isolation,
        flexShrink: getComputedStyle(header).flexShrink, position: getComputedStyle(header).position,
        themeCanvas: getComputedStyle(document.documentElement).getPropertyValue("--mobile-navigation-bg").trim() },
      metaStyle: { background: getComputedStyle(meta).backgroundColor, isolation: getComputedStyle(meta).isolation },
      intersections: intersections.length, overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      metaLines: new Set(tokens.map((n) => Math.round(n.getBoundingClientRect().y + n.getBoundingClientRect().height / 2))).size,
      tokens: tokens.map((n) => ({ text: n.textContent.trim(), title: n.title, ...rect(n) })),
      name: rect(name), nameLineHeight: parseFloat(getComputedStyle(name).lineHeight), caret: rect(caret), opener: rect(opener),
      controls: [...header.querySelectorAll("button")].filter(visible).map((n) => ({ label: n.title, ...rect(n) })),
      workspaceInOpener: Boolean(opener.querySelector("[data-mobile-workspace-label]")),
      aria: opener.getAttribute("aria-label"),
      cluster: rect(cluster), composer: rect($(".composer-main")), primary: primary && rect(primary),
      primaryCount: primaries.length, primaryFocusable: primary && !primary.disabled && primary.tabIndex >= 0,
      meter: visible(meter) ? rect(meter) : null, meterAria: meter.getAttribute("aria-label"),
      sendVisible: visible($("[data-composer-send]")), stopVisible: visible($(".composer-primary-actions [data-chat-stop]")),
    };
  });
}

function assertLayout(m, { empty = false, running = false, enabled = false } = {}) {
  assert.equal(m.overflow, 0);
  assert.ok(m.focusContrast >= 3, JSON.stringify(m));
  for (const c of m.textContrast) assert.ok(c.ratio >= 4.5, JSON.stringify(c));
  for (const c of m.iconContrast) assert.ok(c.ratio >= 3, JSON.stringify(c));
  assert.ok(m.header.bottom <= m.scroller.y + 1 || empty, JSON.stringify(m));
  assert.equal(m.intersections, 0);
  assert.equal(m.metaPaintOwned, true);
  assert.equal(m.headerStyle.flexShrink, "0");
  assert.equal(m.headerStyle.isolation, "isolate");
  assert.equal(m.metaStyle.isolation, "isolate");
  assert.match(m.metaStyle.background, /^rgb\(/);
  assert.equal(m.metaStyle.background, m.headerStyle.background);
  assert.ok(m.headerStyle.themeCanvas);
  assert.equal(m.workspaceInOpener, false);
  assert.ok(m.name.height <= m.nameLineHeight + 1);
  assert.ok(m.caret.width > 0 && m.caret.right <= m.opener.right + 1);
  assert.ok(m.metaLines <= 2, JSON.stringify(m.tokens));
  assert.ok(m.meta.height >= 28);
  for (const r of m.controls) assert.ok(r.width >= 44 && r.height >= 44, JSON.stringify(r));
  for (let i = 1; i < m.controls.length; i++) assert.ok(m.controls[i - 1].right <= m.controls[i].x + 1, JSON.stringify(m.controls));
  assert.ok(m.tokens[0].text.startsWith("Workspace "));
  if (empty) { assert.equal(m.tokens.length, 1); return; }
  assert.equal(m.primaryCount, 1);
  assert.equal(m.sendVisible, !running); assert.equal(m.stopVisible, running);
  assert.equal(m.primaryFocusable, running || enabled);
  assert.ok(m.cluster.right <= m.composer.right + 1);
  assert.ok(m.cluster.bottom <= m.composer.bottom + 1);
  if (m.meter) {
    assert.ok(m.primary.x - m.meter.right >= 0 && m.primary.x - m.meter.right <= 4, JSON.stringify(m));
    assert.equal(m.primary.y, m.meter.y); assert.equal(m.primary.bottom, m.meter.bottom);
    assert.equal(m.meter.width, 44); assert.equal(m.meter.height, 44);
    assert.equal(m.meterAria, "Использование контекста: 86%");
  }
  assert.equal(m.primary.width, 44); assert.equal(m.primary.height, 44);
}

for (const surface of surfaces) test(`compact header, transcript and primary actions: ${surface.name}`, { timeout: 120_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: surface.width, height: surface.width === 320 ? 568 : 900 },
    ...(!surface.surface ? { isMobile: true, hasTouch: true } : {}) });
  page.setDefaultTimeout(5_000);
  await mkdir(output, { recursive: true });
  try {
    const data = snapshot();
    data.workspaces[0].name = "Other";
    data.tasks[0].workspaceName = "Other";
    data.tasks[0].streamName = data.tasks[0].streamDisplayName = "Поток 1";
    data.tasks[0].context = { percent: 86, usedTokens: 86000, modelContextWindow: 100000 };
    data.settings.modelOptionsByProvider.codex = [{ value: "gpt-test", label: "Sol" }];
    data.tasks[0].model = "gpt-test";
    data.workspaces.push({ id: "empty", name: "Пустой Workspace", streams: [] });
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, projectionState: "completed", role: i % 2 ? "assistant" : "user",
      text: `Сообщение ${i}. ${"Длинная переписка для проверки прокрутки. ".repeat(5)}` }));
    const diagnostics = await openFixture(page, { fixtureSnapshot: data, surface: surface.surface || "web", themeRegistry, followSelection: true,
      fixtureHistory: { provider: "codex", threadId: "thread-a", streamId: "stream-a", items: items.map((m, i) => ({ id: `turn-${i}`, completed: true, terminalRevision: 1, messages: [{ ...m, role: m.role === "assistant" ? "agent" : "user", itemId: m.id, phase: "final" }] })),
        start: 0, end: items.length, total: items.length, messageTotal: items.length, nextBefore: null, version: "long" } });
    await page.locator(".chat-log .msg").first().waitFor();
    const results = [];
    const record = async (state, options) => {
      const m = await measure(page); assertLayout(m, options); results.push({ state, ...m });
      await page.screenshot({ path: `${output}/${surface.name}-${state}.png` });
      return m;
    };
    for (const theme of ["nebula", "orange"]) {
      await page.locator("[data-theme-select]").evaluate((n, theme) => { n.value = theme; n.dispatchEvent(new Event("change", { bubbles: true })); }, theme);
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        await Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect.getComputedTiming().endTime)).map((a) => a.finished.catch(() => {})));
      });
      await page.locator("[data-composer-input]").fill("");
      for (const position of ["top", "mid"]) {
        await page.locator("[data-chat-scroll]").evaluate((n, p) => { n.scrollTop = p === "top" ? 0 : n.scrollHeight / 2; }, position);
        const m = await record(`${theme}-${position}`);
        if (surface.width >= 390) assert.equal(m.metaLines, 1, JSON.stringify(m.tokens));
        assert.ok(m.scrollHeight > m.scrollClientHeight);
        assert.ok(position === "top" ? m.scrollTop === 0 : m.scrollTop > 0);
      }
      await page.locator("[data-composer-input]").fill("Черновик");
      await record(`${theme}-enabled`, { enabled: true });
      await page.locator("[data-composer-input]").focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("[data-context-usage]").evaluate((n) => document.activeElement === n), true);
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("[data-composer-send]").evaluate((n) => document.activeElement === n), true);
      await page.evaluate(() => {
        const patch = { running: true, run: { turnId: "compact-turn", operationKind: "user-turn", projectionState: "active" } };
        Object.assign(window.__agentHubFixture.snapshot.tasks[0], patch); AgentHub.patchTask("stream-a", patch);
      });
      await page.evaluate(() => AgentHub.setLive("stream-a", { provider: "codex", threadId: "thread-a", turnId: "compact-turn", projectionState: "active", operationKind: "user-turn", text: "Ответ агента во время активного хода. ".repeat(8) }));
      await record(`${theme}-running`, { running: true });
      await page.locator("[data-composer-input]").focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
      assert.equal(await page.locator(".composer-primary-actions [data-chat-stop]").evaluate((n) => document.activeElement === n), true);
      await page.evaluate(() => {
        const workspaces = structuredClone(window.__agentHubFixture.snapshot.workspaces);
        workspaces[0].name = "Длинное имя Workspace 🛰".repeat(8);
        AgentHub.setWorkspaces(workspaces);
        AgentHub.patchTask("stream-a", { running: false, run: null, modelLabel: "Длинная модель без потери контекста", branch: "long-branch-with-unicode-🛰", runtimeLabel: "LOCAL", streamName: "Длинное имя потока 🛰".repeat(8), streamDisplayName: "Длинное имя потока 🛰".repeat(8), workspaceName: workspaces[0].name });
      });
      assert.equal(await page.locator("[data-stream-header-branch]").isVisible(), true);
      assert.equal(await page.locator("[data-stream-header-branch]").innerText(), "long-branch-with-unicode-🛰");
      await record(`${theme}-long`, { enabled: true });
      await page.locator("[data-mobile-workspaces-open]").click();
      await page.locator('[data-workspace-select="empty"] [data-mobile-workspace-select]').click();
      await page.waitForFunction(() => document.documentElement.hasAttribute("data-mobile-empty"));
      await record(`${theme}-empty`, { empty: true });
      assert.equal(await page.locator("[data-composer-input]").isVisible(), false);
      assert.equal(await page.locator("[data-mobile-stream-switch]").getAttribute("aria-label"), "Переключить поток: Нет потоков. Workspace Пустой Workspace");
      await page.locator("[data-mobile-workspaces-open]").click();
      await page.locator('[data-workspace-select="workspace-1"] [data-mobile-workspace-select]').click();
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-mobile-empty"));
      await page.evaluate(() => {
        const workspaces = structuredClone(window.__agentHubFixture.snapshot.workspaces);
        workspaces[0].name = "Other";
        AgentHub.setWorkspaces(workspaces);
        AgentHub.patchTask("stream-a", { running: false, run: null, streamName: "Поток 1", streamDisplayName: "Поток 1", workspaceName: "Other", modelLabel: "Sol", branch: "", runtimeLabel: "", runtimeTitle: "" });
      });
    }
    await page.evaluate(() => AgentHub.patchTask("stream-a", { context: null }));
    const hiddenMeter = await record("no-context", { enabled: true });
    assert.equal(hiddenMeter.meter, null);
    assert.ok(Math.abs(hiddenMeter.primary.right - hiddenMeter.composer.right) <= 1);
    await page.evaluate(() => AgentHub.patchTask("stream-a", { running: true }));
    await page.locator(".composer-primary-actions [data-chat-stop]").click();
    assert.equal((await bridgeCalls(page, "cancel-run")).length, 1);
    await writeFile(`${output}/${surface.name}-metrics.json`, JSON.stringify(results, null, 2));
    assert.deepEqual(diagnostics, []);
  } finally { await browser.close(); }
});

test("desktop header/composer geometry and control ownership survive compact round trip", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFixture(page);
    const geometry = () => page.evaluate(() => Object.fromEntries(
      [".stream-chat-header", ".stream-chat-meta", ".chat-overlay-actions", ".composer-main", "[data-composer-send]", "[data-chat-scroll]"].map((s) => {
        const r = document.querySelector(s).getBoundingClientRect(); return [s, { x: r.x, y: r.y, width: r.width, height: r.height }];
      })));
    const before = await geometry();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-mobile-dialogs-enabled"));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-mobile-dialogs-enabled"));
    assert.deepEqual(await geometry(), before);
    assert.equal(await page.locator(".composer-primary-actions").count(), 0);
    assert.equal(await page.locator(".stream-chat-header > .chat-overlay-actions").count(), 1);
    await mkdir(output, { recursive: true });
    await writeFile(`${output}/desktop-after.json`, JSON.stringify(before, null, 2));
    await page.screenshot({ path: `${output}/desktop-after.png` });
  } finally { await browser.close(); }
});
