import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cosmeticMatrix } from "../helpers/test-profile.mjs";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
// Классика адаптирует типографику заголовков, поэтому она нужна в фикстуре
// наравне с темой по умолчанию.
const TEST_THEMES = [
  { id: "orbit", name: "Orbit", color: "#080b11" },
  { id: "classic", name: "Классика", color: "#191a1b" },
];
const TEST_THEME_CATALOG = JSON.stringify(TEST_THEMES.map((theme) => ({
  ...theme,
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
})));
// Сервер подставляет ссылки на темы в этот маркер, до листов оболочки. Порядок
// важен: правило, объявленное позже темы, обходит её адаптацию.
const TEST_THEME_STYLES = TEST_THEMES
  .map((theme) => `<link rel="stylesheet" href="/themes/${theme.id}/theme.css">`)
  .join("");

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

async function launchEdge(chromium) {
  if (process.platform === "win32") return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true });
}

async function openFixture(page) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "agent-hub.test") return route.abort();
    if (requestUrl.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("<!-- agent-hub-theme-styles -->", TEST_THEME_STYLES)
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    if (requestUrl.pathname === "/work-log.css") {
      return route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
    }
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      return route.fulfill({ status: 404, body: "Not found" });
    }
    try {
      return route.fulfill({
        status: 200,
        contentType: contentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => window.AgentHub);
}

// Карточка Stream живёт внутри скрытой панели чата: без выбранного Stream её
// предки скрыты, поэтому фикстура раскрывает их так же, как это делает выбор.
function openStreamCard() {
  // На узком экране раскладка показывает панель задач, а секция чата скрыта.
  document.documentElement.dataset.pane = "chat";
  for (const host of [".chat-pane", ".stream-chat-columns"]) {
    document.querySelector(host)?.removeAttribute("hidden");
  }
  const dialog = document.querySelector("[data-dialog-settings]");
  dialog.removeAttribute("hidden");
  dialog.showModal();
  const agent = dialog.querySelector("[data-dialog-agent]");
  agent.innerHTML = '<button type="button" class="option-chip" aria-pressed="true">Codex</button>';
  for (const [key, values] of Object.entries({
    model: ["GPT-5.6-Terra"], reasoning: ["Medium"], mode: ["Work"],
  })) {
    const select = dialog.querySelector(`select[data-dialog-options="${key}"]`);
    select.innerHTML = values.map((value) => `<option>${value}</option>`).join("");
  }
  // Роли выключены, пока карточка не привязана к Stream (app.js: disabled = !task?.streamId).
  // Проверяется раскладка и работа включённого переключателя, поэтому фикстура его включает.
  for (const role of ["[data-dialog-stream-release-manager]", "[data-dialog-stream-team-lead]"]) {
    dialog.querySelector(role).disabled = false;
  }
}

const right = (element) => Math.round(element.getBoundingClientRect().right);
const left = (element) => Math.round(element.getBoundingClientRect().left);

test("переключатели карточки Stream стоят на одной вертикали", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(openStreamCard);
    const edges = await page.evaluate(() => {
      const card = document.querySelector("[data-dialog-settings] .settings-card");
      return [...card.querySelectorAll(".switch-track")]
        .map((track) => Math.round(track.getBoundingClientRect().right));
    });
    assert.ok(edges.length >= 3, `ожидались все переключатели карточки, получено ${edges.length}`);
    assert.equal(new Set(edges).size, 1, `правые края переключателей разошлись: ${edges.join(", ")}`);
  } finally {
    await browser.close();
  }
});

test("чип агента занимает ту же колонку, что селекты соседних строк", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(openStreamCard);
    const geometry = await page.evaluate(() => {
      const card = document.querySelector("[data-dialog-settings] .settings-card");
      const box = (selector) => {
        const element = card.querySelector(selector);
        const rect = element.getBoundingClientRect();
        return { left: Math.round(rect.left), right: Math.round(rect.right) };
      };
      return {
        agent: box(".dialog-agent-options"),
        select: box('.setting-row[data-setting="model"] .themed-select, .setting-row[data-setting="model"] select'),
      };
    });
    assert.equal(geometry.agent.left, geometry.select.left,
      `левые края чипа агента и селекта разошлись: ${geometry.agent.left} и ${geometry.select.left}`);
    assert.equal(geometry.agent.right, geometry.select.right,
      `правые края чипа агента и селекта разошлись: ${geometry.agent.right} и ${geometry.select.right}`);
  } finally {
    await browser.close();
  }
});

