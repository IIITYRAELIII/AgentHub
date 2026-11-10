import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

// These are view-owner cases. Load the complete app and its modules without
// starting the transport client; drive the same public APIs it normally uses.
// History request/response semantics have separate real-client coverage.
async function withSurface(body, { mobile = false, beforeOpen = async () => {}, surface = "web", width = mobile ? 390 : 1280 } = {}) {
  const browser = await launchBrowser();
  let page;
  try {
    page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: mobile });
    page.setDefaultTimeout(5_000);
    await beforeOpen(page);
    const errors = await openFixture(page, { surface, expectedTaskId: null, assetOverrides: { "hub-client.js": "" } });
    await page.waitForFunction(() => window.AgentHub);
    await page.evaluate(async () => {
      const api = window.AgentHub;
      await api.whenComposerRecoveryReady();
      api.setWorkspaces([{ id: "workspace-1", name: "Workspace", streams: [{ id: "stream-a", name: "Stream A", ordinal: 1 }] }]);
      api.setTasks([{ id: "stream-a", streamId: "stream-a", streamName: "Stream A", streamDisplayName: "Stream A",
        provider: "codex", threadId: "thread-a", workspaceId: "workspace-1", workspaceName: "Workspace",
        title: "Stream A", status: "ready", statusLabel: "Готов", selected: true }]);
      api.selectTask("stream-a");
      api.showSelectedTask();
    });
    try { await body(page); } catch (error) {
      error.message += "\nview diagnostic " + JSON.stringify(await page.evaluate(() => ({
        view: document.documentElement.dataset.view, pane: document.documentElement.dataset.pane,
        journal: document.querySelector("[data-journal]")?.textContent?.slice(0, 150),
        journalBusy: document.querySelector("[data-journal]")?.getAttribute("aria-busy"),
        sync: document.querySelector("[data-statistics-sync-card]")?.textContent?.slice(0, 150),
        toast: document.querySelector("[data-toast]")?.textContent,
      })).catch(() => ({ documentClosed: true })));
      error.stack += "\n" + error.message;
      throw error;
    }
    assert.deepEqual(errors, []);
  } finally {
    await page?.unrouteAll({ behavior: "wait" });
    await browser.close();
  }
}

test("chat view distinguishes an unread history page from a loaded empty page and rendered content", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    const log = page.locator("[data-chat-log]");
    assert.match(await log.textContent(), /Загрузка истории/u);
    await page.evaluate(() => window.AgentHub.setMessages("stream-a", []));
    assert.doesNotMatch(await log.textContent(), /Загрузка истории/u);
    assert.equal(await log.locator(".msg").count(), 0);
    await page.evaluate(() => window.AgentHub.setMessages("stream-a", [{ id: "visible-user", role: "user", text: "Exact visible question" }]));
    assert.equal(await log.locator(".msg-user").textContent().then(text => text.includes("Exact visible question")), true);
    assert.doesNotMatch(await log.textContent(), /Загрузка истории/u);
  });
});

test("rendered chat keeps subagent disclosure, Markdown tables and live reasoning separate from the answer", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    await page.evaluate(() => window.AgentHub.setMessages("stream-a", [
      { id: "worker-answer", role: "agent", kind: "subagent", author: "Worker", text: "## Readable worker result\n\nWorker body" },
      { id: "table-answer", role: "agent", text: "| Name | Value |\n| --- | --- |\n| Test | **Cell value** |" },
    ]));
    const child = page.locator("details[data-subagent-response]");
    assert.equal(await child.evaluate(node => node.open), false);
    assert.match(await child.locator("summary").textContent(), /Readable worker result/u);
    await child.locator("summary").click();
    assert.match(await child.textContent(), /Worker body/u);
    assert.equal(await page.locator(".markdown-table th").count(), 2);
    assert.equal(await page.locator(".markdown-table td strong").textContent(), "Cell value");
    await page.evaluate(() => window.AgentHub.setLive("stream-a", { provider: "codex", threadId: "thread-a", turnId: "live-turn",
      operationKind: "user-turn", projectionState: "active", stage: "Working", reasoning: "**Reasoning fact**",
      text: "**Answer fact**" }));
    const reasoning = page.locator("[data-chat-live] [data-live-reasoning]");
    const answer = page.locator("[data-chat-live] [data-live-body]");
    assert.match(await reasoning.textContent(), /Reasoning fact/u);
    assert.doesNotMatch(await reasoning.textContent(), /Answer fact/u);
    assert.equal(await answer.locator("strong").textContent(), "Answer fact");
    assert.doesNotMatch(await answer.textContent(), /Reasoning fact/u);
  });
});

