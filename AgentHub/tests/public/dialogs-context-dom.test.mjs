import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchBrowser, openFixture, snapshot, bridgeCalls } from "./composer-production.fixture.mjs";

const captures = fileURLToPath(new URL("../../WIP/streams-context-captures/", import.meta.url));
const longName = "ДлинноеНазваниеДиалогаБезПробелов🛰".repeat(4);
const workspaceName = "Hysteria · Рабочее пространство 🛰";
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

async function geometry(page, mobile) {
  return page.evaluate((mobile) => {
    const visible = (node) => node.getClientRects().length && !node.closest("[hidden]");
    const targets = [...document.querySelectorAll(mobile
      ? ".mobile-dialogs:not([hidden]) button, [data-mobile-conversation-back], [data-mobile-stream-switch], [data-mobile-chat-stream-create]"
      : "[data-action=stream-create]")].filter(visible).map((node) => {
      const box = node.getBoundingClientRect();
      return { name: node.getAttribute("aria-label"), width: box.width, height: box.height };
    });
    const rows = [...document.querySelectorAll("[data-mobile-stream-list] .mobile-stream-row")].filter(visible);
    const heading = document.querySelector(".mobile-dialogs h1");
    const workspace = document.querySelector("[data-mobile-workspace-name]");
    const label = workspace.previousElementSibling;
    const caret = document.querySelector("[data-mobile-workspace-label] > svg");
    const font = (node) => {
      const style = getComputedStyle(node);
      return { size: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), weight: style.fontWeight };
    };
    return {
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      targets,
      typography: { heading: font(heading), workspace: font(workspace), label: font(label),
        oneLineWorkspace: workspace.getBoundingClientRect().height <= parseFloat(getComputedStyle(workspace).lineHeight) + 1,
        clearCaret: workspace.getBoundingClientRect().right <= caret.getBoundingClientRect().left },
      collisions: rows.filter((row) => {
        const title = row.querySelector("strong").getBoundingClientRect();
        const provider = row.querySelector(".mobile-stream-line > span").getBoundingClientRect();
        const tail = row.querySelector(".mobile-stream-tail").getBoundingClientRect();
        return title.right > provider.left + 1 || provider.right > tail.left + 1;
      }).length,
      multiline: rows.flatMap((row) => [...row.querySelectorAll("strong, .mobile-stream-preview")])
        .filter((node) => node.getBoundingClientRect().height > parseFloat(getComputedStyle(node).lineHeight) * 1.5).length,
    };
  }, mobile);
}