for (const width of [1440, 390]) test(`переключатель роли остаётся кликабельным, а знак вопроса его не трогает ${width}px`, async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page);
    await page.evaluate(openStreamCard);
    const releaseManager = page.locator("[data-dialog-stream-release-manager]");
    assert.equal(await page.locator(".stream-release-manager-setting .switch-text").textContent(), "Релиз-менеджер");
    assert.equal(await releaseManager.isChecked(), false);

    await page.locator(".stream-release-manager-setting .switch-track").click();
    assert.equal(await releaseManager.isChecked(), true, "клик по тумблеру не переключил роль");

    await page.locator(".stream-release-manager-setting .switch-text").click();
    assert.equal(await releaseManager.isChecked(), false, "клик по подписи не переключил роль");

    await page.locator(".stream-release-manager-setting .stream-role-help").click();
    assert.equal(await releaseManager.isChecked(), false, "знак вопроса переключил роль");
    assert.equal(await page.locator("#stream-release-manager-note").isVisible(), true,
      "знак вопроса не открыл пояснение роли");
    const instructions = await page.locator("#stream-release-manager-note").textContent();
    assert.match(instructions, /связанный чек-лист/u);
    assert.match(instructions, /сохранив карточки и историю/u);
    assert.doesNotMatch(instructions, /архитектор|Architect/iu);
    assert.deepEqual(errors, []);
    if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) {
      await mkdir(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, `release-manager-${width}.png`) });
    }
  } finally {
    await browser.close();
  }
});

test("переключатель релизного процесса Workspace кликается и выровнен по правому краю", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(() => document.querySelector("[data-workspace-card-modal]").showModal());
    const release = page.locator("[data-workspace-release-workflow]");
    assert.equal(await release.isChecked(), false);

    await page.locator(".workspace-release-workflow-switch .switch-track").click();
    assert.equal(await release.isChecked(), true, "клик по тумблеру не включил релизный процесс");

    await page.locator(".workspace-release-workflow-switch .switch-text").click();
    assert.equal(await release.isChecked(), false, "клик по подписи не выключил релизный процесс");

    const aligned = await page.evaluate(() => {
      const fields = document.querySelector(".workspace-card-fields");
      const track = fields.querySelector(".workspace-release-workflow-switch .switch-track");
      const reference = fields.querySelector("[data-workspace-card-name]");
      return Math.round(track.getBoundingClientRect().right) === Math.round(reference.getBoundingClientRect().right);
    });
    assert.equal(aligned, true, "тумблер релизного процесса не дошёл до правого края карточки");
  } finally {
    await browser.close();
  }
});