test("document input and both clipboard file representations create one exact file card per file", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    assert.doesNotMatch(await page.locator("[data-file-input]").getAttribute("accept") ?? "", /image\/\*/u);
    await page.locator("[data-file-input]").setInputFiles({ name: "document.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic document") });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] .attachment-file-name").length === 1
      && document.querySelectorAll("[data-attachments] [data-attachment-preparing]").length === 0);
    await page.locator("[data-composer-input]").evaluate(node => {
      const data = new DataTransfer();
      data.items.add(new File(["Item payload"], "clipboard-item.txt", { type: "text/plain" }));
      node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] .attachment-file-name").length === 2
      && document.querySelectorAll("[data-attachments] [data-attachment-preparing]").length === 0);
    await page.locator("[data-composer-input]").evaluate(node => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { items: [],
        files: [new File(["Fallback payload"], "clipboard-fallback.csv", { type: "text/csv" })] } });
      node.dispatchEvent(event);
    });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] .attachment-file-name").length === 3
      && document.querySelectorAll("[data-attachments] [data-attachment-preparing]").length === 0);
    assert.deepEqual(await page.locator("[data-attachments] .attachment-file-name").allTextContents(),
      ["document.txt", "clipboard-item.txt", "clipboard-fallback.csv"]);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "");
  });
});

test("mobile viewer arrows and Back return from image to the same chat and then its dialogs", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    await page.evaluate(() => {
      const dataUrl = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>');
      window.AgentHub.openAttachmentViewer({ gallery: [
        { name: "First image", type: "image/svg+xml", dataUrl },
        { name: "Second image", type: "image/svg+xml", dataUrl },
      ], index: 0 });
    });
    await page.locator("[data-attachment-viewer]").waitFor({ state: "visible" });
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("[data-attachment-viewer-name]").textContent(), "Second image");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator("[data-attachment-viewer-name]").textContent(), "First image");
    assert.equal(await page.evaluate(() => window.AgentHub.navigateBack()), true);
    assert.equal(await page.locator("[data-attachment-viewer]").isVisible(), false);
    assert.equal(await page.locator("[data-chat-pane]").getAttribute("data-stream-chat-task-id"), "stream-a");
    assert.equal(await page.evaluate(() => window.AgentHub.navigateBack()), true);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.pane), "tasks");
  }, { mobile: true });
});