for (const surface of surfaces) {
  test(`dialogs terminology, Workspace context and truthful previews: ${surface.name}`, { timeout: 60_000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: surface.width, height: 900 },
      ...(surface.mobile ? { isMobile: true, hasTouch: true } : {}) });
    page.setDefaultTimeout(5_000);
    await mkdir(captures, { recursive: true });
    try {
      const data = fixture();
      const diagnostics = await openFixture(page, { fixtureSnapshot: data, surface: surface.surface });
      if (surface.mobile) {
        await page.locator('[data-mobile-dialogs-tab="chat"]').click();
        const scope = page.locator("[data-mobile-workspace-label]");
        assert.equal(await scope.getAttribute("aria-label"), `Сменить Workspace: ${workspaceName}`);
        assert.equal(await scope.locator("small").innerText(), "Workspace");
        assert.equal(await scope.locator("strong").innerText(), workspaceName);
        assert.equal(await scope.locator("svg").getAttribute("aria-hidden"), "true");
        assert.equal(await page.locator(".mobile-dialogs h1").innerText(), "Потоки");
        assert.equal(await page.locator("[data-mobile-stream-filter]").getAttribute("placeholder"), "Поиск по потокам");
        assert.equal(await page.locator("[data-mobile-stream-create]").innerText(), "Новый поток");
        const empty = page.locator('[data-mobile-stream-list] [data-mobile-stream-id="stream-a"]').first();
        assert.equal(await empty.locator(".mobile-stream-preview, .provider-dot, .mobile-stream-running").count(), 0);
        assert.equal(await empty.locator("strong").innerText(), "Поток 1");
        await capture(page, `${surface.name}-empty`);

        data.version = "mixed";
        data.tasks[2].running = true;
        data.tasks[2].run = { turnId: "active-turn", operationKind: "user-turn", projectionState: "active" };
        data.tasks[3].lastAnswer = "Готовый ответ агента";
        data.tasks[3].lastAnswerAt = "2026-10-17T12:00:00Z";
        data.tasks[3].unread = true;
        data.tasks[4].lastAnswer = "Прочитанный ответ агента";
        data.tasks[4].lastAnswerAt = "2026-10-17T11:00:00Z";
        await page.evaluate((data) => localStorage.setItem("fixture:snapshot", JSON.stringify(data)), data);
        await page.reload();
        await page.waitForFunction(() => document.querySelector('[data-mobile-stream-id="stream-c"] .mobile-stream-running')?.textContent === "Готовит ответ");
        await page.evaluate(() => {
          AgentHub.setMessages("stream-b", [{ id: "user-b", role: "user", text: "Вопрос без ответа 🛰" }]);
          AgentHub.setMessages("stream-c", [{ id: "user-c", role: "user", turnId: "active-turn", text: "Текущий вопрос" }]);
        });
        const row = (id) => page.locator(`[data-mobile-stream-list] [data-mobile-stream-id="${id}"]`).last();
        assert.equal(await row("stream-b").locator(".mobile-stream-preview").innerText(), "Вы: Вопрос без ответа 🛰");
        assert.equal(await row("stream-b").locator(".mobile-stream-running").count(), 0);
        assert.equal(await row("stream-c").locator(".mobile-stream-preview").innerText(), "Вы: Текущий вопрос");
        assert.equal(await row("stream-d").locator(".mobile-stream-preview").innerText(), "Готовый ответ агента");
        assert.equal(await row("stream-d").locator(".mobile-stream-new").innerText(), "Новое");
        assert.equal(await row("stream-e").locator(".mobile-stream-preview").innerText(), "Прочитанный ответ агента");
        assert.equal(await row("stream-e").locator(".mobile-stream-new, .mobile-stream-running").count(), 0);
        assert.equal(await row("stream-g").locator("strong").innerText(), "Stream пользователя");
        assert.equal(await row("stream-f").locator("strong").getAttribute("title"), longName);
        assert.equal(await row("stream-b").getAttribute("aria-label"), "Вопрос. Вы: Вопрос без ответа 🛰");
        assert.equal(await page.locator("[data-mobile-stream-list][aria-live]").count(), 0);
        await capture(page, `${surface.name}-mixed`);
        await page.evaluate(() => AgentHub.setLive("stream-c", {
          provider: "codex", threadId: "thread-c", turnId: "active-turn",
          projectionState: "active", operationKind: "user-turn", text: "Первый фрагмент ответа",
        }));
        assert.equal(await row("stream-c").locator(".mobile-stream-running").innerText(), "Отвечает");
        assert.equal(await row("stream-c").locator(".mobile-stream-preview").innerText(), "Вы: Текущий вопрос");
        assert.doesNotMatch((await page.locator("body").innerText()).replaceAll("Stream пользователя", "").replaceAll(longName, "").replaceAll(workspaceName, ""),
          /Stream|диалог|Пока нет ответа|Ход выполняется/iu);
        await capture(page, `${surface.name}-running`);
        const metrics = await geometry(page, true);
        assert.equal(metrics.overflow, 0);
        assert.equal(metrics.collisions, 0);
        assert.equal(metrics.multiline, 0);
        assert.deepEqual(metrics.typography, {
          heading: { size: 16, lineHeight: 20, weight: "600" },
          workspace: { size: 17.6, lineHeight: 22, weight: "600" },
          label: { size: 11.2, lineHeight: 14, weight: "500" },
          oneLineWorkspace: true, clearCaret: true,
        });
        for (const target of metrics.targets) assert.ok(target.width >= 44 && target.height >= 44, JSON.stringify(target));
        await writeFile(path.join(captures, `${surface.name}-metrics.json`), JSON.stringify(metrics, null, 2));
        await page.locator("[data-mobile-stream-filter]").fill("Поток 1");
        assert.equal(await page.locator("[data-mobile-stream-list] .mobile-stream-row").count(), 1);
        await page.locator("[data-mobile-stream-filter]").fill("");
        await row("stream-f").click();
      } else {
        assert.equal(await page.locator('[data-action="stream-create"]').getAttribute("aria-label"), "Новый поток");
        assert.equal(await page.locator('[data-stream-tab-id="stream-a"]').first().locator(".stream-tab-title").innerText(), "Поток 1");
        await page.evaluate(() => AgentHub.showSelectedTask());
        await page.locator(".stream-tabs-track .stream-tab:visible").first().dispatchEvent("contextmenu", { clientX: 100, clientY: 100 });
        const rotate = page.locator('.stream-context-menu:not([hidden]) [data-stream-menu-action="replace-thread"]');
        assert.equal(await rotate.isVisible(), true);
        const menuTitle = await rotate.getAttribute("title");
        assert.equal(menuTitle, "Завершить текущую работу агента и продолжить поток в новом контексте Codex");
        await writeFile(path.join(captures, `${surface.name}-menu.json`), JSON.stringify({ title: menuTitle, visible: true }, null, 2));
        await capture(page, `${surface.name}-menu`);
        await page.keyboard.press("Escape");
        await page.locator("[data-composer-input]").click();
        assert.equal(await page.locator('.stream-context-menu:not(.workspace-context-menu)').isVisible(), false);
      }
      const header = page.locator("[data-stream-chat-header]");
      assert.equal(await header.locator(".stream-chat-workspace-label").isVisible(), true);
      assert.equal(await header.locator(".stream-chat-workspace-label").innerText(), "Workspace");
      assert.equal(await header.locator("[data-stream-header-workspace]").innerText(), workspaceName);
      assert.equal(await header.locator("[data-stream-header-workspace]").isVisible(), true);
      if (!surface.mobile) assert.equal(await header.locator("[data-stream-header-name]").innerText(), "Поток 1");
      assert.doesNotMatch((await page.locator("body").innerText()).replaceAll("Stream пользователя", "").replaceAll(longName, "").replaceAll(workspaceName, ""),
        /Stream|диалог|Пока нет ответа|Ход выполняется/iu);
      await capture(page, `${surface.name}-opened`);
      const create = surface.mobile ? page.locator("[data-mobile-chat-stream-create]")
        : page.locator('[data-action="stream-create"]');
      assert.equal(await create.getAttribute("aria-label"), "Новый поток");
      if (surface.mobile) {
        assert.equal(await page.locator("[data-mobile-stream-switch]").getAttribute("title"), `Переключить поток: ${longName}`);
        assert.equal(await page.locator("[data-mobile-stream-switch]").getAttribute("aria-label"), `Переключить поток: ${longName}`);
        await page.locator("[data-mobile-stream-switch]").click();
        assert.equal(await page.locator("[data-mobile-stream-switcher]").getAttribute("aria-label"), "Потоки Workspace");
        await page.keyboard.press("Escape");
      }
      await page.locator("[data-dialog-settings-toggle]").click();
      const settings = page.locator("[data-dialog-settings]");
      assert.equal(await settings.getAttribute("aria-label"), "Карточка потока");
      assert.doesNotMatch(await settings.innerText(), /Stream|Thread|диалог|Пока нет ответа|Ход выполняется/iu);
      assert.equal(await settings.locator("[data-dialog-working-directory-note]").innerText(),
        "Новая директория начнёт использоваться после следующего запуска агента. Текущая работа продолжится в прежней директории.");
      assert.doesNotMatch(await settings.locator("[data-stream-card-rotate]").getAttribute("title"), /Thread/u);
      assert.equal(await settings.locator("[data-dialog-stream-rules]").getAttribute("placeholder"), "Дополнительные инструкции для этого потока");
      const attributes = await assertDialogAccessibleCopy(page);
      const gapToggle = page.locator("[data-stream-gap-toggle]");
      if (surface.width >= 860 && surface.surface === "web") {
        assert.equal(await gapToggle.getAttribute("aria-label"), "Отступ между карточками потоков");
      } else {
        assert.equal(await gapToggle.count(), 0);
      }
      await writeFile(path.join(captures, `${surface.name}-accessible-copy.json`), JSON.stringify(attributes, null, 2));
      await capture(page, `${surface.name}-settings`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal((await bridgeCalls(page, "send-message")).length, 0);
      assert.deepEqual(diagnostics, []);
    } finally { await page.close(); await browser.close(); }
  });
}