for (const width of [1440, 390]) {
  test(`Workspace auto-review can be saved, reopened and disabled independently at ${width}px`, async () => {
    const { chromium } = await import("playwright");
    const browser = await launchEdge(chromium);
    try {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openFixture(page);
      await page.evaluate(() => {
        window.__reviewWorkspace = { id: "review-workspace", name: "Review Workspace",
          settings: { releaseWorkflowEnabled: false, autoReviewEnabled: false } };
        const render = () => window.AgentHub.setWorkspaces([window.__reviewWorkspace], ["workspace:review-workspace", "notes"]);
        window.__reviewIntents = [];
        window.AgentHub.on("workspace:update", (value) => {
          window.__reviewIntents.push(value);
          window.__reviewWorkspace.settings = { ...window.__reviewWorkspace.settings,
            releaseWorkflowEnabled: value.releaseWorkflowEnabled, autoReviewEnabled: value.autoReviewEnabled };
          render();
        });
        render();
        window.AgentHub.setTasks([{
          id: "review-task", workspaceId: "review-workspace", workspaceName: "Review Workspace",
          streamId: "review-stream", streamName: "Executor", streamOrdinal: 1,
          provider: "codex", agentLabel: "Codex", selected: true,
          status: "ready", statusLabel: "Готов", running: false, unread: false,
          streamSettings: {}, messages: [],
        }]);
      });
      const workspace = page.locator('[data-workspace-select="review-workspace"]');
      await workspace.dblclick();
      const review = page.locator("[data-workspace-auto-review]");
      const release = page.locator("[data-workspace-release-workflow]");
      assert.equal(await review.isChecked(), false);
      assert.equal(await page.locator("[data-workspace-card-modal]").isVisible(), true);
      assert.equal(await page.locator(".workspace-auto-review-setting").evaluate((node) =>
        Boolean(node.previousElementSibling?.querySelector("[data-workspace-release-workflow]"))), true);
      await page.locator(".workspace-auto-review-switch .switch-track").click();
      assert.equal(await review.isChecked(), true);
      assert.equal(await release.isChecked(), false);
      await page.locator(".workspace-auto-review-setting summary").click();
      assert.equal(await page.locator("#workspace-auto-review-tooltip").isVisible(), true);
      assert.equal(await review.isChecked(), true);
      assert.ok((await page.locator("#workspace-auto-review-tooltip").innerText()).includes("напрямую"));
      await page.locator(".workspace-auto-review-setting summary").click();
      if (process.env.AGENT_HUB_QA_SCREENSHOT_DIR) {
        await mkdir(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_QA_SCREENSHOT_DIR, `auto-review-${width}.png`) });
      }
      await page.locator("[data-workspace-card-submit]").click();
      assert.equal(await page.evaluate(() => window.__reviewIntents[0].autoReviewEnabled), true);
      await workspace.dblclick();
      assert.equal(await review.isChecked(), true);
      await page.locator(".workspace-auto-review-switch .switch-text").click();
      await page.locator("[data-workspace-card-submit]").click();
      await workspace.dblclick();
      assert.equal(await review.isChecked(), false);
      assert.equal(await release.isChecked(), false);
      assert.deepEqual(errors, []);
      assert.equal(new URL(page.url()).hostname, "agent-hub.test");
      assert.ok(await page.title());
    } finally {
      await browser.close();
    }
  });
}

test("действия карточки задачи одного размера, а удаление отделено справа", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(() => {
      const dialog = document.querySelector("[data-task-card-modal]");
      dialog.showModal();
      dialog.querySelector("[data-task-card-actions]").innerHTML = `
        <button type="button" class="board-task-primary">Переназначить…</button>
        <select class="board-task-destination"><option>Agent HUB</option></select>
        <button type="button" class="board-task-quiet">Закрыть задачу</button>
        <button type="button" class="board-task-remove">Удалить</button>`;
    });
    const layout = await page.evaluate(() => {
      const footer = document.querySelector("[data-task-card-actions]");
      const heights = [...footer.children].map((child) => Math.round(child.getBoundingClientRect().height));
      const remove = footer.querySelector(".board-task-remove").getBoundingClientRect();
      const quiet = footer.querySelector(".board-task-quiet").getBoundingClientRect();
      const style = getComputedStyle(footer);
      return {
        heights,
        removeRight: Math.round(remove.right),
        quietRight: Math.round(quiet.right),
        footerInner: Math.round(footer.getBoundingClientRect().right - Number.parseFloat(style.paddingRight)),
      };
    });
    assert.ok(Math.max(...layout.heights) - Math.min(...layout.heights) <= 1,
      `высоты действий футера разошлись: ${layout.heights.join(", ")}`);
    assert.equal(layout.removeRight, layout.footerInner,
      "удаление не прижато к правому краю футера");
    assert.ok(layout.removeRight > layout.quietRight + 24,
      "удаление не отделено от обычных действий");
  } finally {
    await browser.close();
  }
});

test("подписи полей во всех трёх карточках одного размера", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(openStreamCard);
    const sizes = await page.evaluate(() => {
      const size = (element) => getComputedStyle(element).fontSize;
      const stream = document.querySelector("[data-dialog-settings] .setting-name");
      const streamSwitch = document.querySelector("[data-dialog-settings] .switch-text");
      const workspace = document.querySelector(".workspace-card-fields label > span");
      const taskEditor = document.querySelector(".task-card-editor label > span");
      const taskDetail = document.querySelector(".task-card-detail-row > span");
      const taskStatus = document.querySelector(".task-card-status-field > span");
      return {
        stream: size(stream),
        streamSwitch: size(streamSwitch),
        workspace: size(workspace),
        taskEditor: size(taskEditor),
        taskDetail: size(taskDetail),
        taskStatus: size(taskStatus),
      };
    });
    const distinct = new Set(Object.values(sizes));
    assert.equal(distinct.size, 1,
      `подписи карточек набраны разными размерами: ${JSON.stringify(sizes)}`);
  } finally {
    await browser.close();
  }
});