test("mobile older-history button and pull distinguish cancellation, release and in-flight ownership", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    await page.evaluate(() => {
      window.__olderRequests = [];
      const api = window.AgentHub;
      api.on("history:load-older", ({ taskId }) => {
        window.__olderRequests.push(taskId);
        api.setHistoryPagination(taskId, { hasOlder: true, loading: true });
      });
      api.setHistoryPagination("stream-a", { hasOlder: true, loading: true, messageTotal: 40 });
      api.setMessages("stream-a", Array.from({ length: 20 }, (_, i) => ({ id: `current-${i}`, role: "user", text: `Current question ${i} ${"visible text ".repeat(80)}` })));
      document.querySelector("[data-chat-pane] .chat-scroll").scrollTop = 0;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(() => {
      const api = window.AgentHub;
      const scroll = document.querySelector("[data-chat-pane] .chat-scroll");
      const loader = document.querySelector("[data-history-loader]");
      const filled = scroll.scrollHeight > scroll.clientHeight;
      const touch = y => new Touch({ identifier: 1, target: scroll, clientX: 190, clientY: y });
      const fire = (type, y) => scroll.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: ["touchend", "touchcancel"].includes(type) ? [] : [touch(y)], changedTouches: [touch(y)] }));
      api.setHistoryPagination("stream-a", { hasOlder: true, loading: false });
      scroll.scrollTop = 0;
      fire("touchstart", 100); fire("touchmove", 140);
      const short = { pulling: loader.hasAttribute("data-pulling"), armed: loader.hasAttribute("data-armed") };
      fire("touchend", 140);
      const afterShort = window.__olderRequests.length;
      fire("touchstart", 100); fire("touchmove", 360);
      const long = { pulling: loader.hasAttribute("data-pulling"), armed: loader.hasAttribute("data-armed"), label: loader.textContent };
      fire("touchcancel", 360);
      const afterCancel = window.__olderRequests.length;
      const reset = !loader.hasAttribute("data-pulling") && !loader.hasAttribute("data-armed");
      fire("touchstart", 100); fire("touchmove", 360); fire("touchend", 360);
      const afterRelease = [...window.__olderRequests];
      fire("touchstart", 100); fire("touchmove", 360); fire("touchend", 360);
      const whileLoading = window.__olderRequests.length;
      api.setHistoryPagination("stream-a", { hasOlder: true, loading: false });
      document.querySelector("[data-history-load]").click();
      const afterButton = [...window.__olderRequests];
      api.navigateBack();
      api.setHistoryPagination("stream-a", { hasOlder: true, loading: false });
      document.querySelector("[data-history-load]").click();
      return { filled, short, long, reset, afterShort, afterCancel,
        afterRelease, whileLoading, afterButton, afterHidden: window.__olderRequests.length };
    });
    assert.equal(result.filled, true);
    assert.deepEqual(result.short, { pulling: true, armed: false });
    assert.equal(result.long.pulling, true);
    assert.equal(result.long.armed, true);
    assert.match(result.long.label, /Отпустите/u);
    assert.equal(result.reset, true);
    assert.equal(result.afterShort, 0);
    assert.equal(result.afterCancel, 0);
    assert.deepEqual(result.afterRelease, ["stream-a"]);
    assert.equal(result.whileLoading, 1);
    assert.deepEqual(result.afterButton, ["stream-a", "stream-a"]);
    assert.equal(result.afterHidden, 2);
  }, { mobile: true });
});


test("mobile left-edge Back claims only a completed horizontal gesture and preserves the draft", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    await page.locator("[data-composer-input]").fill("Retained mobile draft");
    const outcome = await page.evaluate(() => {
      const target = document.querySelector("[data-chat-log]");
      const fire = (type, x, y) => {
        const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
        const event = new TouchEvent(type, { bubbles: true, cancelable: true,
          touches: ["touchend", "touchcancel"].includes(type) ? [] : [touch], changedTouches: [touch] });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      fire("touchstart", 190, 200); fire("touchmove", 300, 205); fire("touchend", 300, 205);
      const afterMiddle = document.documentElement.dataset.pane;
      fire("touchstart", 5, 200); fire("touchmove", 120, 205); fire("touchcancel", 120, 205);
      const afterCancel = document.documentElement.dataset.pane;
      fire("touchstart", 5, 200); fire("touchmove", 9, 360); fire("touchend", 9, 360);
      const afterVertical = document.documentElement.dataset.pane;
      fire("touchstart", 5, 200);
      const claimed = fire("touchmove", 120, 205);
      fire("touchend", 120, 205);
      return { afterMiddle, afterCancel, afterVertical, claimed, afterBack: document.documentElement.dataset.pane };
    });
    assert.deepEqual(outcome, { afterMiddle: "chat", afterCancel: "chat", afterVertical: "chat", claimed: true, afterBack: "tasks" });
    await page.evaluate(() => window.AgentHub.showSelectedTask());
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "Retained mobile draft");
  }, { mobile: true });
});


