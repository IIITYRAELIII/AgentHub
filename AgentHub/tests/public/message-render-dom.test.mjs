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

let browser;

function webAssetContentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

async function openWebApp(page) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "127.0.0.1") {
      await route.abort();
      return;
    }
    if (requestUrl.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      return;
    }
    if (requestUrl.pathname === "/work-log.css") {
      await route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
      return;
    }
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: webAssetContentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://127.0.0.1/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
}

async function seedMessages(page, messages, taskPatch = {}) {
  await page.evaluate(({ values, taskPatch }) => {
    window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent HUB", title: "Agent HUB" }]);
    window.AgentHub.setTasks([{
      id: "task-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-1",
      streamName: "Chat",
      streamOrdinal: 1,
      title: "Chat",
      provider: "codex",
      agentLabel: "Codex",
      modelLabel: "Sol",
      status: "ready",
      statusLabel: "Готов",
      unread: false,
      running: false,
      selected: true,
      ...taskPatch,
    }]);
    window.AgentHub.setMessages("task-1", values);
  }, { values: messages, taskPatch });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test.before(async () => {
  const { chromium } = await import("playwright");
  browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
});

test("compaction without provider turn renders a system marker and unknown completion stays explicit", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openWebApp(page);
    const source = await readFile(new URL("hub-client.js", WEB_APP_ROOT), "utf8");
    const clientFunction = (name, next) => {
      const start = source.indexOf(`function ${name}(`);
      return source.slice(start, source.indexOf(`function ${next}`, start));
    };
    await page.addScriptTag({ content: `(() => {
      const taskId = () => "task-1";
      const maintenanceEventsByTask = new Map();
      const observedContextCompactions = new Map();
      const requestedContextCompactions = new Set();
      const latestMaintenanceMessages = (values) => values;
      const persistMaintenanceEvents = () => {};
      const contextPercent = (value) => value == null ? null : Number(value);
      const storedMaintenancePercent = () => null;
      const agentHub = { toast: () => {} };
      ${clientFunction("rotationMaintenanceActive", "syncActiveMaintenanceMessages")}
      ${clientFunction("rememberMaintenanceEvent", "taskIdentity")}
      ${clientFunction("observeContextCompactions", "observeStreamRotations")}
      window.compactionProjection = {
        active: activeMaintenanceMessage,
        observe: (task) => {
          observeContextCompactions([task]);
          return maintenanceEventsByTask.get("task-1");
        },
      };
    })();` });
    const marker = await page.evaluate(() => window.compactionProjection.active({
      provider: "codex", threadId: "thread-1",
      context: { compaction: { operationId: "operation-1", status: "running", turnId: null, origin: "automatic" } },
    }));
    await seedMessages(page, [marker]);
    assert.equal(await page.locator(".msg-maintenance").count(), 1);
    assert.match(await page.locator(".msg-maintenance").textContent(), /Автосвёртка контекста/u);
    assert.equal(await page.locator(".msg-agent").count(), 0);
    const preparation = {
      maintenance: { reason: "automatic-post-turn", phase: "preparing", reservationId: "reservation-new" },
      context: { usedTokens: 75.04, modelContextWindow: 100, percent: 75.04, compacting: false,
        compaction: { id: "older", status: "completed", measurementStatus: "completed", afterPercent: 14 } },
    };
    const preparationMarker = await page.evaluate((details) => window.compactionProjection.active({
      provider: "codex", threadId: "thread-1", ...details,
    }), preparation);
    await page.evaluate(() => {
      window.__stops = [];
      window.AgentHub.on("task:stop", (value) => window.__stops.push(value));
    });
    for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await seedMessages(page, [preparationMarker], preparation);
      if (viewport.width < 600) await page.locator('[data-mobile-button="chat"]').click();
      assert.match(await page.locator(".msg-maintenance").textContent(), /Подготовка обслуживания контекста/u);
      assert.equal(await page.locator(".msg-agent").count(), 0);
      assert.equal(await page.locator("[data-context-label]").textContent(), "подготовка…");
      assert.equal(await page.locator("[data-context-usage]").getAttribute("data-compacting"), null);
      const stop = page.locator("[data-chat-stop]:visible");
      assert.equal(await stop.count(), 1);
      await stop.click();
      await page.locator("[data-context-usage]").click();
      assert.equal(await page.locator("[data-context-usage-compact]").isDisabled(), true);
      await page.locator('[data-context-usage-modal] [data-action="context-usage-close"]').first().click();
      if (process.env.AGENT_HUB_QA_SCREENSHOT) await page.screenshot({
        path: `${process.env.AGENT_HUB_QA_SCREENSHOT}-${viewport.width}.png`, fullPage: true,
      });
    }
    assert.deepEqual(await page.evaluate(() => window.__stops), [{ id: "task-1" }, { id: "task-1" }]);
    await seedMessages(page, [], { ...preparation,
      maintenance: { ...preparation.maintenance, phase: "starting" },
    });
    assert.equal(await page.locator("[data-context-label]").textContent(), "запуск…");
    assert.equal(await page.locator("[data-chat-stop]:visible").count(), 0);
    await seedMessages(page, [], { ...preparation, maintenance: null });
    assert.equal(await page.locator("[data-context-label]").textContent(), "75% контекста");
    assert.equal(await page.locator("[data-chat-stop]:visible").count(), 0);
    for (const [status, expectedText] of [
      ["failed", "Автосвёртка контекста не завершилась"],
      ["unknown", "Статус свёртки неизвестен"],
      ["completed", "Свёртка контекста"],
    ]) {
      const messages = await page.evaluate((status) => window.compactionProjection.observe({
        provider: "codex", threadId: "thread-1",
        context: { compaction: {
          operationId: "operation-1", status, turnId: null, origin: "automatic",
          beforePercent: 77, afterPercent: status === "completed" ? 14 : null,
          measurementStatus: status === "completed" ? "completed" : null,
        } },
      }), status);
      await seedMessages(page, messages);
      assert.equal(await page.locator(".msg-maintenance").count(), 1);
      assert.ok((await page.locator(".msg-maintenance").textContent()).includes(expectedText));
      assert.equal(await page.locator(".msg-agent").count(), 0);
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("long annotated message mounts full Markdown only while expanded and actions keep original text", async () => {
  const page = await browser.newPage();
  try {
    await openWebApp(page);
    const fullText = `${"Большой пользовательский отчёт без потерь. ".repeat(140)}\n\n[Полный Markdown](https://example.test/full)`;
    await page.evaluate(() => {
      window.__messageEvents = { copies: [], sends: [] };
      window.AgentHub.on("clipboard:write", (detail) => window.__messageEvents.copies.push(detail));
      window.AgentHub.on("message:send", (detail) => window.__messageEvents.sends.push(detail));
    });
    await seedMessages(page, [{
      id: "long-user",
      role: "user",
      author: "Вы",
      text: fullText,
      responseAnnotations: [{ text: "Фрагмент", annotation: "Проверь внимательно" }],
      responseAnnotationRequest: fullText,
    }, {
      id: "agent-answer",
      role: "agent",
      author: "Codex",
      text: "Ответ готов",
    }]);

    const article = page.locator('[data-message-id="long-user"]');
    const disclosure = article.locator("[data-message-disclosure]");
    assert.equal(await article.locator(".msg-deferred-preview").count(), 1);
    assert.ok((await article.locator(".msg-deferred-preview").textContent()).length <= 1_602);
    assert.equal(await article.locator(".msg-annotations").count(), 0);
    assert.equal(await article.locator('a[href="https://example.test/full"]').count(), 0);

    await disclosure.click();
    assert.equal(await article.locator(".msg-deferred-preview").count(), 0);
    assert.equal(await article.locator(".msg-annotations").count(), 1);
    assert.equal(await article.locator('a[href="https://example.test/full"]').count(), 1);

    await disclosure.click();
    assert.equal(await article.locator(".msg-deferred-preview").count(), 1);
    assert.equal(await article.locator(".msg-annotations").count(), 0);
    assert.equal(await article.locator('a[href="https://example.test/full"]').count(), 0);

    await page.locator('.msg-stack:has([data-message-id="long-user"]) [data-message-copy]').click();
    await page.locator('.msg-stack:has([data-message-id="agent-answer"]) [data-message-repeat]').dispatchEvent("click");
    await page.locator('.msg-stack:has([data-message-id="long-user"]) [data-message-edit]').click();
    assert.equal(await page.locator("[data-composer-input]").inputValue(), fullText);
    const events = await page.evaluate(() => window.__messageEvents);
    assert.equal(events.copies[0].text, fullText);
    assert.equal(events.sends[0].text, fullText.trim());
  } finally {
    await page.close();
  }
});

test("completed reasoning and tools exist only while their disclosure is open", async () => {
  const page = await browser.newPage();
  try {
    await openWebApp(page);
    await seedMessages(page, [{
      id: "agent-trace",
      role: "agent",
      author: "Codex",
      text: "Итог",
      activityGroups: [{
        id: "trace-1",
        reasoning: "# Скрытое рассуждение",
        activities: [{
          id: "tool-1",
          type: "tool",
          status: "completed",
          label: "Скрытый инструмент",
          detail: "Результат инструмента",
        }],
      }],
    }]);

    const trace = page.locator('[data-message-id="agent-trace"] details.turn-trace');
    assert.equal(await trace.getAttribute("open"), null);
    assert.equal(await trace.locator(".turn-trace-reasoning").count(), 0);
    assert.equal(await trace.locator(".activity-item").count(), 0);

    await trace.locator(":scope > summary").click();
    await trace.locator(".turn-trace-reasoning").waitFor();
    assert.equal(await trace.locator(".turn-trace-reasoning").textContent(), "Скрытое рассуждение");
    assert.equal(await trace.locator(".activity-item").count(), 1);
    assert.match(await trace.locator(".activity-item").textContent(), /Скрытый инструмент/u);

    await trace.locator(":scope > summary").click();
    await page.waitForFunction(() => !document.querySelector('[data-message-id="agent-trace"] .turn-trace-reasoning'));
    assert.equal(await trace.locator(".turn-trace-reasoning").count(), 0);
    assert.equal(await trace.locator(".activity-item").count(), 0);
    assert.equal(await trace.locator("[data-deferred-disclosure-content]").evaluate((node) => node.childElementCount), 0);
  } finally {
    await page.close();
  }
});

test("citation navigation materializes a deferred source before range lookup", async () => {
  const page = await browser.newPage();
  try {
    await openWebApp(page);
    const selectedText = "ЦЕЛЕВОЙ ФРАГМЕНТ В КОНЦЕ";
    const sourceText = `${"Длинный исходный текст. ".repeat(220)}${selectedText}`;
    await page.evaluate(async ({ selectedText, sourceText }) => {
      const message = {
        id: "source-user",
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-source",
        itemId: "item-source",
        role: "user",
        author: "Вы",
        text: sourceText,
      };
      const disclosure = window.AgentHubMessageDisclosure;
      const identity = disclosure.responseAnnotationSourceIdentity(message);
      const start = sourceText.indexOf(selectedText);
      const source = {
        version: 1,
        ...identity,
        surfaceKind: "message-body",
        surfaceIndex: 0,
        start,
        end: start + selectedText.length,
        contentHash: await disclosure.responseAnnotationSha256(
          disclosure.responseAnnotationSourceContent(message),
        ),
        surfaceHash: await disclosure.responseAnnotationSha256(sourceText),
        selectionHash: await disclosure.responseAnnotationSha256(selectedText),
      };
      window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent HUB", title: "Agent HUB" }]);
      window.AgentHub.setTasks([{
        id: "task-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        workspaceName: "Agent HUB",
        streamId: "stream-1",
        streamName: "Chat",
        streamOrdinal: 1,
        title: "Chat",
        provider: "codex",
        agentLabel: "Codex",
        modelLabel: "Sol",
        status: "ready",
        statusLabel: "Готов",
        selected: true,
      }]);
      window.AgentHub.setMessages("task-1", [message, {
        id: "annotation-user",
        role: "user",
        author: "Вы",
        text: "Проверь источник",
        responseAnnotations: [{
          text: selectedText,
          annotation: "Проверить точный источник",
          source,
        }],
        responseAnnotationRequest: "Проверь источник",
      }]);
    }, { selectedText, sourceText });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const sourceArticle = page.locator('[data-message-id="source-user"]');
    assert.equal(await sourceArticle.locator(".msg-deferred-preview").count(), 1);
    assert.equal((await sourceArticle.locator(".msg-body").textContent()).includes(selectedText), false);
    await page.locator('[data-message-id="annotation-user"] [data-response-annotation-source]').click();
    await sourceArticle.locator(".msg-source-citation-highlight").waitFor();
    assert.equal(await sourceArticle.locator(".msg-deferred-preview").count(), 0);
    assert.equal(await sourceArticle.locator(".msg-body").getAttribute("data-response-citation-source-focus"), "");
    assert.equal(await sourceArticle.locator(".msg-source-citation-highlight").textContent(), selectedText);
  } finally {
    await page.close();
  }
});