// Считает то же, что видит глаз: типографику заголовка чек-листа, заголовка
// секции рядом с ним и контраст к реально закрашенному фону под элементом.
function readHeadingTypography(theme) {
  document.documentElement.dataset.theme = theme;
  const dialog = document.querySelector("[data-task-card-modal]");
  if (!dialog.open) dialog.showModal();
  const channels = (color) => {
    const match = /rgba?\(([^)]+)\)/u.exec(color);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number.parseFloat(part));
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = (rgb) => {
    const linear = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const painted = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const parsed = channels(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.alpha > 0.4) return parsed.rgb;
    }
    return [0, 0, 0];
  };
  const contrast = (element) => {
    const text = luminance(channels(getComputedStyle(element).color).rgb);
    const background = luminance(painted(element));
    const [brighter, darker] = text > background ? [text, background] : [background, text];
    return Math.round(((brighter + 0.05) / (darker + 0.05)) * 100) / 100;
  };
  const read = (element) => {
    const style = getComputedStyle(element);
    return {
      size: Number.parseFloat(style.fontSize),
      weight: style.fontWeight,
      transform: style.textTransform,
      spacing: style.letterSpacing,
      family: style.fontFamily,
      color: style.color,
      contrast: contrast(element),
    };
  };
  return {
    heading: read(dialog.querySelector(".task-card-checklist > header strong")),
    progress: read(dialog.querySelector(".task-card-checklist output")),
    sectionTitle: read(document.querySelector(".settings-section-title")),
  };
}

// Репрезентативный viewport проверяется всегда: контраст заголовка и его
// согласованность с заголовком секции — это доступность, а не оформление.
// Полная матрица остальных viewport живёт в профиле cosmetic.
const HEADING_TYPOGRAPHY_VIEWPORTS = [
  { name: "desktop", width: 1600, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
  { name: "short", width: 1280, height: 600 },
];

async function assertHeadingTypography(browser, viewport) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  try {
    await openFixture(page);

    for (const theme of ["orbit", "classic"]) {
      const seen = await page.evaluate(readHeadingTypography, theme);
      const where = `${viewport.name}/${theme}`;
      for (const property of ["size", "weight", "transform", "spacing", "family", "color"]) {
        assert.deepEqual(seen.heading[property], seen.sectionTitle[property],
          `${where}: заголовок чек-листа разошёлся с заголовком секции по ${property}: `
          + `${seen.heading[property]} против ${seen.sectionTitle[property]}`);
      }
    }

    const orbit = await page.evaluate(readHeadingTypography, "orbit");
    assert.equal(orbit.heading.transform, "uppercase",
      `${viewport.name}: Orbit потеряла капитель заголовка секции`);
    assert.ok(Number.parseFloat(orbit.heading.spacing) > 0,
      `${viewport.name}: Orbit потеряла разрядку заголовка секции`);
    assert.ok(orbit.heading.size < orbit.progress.size,
      `${viewport.name}: Orbit потеряла разницу масштабов заголовка и счётчика`);

    const classic = await page.evaluate(readHeadingTypography, "classic");
    assert.equal(classic.heading.transform, "none",
      `${viewport.name}: Классика получила капитель, которой у неё нет`);
    assert.equal(classic.heading.spacing, "normal",
      `${viewport.name}: Классика получила разрядку, которой у неё нет`);
    assert.ok(classic.heading.size >= 14,
      `${viewport.name}: заголовок Классики набран ${classic.heading.size}px вместо секционных 14px`);
    // Без капители мелкий заголовок читается как ошибка, а не как эйбрау.
    assert.ok(classic.heading.size >= classic.progress.size,
      `${viewport.name}: заголовок Классики мельче собственного счётчика — `
      + `${classic.heading.size}px против ${classic.progress.size}px`);
    // Абсолютный потолок задаёт палитра темы: --text-muted Классики даёт
    // 4.47:1 на фоне вложенного блока, столько же у соседнего счётчика и у
    // секционных заголовков. Проверяется, что заголовок не хуже этого уровня
    // и далеко ушёл от прежних 2.1:1, которые давал мелкий text-faint.
    assert.ok(classic.heading.contrast >= classic.progress.contrast,
      `${viewport.name}: заголовок Классики контрастнее не стал — `
      + `${classic.heading.contrast}:1 против ${classic.progress.contrast}:1 у счётчика`);
    assert.ok(classic.heading.contrast >= 4,
      `${viewport.name}: контраст заголовка Классики ${classic.heading.contrast}:1 ниже 4:1`);
  } finally {
    await page.close();
  }
}

