import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const TEST_THEME_CATALOG = JSON.stringify([{
  id: "orbit",
  name: "Orbit",
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);

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
  for (const role of ["[data-dialog-stream-architect]", "[data-dialog-stream-team-lead]"]) {
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

test("переключатель роли остаётся кликабельным, а знак вопроса его не трогает", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchEdge(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await openFixture(page);
    await page.evaluate(openStreamCard);
    const architect = page.locator("[data-dialog-stream-architect]");
    assert.equal(await architect.isChecked(), false);

    await page.locator(".stream-architect-setting .switch-track").click();
    assert.equal(await architect.isChecked(), true, "клик по тумблеру не переключил роль");

    await page.locator(".stream-architect-setting .switch-text").click();
    assert.equal(await architect.isChecked(), false, "клик по подписи не переключил роль");

    await page.locator(".stream-architect-setting .stream-role-help").click();
    assert.equal(await architect.isChecked(), false, "знак вопроса переключил роль");
    assert.equal(await page.locator("#stream-architect-note").isVisible(), true,
      "знак вопроса не открыл пояснение роли");
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

test("быстрые ответы показывают значение в одной строке с подписью", async () => {
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
      const add = editor.querySelector("[data-quick-message-add]").getBoundingClientRect();
      return {
        sameRow: Math.abs(Math.round(name.top - value.top)) <= 2,
        valueRight: Math.round(value.right),
        nameRight: Math.round(name.right),
        addWidth: Math.round(add.width),
        editorWidth: Math.round(editor.getBoundingClientRect().width),
      };
    });
    assert.equal(rows.sameRow, true, "подпись и значение быстрых ответов оказались в разных строках");
    assert.ok(rows.valueRight > rows.nameRight, "значение не прижато к правому краю строки");
    assert.ok(rows.addWidth < rows.editorWidth * 0.6,
      `кнопка добавления растянулась на ${rows.addWidth} из ${rows.editorWidth}`);
  } finally {
    await browser.close();
  }
});