test("shared composer exposes diff and Stream settings without a duplicate chat header", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    await page.evaluate(() => {
      window.__viewIntents = [];
      document.addEventListener("agenthub:intent", event => window.__viewIntents.push(structuredClone(event.detail)));
    });
    const pane = page.locator("[data-chat-pane]");
    assert.equal(await pane.locator(".chat-head, .chat-actions, [data-mobile-chat-actions]").count(), 0);
    const diff = pane.locator('.chat-overlay-actions [data-action="task-diff"]');
    const settings = pane.locator('.chat-overlay-actions [data-action="task-settings"]');
    assert.equal(await diff.isVisible(), true);
    assert.equal(await settings.isVisible(), true);
    await diff.click();
    assert.equal(await page.evaluate(() => window.__viewIntents.some(entry => entry.type === "task:diff" && entry.id === "stream-a")), true);
    await settings.click();
    assert.equal(await page.locator("[data-dialog-settings]").isVisible(), true);
    assert.equal(await page.locator('[data-settings-panel]').isVisible(), false);
    await page.locator("[data-dialog-settings-close]").click();
    assert.equal(await page.locator("[data-dialog-settings]").isVisible(), false);
  });
});

test("local file citation renders its exact target and location as an interactive compact link", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    await page.evaluate(() => window.AgentHub.setMessages("stream-a", [{ id: "file-answer", role: "agent",
      text: ':codex-file-citation{path="D:/Synthetic/report.xlsx" sheet="Sheet 1" range="A1:C3"}' }]));
    const link = page.locator('[data-message-id="file-answer"] a.file-citation');
    assert.equal(await link.textContent(), "report.xlsx · Sheet 1 · A1:C3");
    assert.equal(await link.getAttribute("data-agent-hub-local-link"), "D:/Synthetic/report.xlsx");
    assert.equal(await link.getAttribute("title"), "D:/Synthetic/report.xlsx");
    assert.equal(await link.isVisible(), true);
  });
});

test("Sync nickname, enrollment and invite use the shared dialog without a native browser prompt", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    let status = { configured: false, serverUrl: "https://sync.invalid", deviceLabel: "Synthetic device" };
    const mutations = [];
    const nativeDialogs = [];
    page.on("dialog", async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.route("**/api/journal**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/journal") return route.fulfill({ json: { version: "sync-view", html: "", updatedAt: "2026-11-10T10:00:00Z", usageSync: status } });
      if (url.pathname.endsWith("/device-label")) {
        const body = route.request().postDataJSON(); mutations.push({ kind: "label", ...body }); status = { ...status, deviceLabel: body.deviceLabel };
        return route.fulfill({ json: { usageSync: status } });
      }
      if (url.pathname.endsWith("/enroll")) {
        mutations.push({ kind: "enroll", ...route.request().postDataJSON() }); status = { ...status, configured: true };
        return route.fulfill({ json: { usageSync: status } });
      }
      if (url.pathname.endsWith("/invite")) return route.fulfill({ json: { usageSync: status, result: { code: "SYNTHETIC-INVITE" } } });
      return route.fulfill({ json: {} });
    });
    await page.locator('[data-view-button="statistics"]').click();
    const card = page.locator("[data-statistics-sync-card]");
    await card.getByRole("button", { name: "Ник устройства", exact: true }).evaluate(button => button.click());
    const dialog = page.locator("[data-text-dialog]");
    await dialog.waitFor({ state: "visible" });
    assert.match(await dialog.textContent(), /Никнейм этого устройства/u);
    await page.locator("[data-text-dialog-input]").fill("Renamed synthetic device");
    await page.locator("[data-text-dialog-ok]").click();
    await page.waitForFunction(() => document.querySelector('[data-journal-sync-connect]')?.disabled === false);
    await page.locator("[data-journal-sync-connect]").evaluate(button => button.click());
    await dialog.waitFor({ state: "visible" });
    assert.match(await dialog.textContent(), /Введите код/u);
    await page.locator("[data-text-dialog-input]").fill("SYNTHETIC-ENROLL");
    await page.locator("[data-text-dialog-ok]").click();
    await page.waitForFunction(() => document.querySelector('[data-journal-sync-connect]')?.disabled === false);
    await page.locator("[data-journal-sync-connect]").evaluate(button => button.click());
    await dialog.waitFor({ state: "visible" });
    assert.match(await dialog.textContent(), /Код подключения Sync для другого устройства/u);
    assert.equal(await page.locator("[data-text-dialog-input]").inputValue(), "SYNTHETIC-INVITE");
    await page.locator("[data-text-dialog-cancel]").click();
    assert.deepEqual(mutations, [{ kind: "label", deviceLabel: "Renamed synthetic device" },
      { kind: "enroll", serverUrl: "https://sync.invalid", code: "SYNTHETIC-ENROLL" }]);
    assert.deepEqual(nativeDialogs, []);
  }, { surface: "vscode" });
});