test("заголовок чек-листа держит контраст и типографику секции на репрезентативном viewport", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    await assertHeadingTypography(browser, HEADING_TYPOGRAPHY_VIEWPORTS[0]);
  } finally {
    await browser.close();
  }
});

test("заголовок чек-листа следует типографике секций текущей темы в остальных viewport", cosmeticMatrix(), async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    for (const viewport of HEADING_TYPOGRAPHY_VIEWPORTS.slice(1)) {
      await assertHeadingTypography(browser, viewport);
    }
  } finally {
    await browser.close();
  }
});

test("записи лога работы не рисуют вторую рамку внутри блока исполнения", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(() => {
      const dialog = document.querySelector("[data-task-card-modal]");
      dialog.showModal();
      dialog.querySelector("[data-task-card-work-log-entries]").innerHTML = `
        <article class="task-card-work-log-entry">
          <div class="task-card-work-log-meta"><strong>claude</strong><span>Завершён</span></div>
          <p>Итог хода.</p></article>`;
    });
    const borders = await page.evaluate(() => {
      const outer = document.querySelector(".task-card-release-details");
      const entry = outer.querySelector(".task-card-work-log-entry");
      const alpha = (color) => {
        const match = /rgba?\(([^)]+)\)/u.exec(color);
        if (!match) return 1;
        const parts = match[1].split(",").map((part) => Number.parseFloat(part));
        return parts.length > 3 ? parts[3] : 1;
      };
      return {
        outer: alpha(getComputedStyle(outer).borderTopColor),
        entry: alpha(getComputedStyle(entry).borderTopColor),
      };
    });
    assert.ok(borders.outer > 0, "блок исполнения потерял собственную рамку");
    assert.equal(borders.entry, 0, "запись лога всё ещё рисует рамку внутри рамки");
  } finally {
    await browser.close();
  }
});

test("карточка Workspace не даёт вторую полосу прокрутки поверх полей", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(() => {
      const dialog = document.querySelector("[data-workspace-card-modal]");
      dialog.showModal();
      dialog.querySelector("[data-workspace-card-rules]").value =
        Array.from({ length: 40 }, (_, index) => `Правило ${index + 1}`).join("\n");
    });
    const scrollers = await page.evaluate(() => {
      const dialog = document.querySelector("[data-workspace-card-modal]");
      return [dialog, ...dialog.querySelectorAll("*")]
        .filter((element) => element.scrollHeight > element.clientHeight + 1)
        .filter((element) => /auto|scroll/u.test(getComputedStyle(element).overflowY))
        .map((element) => element.tagName.toLowerCase() + (element.className ? `.${element.className}` : ""));
    });
    assert.ok(!scrollers.some((name) => name.startsWith("dialog")),
      `сам диалог остался прокручиваемым: ${scrollers.join(", ")}`);
  } finally {
    await browser.close();
  }
});