test("grouped Claude journal retains latest content and independently collapsible earlier and child turns", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    const turn = (id, label, time, open = false, child = "") => `<div data-work-log-turn-entry data-work-log-turn-provider="claude"
      data-work-log-turn-thread-id="claude-thread" data-work-log-turn-id="${id}" data-work-log-turn-depth="0"
      data-work-log-turn-completed-at="2026-11-10T${time}:00Z"><details data-work-log-turn-details ${open ? "open" : ""}>
      <summary><span data-work-log-turn-title>${label}</span></summary><p>${label} body</p>${child}</details></div>`;
    const child = '<details data-work-log-turn-children-details><summary>Worker turn</summary><div data-work-log-turn-children><p>Worker body</p><details data-work-log-turn-children-details><summary>Grandchild turn</summary><p>Grandchild body</p></details></div></details>';
    const html = `<details data-work-log-day-section open><summary data-work-log-day><strong>10.11.2026</strong></summary>
      <div data-work-log-row data-work-log-provider="claude" data-work-log-thread-id="claude-thread" data-work-log-workspace-id="workspace-1" data-work-log-stream-id="stream-a">
      <div data-work-log-task-content>Claude work</div><div data-work-log-turn-list>${turn("old", "Earlier turn", "09:00")}${turn("latest", "Latest turn", "10:00", true, child)}</div></div></details>`;
    await page.route("**/api/journal?**", route => route.fulfill({ json: { html, version: "claude-disclosures", updatedAt: "2026-11-10T10:00:00Z" } }));
    await page.locator('[data-view-button="journal"]').click();
    const latest = page.locator('[data-work-log-turn-id="latest"] > details');
    const earlier = page.locator('[data-work-log-turn-id="old"] > details');
    await latest.waitFor({ state: "visible" });
    assert.equal(await latest.evaluate(node => node.open), true);
    assert.equal(await earlier.evaluate(node => node.open), false);
    assert.equal(await latest.locator("p").first().isVisible(), true);
    assert.equal(await earlier.locator("p").isVisible(), false);
    await earlier.locator("summary").click();
    assert.equal(await earlier.locator("p").isVisible(), true);
    const worker = latest.locator("[data-work-log-turn-children-details]").first();
    assert.equal(await worker.evaluate(node => node.open), false);
    await worker.locator(":scope > summary").focus();
    await worker.locator(":scope > summary").press("Enter");
    assert.equal(await worker.locator("p").first().isVisible(), true);
    const grandchild = worker.locator("[data-work-log-turn-children-details]");
    assert.equal(await grandchild.evaluate(node => node.open), false);
    await grandchild.locator(":scope > summary").focus();
    await grandchild.locator(":scope > summary").press("Enter");
    assert.equal(await grandchild.locator("p").isVisible(), true);
    await page.locator("[data-collapse-all]").click();
    assert.equal(await earlier.evaluate(node => node.open), false);
    assert.equal(await worker.evaluate(node => node.open), false);
    assert.equal(await grandchild.evaluate(node => node.open), false);
  }, { beforeOpen: page => page.addInitScript(() => {
    localStorage.setItem("agent-hub-grouping", "date");
    localStorage.setItem("agent-hub-group-claude", "on");
  }) });
});


test("compact layout follows the rendered document viewport even when the host reports another width", { timeout: 30_000 }, async () => {
  for (const { width, expected } of [{ width: 390, expected: "mobile" }, { width: 920, expected: "desktop" }]) {
    await withSurface(async page => {
      assert.deepEqual(await page.evaluate(() => ({ document: document.documentElement.clientWidth, host: window.innerWidth,
        surface: document.documentElement.dataset.surface })), { document: width, host: 545, surface: expected });
      assert.equal(await page.locator("[data-composer-input]").isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    }, { width, beforeOpen: page => page.addInitScript(() => Object.defineProperty(window, "innerWidth", { value: 545 })) });
  }
});


test("Telegram mobile host expands the conversation and disables its vertical collapse gesture", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    assert.deepEqual(await page.evaluate(() => window.__hostCalls.filter(name => ["expand", "disableVerticalSwipes"].includes(name))),
      ["expand", "disableVerticalSwipes"]);
    assert.equal(await page.locator("[data-composer-input]").isVisible(), true);
  }, { mobile: true, beforeOpen: page => page.addInitScript(() => {
    window.__hostCalls = [];
    window.Telegram = { WebApp: { initData: "synthetic-test-session", platform: "android", colorScheme: "dark",
      expand: () => window.__hostCalls.push("expand"),
      disableVerticalSwipes: () => window.__hostCalls.push("disableVerticalSwipes"), onEvent() {}, ready() {} } };
  }) });
});

test("mobile journal task links keep link ownership without a second expansion action", { timeout: 30_000 }, async () => {
  await withSurface(async page => {
    const html = '<details data-work-log-day-section open><summary data-work-log-day><strong>10.11.2026</strong></summary>'
      + '<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="thread-a" data-work-log-workspace-id="workspace-1" data-work-log-stream-id="stream-a">'
      + '<span data-work-log-task-content role="button" tabindex="0" aria-expanded="false"><a href="#/chat/codex/thread-a" data-open-task="thread-a">Exact linked Stream</a></span>'
      + '<div data-work-log-turn-entry data-work-log-turn-provider="codex" data-work-log-turn-thread-id="thread-a" data-work-log-turn-id="journal-turn" data-work-log-turn-depth="0">'
      + '<details data-work-log-turn-details><summary>Journal turn</summary><p>Journal body</p></details></div></div></details>';
    await page.route("**/api/journal?**", route => route.fulfill({ json: { html, version: "mobile-link", updatedAt: "2026-11-10T10:00:00Z" } }));
    await page.locator('[data-view-button="journal"]').evaluate(button => button.click());
    const link = page.locator('[data-journal] [data-open-task="thread-a"]').first();
    await link.waitFor({ state: "visible" });
    const owner = link.locator('xpath=..');
    assert.equal(await owner.getAttribute("role"), null);
    assert.equal(await owner.getAttribute("tabindex"), null);
    assert.equal(await owner.getAttribute("aria-expanded"), null);
    const before = await page.locator("[data-journal] details[open]").count();
    await link.click();
    assert.equal(await page.locator("[data-journal] details[open]").count(), before);
    assert.equal(await page.locator("[data-journal] [data-mobile-open]").count(), 0);
  }, { mobile: true, beforeOpen: page => page.addInitScript(() => localStorage.setItem("agent-hub-grouping", "date")) });
});