test("на телефоне карточки остаются подписанными", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await openFixture(page);
    await page.evaluate(openStreamCard);
    const surface = await page.evaluate(() => document.documentElement.dataset.surface);
    assert.equal(surface, "mobile", "фикстура не перешла в мобильную оболочку");

    const titled = async (selector) => page.evaluate((eyebrow) => {
      const element = document.querySelector(eyebrow);
      const rect = element.getBoundingClientRect();
      return getComputedStyle(element).display !== "none" && rect.width > 0 && rect.height > 0;
    }, selector);

    assert.equal(await titled(".dialog-settings-head .eyebrow"), true,
      "карточка Stream осталась без названия на телефоне");
    await page.evaluate(() => {
      document.querySelector("[data-dialog-settings]").close();
      document.querySelector("[data-workspace-card-modal]").showModal();
    });
    assert.equal(await titled(".workspace-card-modal .eyebrow"), true,
      "карточка Workspace осталась без названия на телефоне");
    await page.evaluate(() => {
      document.querySelector("[data-workspace-card-modal]").close();
      document.querySelector("[data-task-card-modal]").showModal();
    });
    assert.equal(await titled(".task-card-modal .eyebrow"), true,
      "карточка задачи осталась без названия на телефоне");
  } finally {
    await browser.close();
  }
});

test("Prompt-шаблоны показывают значение в одной строке с подписью", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(openStreamCard);
    const rows = await page.evaluate(() => {
      const editor = document.querySelector("[data-dialog-settings] .quick-messages-editor");
      const name = editor.querySelector(".setting-name").getBoundingClientRect();
      const value = editor.querySelector(".setting-value").getBoundingClientRect();
      const add = editor.querySelector("[data-prompt-templates-open]").getBoundingClientRect();
      return {
        sameRow: Math.abs(Math.round(name.top - value.top)) <= 2,
        valueRight: Math.round(value.right),
        nameRight: Math.round(name.right),
        addWidth: Math.round(add.width),
        editorWidth: Math.round(editor.getBoundingClientRect().width),
      };
    });
    assert.equal(rows.sameRow, true, "подпись и значение Prompt-шаблонов оказались в разных строках");
    assert.ok(rows.valueRight > rows.nameRight, "значение не прижато к правому краю строки");
    assert.ok(rows.addWidth < rows.editorWidth * 0.6,
      `кнопка входа в форму шаблонов растянулась на ${rows.addWidth} из ${rows.editorWidth}`);
  } finally {
    await browser.close();
  }
});

test("Server account cards show live identity and preserve login controls at desktop and mobile widths", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openFixture(page);
      await page.locator(width < 600 ? '[data-mobile-button="server"]' : '[data-view-button="server"]').click();
      const email = "long.account.for.provider.login.check@example.test";
      await page.evaluate((email) => window.AgentHub.setServerStatus({
        process: { status: "running" }, accounts: [
          { provider: "codex", status: "idle", currentAccount: { state: "signed-in", email } },
          { provider: "claude", status: "pending", attemptId: "8", currentAccount: { state: "signed-out" } },
        ],
      }), email);
      const cards = page.locator("[data-server-accounts]");
      await cards.getByText(email, { exact: true }).waitFor({ state: "visible" });
      assert.equal(await cards.getByText("Вход не запускался", { exact: true }).count(), 0);
      await cards.getByText("Не выполнен вход", { exact: true }).waitFor({ state: "visible" });
      await cards.getByText("Ожидает входа в браузере", { exact: true }).waitFor({ state: "visible" });
      assert.equal(await cards.getByRole("button", { name: "Отменить", exact: true }).isVisible(), true);
      const fits = await cards.evaluate((host) => [...host.querySelectorAll(".server-account")].every((card) => card.scrollWidth <= card.clientWidth + 1));
      assert.equal(fits, true);
      const shotRoot = path.join(process.env.TEMP || process.env.TMP || process.cwd(), "agent-hub-account-ui-20260916");
      await mkdir(shotRoot, { recursive: true });
      await cards.screenshot({ path: path.join(shotRoot, "accounts-" + width + ".png") });
      await page.evaluate(() => window.AgentHub.setServerStatus({
        accounts: [
          { provider: "codex", status: "idle", currentAccount: { state: "signed-in", email: "new@example.test" } },
          { provider: "claude", status: "cancelled", attemptId: "8", currentAccount: { state: "unknown" } },
        ],
      }));
      await cards.getByText("new@example.test", { exact: true }).waitFor({ state: "visible" });
      assert.equal(await cards.getByText(email, { exact: true }).count(), 0);
      await cards.getByText("Не удалось определить аккаунт", { exact: true }).waitFor({ state: "visible" });
      await cards.getByText("Вход отменён", { exact: true }).waitFor({ state: "visible" });
      assert.equal(await cards.getByRole("button", { name: "Отменить", exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
