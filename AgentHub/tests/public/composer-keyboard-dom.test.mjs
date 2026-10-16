import assert from "node:assert/strict";
import test from "node:test";

import {
  launchBrowser,
  openFixture,
  snapshot,
  bridgeCalls,
} from "./composer-production.fixture.mjs";

async function openKeyboardPage(browser, { running = false, mobile = false, mapping = null } = {}) {
  const page = await browser.newPage(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 } });
  const fixtureSnapshot = snapshot();
  if (mapping) await page.addInitScript((mapping) => localStorage.setItem("agent-hub:composer-shortcuts:v1", JSON.stringify(mapping)), mapping);
  fixtureSnapshot.version = `keyboard-${running ? "running" : "idle"}-${mobile ? "mobile" : "desktop"}`;
  fixtureSnapshot.tasks[0].running = running;
  fixtureSnapshot.tasks[0].run = running ? {
    turnId: "keyboard-active-turn", operationKind: "user-turn", projectionState: "active", model: "gpt-test",
  } : null;
  const diagnostics = await openFixture(page, { fixtureSnapshot });
  if (mobile) {
    const dialogs = await page.locator("html").getAttribute("data-mobile-dialogs-enabled") !== null;
    if (dialogs) {
      await page.locator('[data-mobile-dialogs-tab="chat"]').click();
      await page.locator('[data-mobile-stream-list] [data-mobile-stream-id="stream-a"]').first().click();
    } else await page.locator('[data-mobile-button="chat"]').click();
  }
  assert.equal(new URL(page.url()).host, "agent-hub.test");
  assert.equal(await page.title(), "Agent Hub");
  assert.equal(await page.locator("[data-composer-input]").isVisible(), true);
  assert.equal(await page.locator("vite-error-overlay, nextjs-portal").count(), 0);
  assert.deepEqual(diagnostics, []);
  await page.evaluate(() => {
    window.__keyboardIntents = [];
    document.addEventListener("agenthub:intent", (event) => {
      window.__keyboardIntents.push(structuredClone(event.detail));
    });
  });
  return page;
}

test("production left-edge Back saves composer and shortcut dirty-close owns only the top settings layer", async () => {
  const browser = await launchBrowser();
  try {
    for (const surface of [
      { name: "Web", width: 1280, surface: "web" },
      { name: "WebView", width: 520, surface: "vscode" },
      { name: "Mobile", width: 390, surface: "web", mobile: true },
    ]) {
      const page = await browser.newPage({ viewport: { width: surface.width, height: 844 },
        ...(surface.mobile ? { isMobile: true, hasTouch: true } : {}) });
      await openFixture(page, { surface: surface.surface });
      if (surface.mobile) await page.locator('[data-mobile-dialogs-tab="chat"]').click();
      await page.evaluate(() => window.AgentHub.showSelectedTask());
      const input = page.locator("[data-composer-input]");
      await input.fill("Draft retained by left-edge Back");
      const url = page.url();
      const moveConsumed = await page.evaluate(() => {
        const target = document.querySelector("[data-chat-pane]");
        const dispatch = (type, x) => {
          const touch = new Touch({ identifier: 1, target, clientX: x, clientY: 300 });
          const event = new TouchEvent(type, { bubbles: true, cancelable: true,
            touches: type === "touchend" ? [] : [touch], changedTouches: [touch] });
          target.dispatchEvent(event); return event.defaultPrevented;
        };
        dispatch("touchstart", 8); const consumed = dispatch("touchmove", 82); dispatch("touchend", 96); return consumed;
      });
      assert.equal(moveConsumed, true, surface.name);
      assert.equal(page.url(), url);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.pane), "tasks");
      const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `agent-hub:composer-drafts:v1:${surface.surface}`);
      assert.equal(stored.find((draft) => draft.taskId === "stream-a").text, "Draft retained by left-edge Back");
      assert.equal(await input.inputValue(), "Draft retained by left-edge Back");
      if (surface.mobile) await page.locator(".mobile-dialogs-top").getByRole("button", { name: "Настройки AgentHub", exact: true }).click();
      else await page.locator('[data-panel-open="settings"]').click();
      await page.locator("[data-composer-shortcuts-open]").click();
      await page.getByLabel("Действие для Control + Enter", { exact: true }).selectOption("steer");
      const pane = await page.evaluate(() => document.documentElement.dataset.pane);
      assert.equal(await page.evaluate(() => window.AgentHub.navigateBack()), true);
      assert.equal(await page.locator("[data-composer-shortcuts-discard]").evaluate((dialog) => dialog.open), true);
      assert.equal(await page.locator("[data-composer-shortcuts-dialog]").evaluate((dialog) => dialog.open), true);
      assert.equal(await page.evaluate(() => window.AgentHub.navigateBack()), true);
      assert.equal(await page.locator("[data-composer-shortcuts-discard]").evaluate((dialog) => dialog.open), false);
      assert.equal(await page.locator("[data-composer-shortcuts-dialog]").evaluate((dialog) => dialog.open), true);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.pane), pane);
      assert.equal(await input.inputValue(), "Draft retained by left-edge Back");
      assert.equal((await bridgeCalls(page, "send-message")).length, 0);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("opt-in queue/newline mappings preserve slash precedence, repeat and IME ownership", async () => {
  const browser = await launchBrowser();
  try {
    for (const chord of ["Control+Enter", "Shift+Enter"]) {
      const page = await openKeyboardPage(browser, { mapping: { enter: "newline", ctrlEnter: "queue", shiftEnter: "queue" } });
      const input = page.locator("[data-composer-input]");
      await input.fill("/status");
      await input.dispatchEvent("keydown", { key: "Enter", ctrlKey: chord === "Control+Enter", shiftKey: chord === "Shift+Enter", repeat: true });
      assert.equal((await sends(page)).length, 0);
      for (const guard of [{ isComposing: true }, { keyCode: 229 }]) {
        const untouched = await input.evaluate((node, guard) => {
          const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true, ...guard });
          node.dispatchEvent(event); return !event.defaultPrevented;
        }, guard);
        assert.equal(untouched, true); assert.equal((await sends(page)).length, 0);
      }
      await input.press(chord);
      assert.equal((await sends(page)).length, 1);
      assert.equal((await sends(page))[0].followUpMode, "queue");
      assert.equal(await page.evaluate(() => window.__keyboardIntents.filter((i) => i.type === "status:open").length), 0);
      await page.close();
    }
    const page = await openKeyboardPage(browser, { mapping: { enter: "newline", ctrlEnter: "newline", shiftEnter: "newline" } });
    const input = page.locator("[data-composer-input]");
    await input.fill("AB"); await input.press("Enter");
    assert.equal(await input.inputValue(), "AB\n"); assert.deepEqual(await sends(page), []);
    await input.fill("/status"); await input.press("Enter");
    assert.equal(await page.evaluate(() => window.__keyboardIntents.filter((i) => i.type === "status:open").length), 1);
  } finally { await browser.close(); }
});

test("mobile bare Enter stays native newline even with a saved queue action and physical-looking code", async () => {
  const browser = await launchBrowser();
  try {
    const page = await openKeyboardPage(browser, { mobile: true, mapping: { enter: "queue", ctrlEnter: "queue", shiftEnter: "queue" } });
    const input = page.locator("[data-composer-input]");
    await input.fill("Mobile");
    for (const code of ["", "Enter"]) {
      assert.equal(await input.evaluate((node, code) => {
        const event = new KeyboardEvent("keydown", { key: "Enter", code, bubbles: true, cancelable: true });
        node.dispatchEvent(event); return !event.defaultPrevented;
      }, code), true);
    }
    await input.press("Enter"); assert.equal(await input.inputValue(), "Mobile\n");
    assert.deepEqual(await sends(page), []);
    await input.press("Control+Enter"); assert.equal((await sends(page)).length, 1);
    assert.equal((await sends(page))[0].followUpMode, "queue");
  } finally { await browser.close(); }
});

test("shortcut queue/steer reuse ordinary send-message for both providers on Web, WebView IPC/direct and mobile", async () => {
  const browser = await launchBrowser();
  try {
    for (const surface of [
      { name: "Web", surface: "web", width: 1280 },
      { name: "WebView IPC", surface: "vscode", width: 520 },
      { name: "WebView direct", surface: "vscode", width: 520, directTransport: true },
      { name: "Mobile", surface: "web", width: 390, mobile: true },
    ]) for (const provider of ["codex", "claude"]) {
      const page = await browser.newPage({ viewport: { width: surface.width, height: 844 },
        ...(surface.mobile ? { isMobile: true, hasTouch: true } : {}) });
      page.setDefaultTimeout(5_000);
      await page.addInitScript(() => {
        localStorage.setItem("agent-hub:composer-shortcuts:v1", JSON.stringify({ enter: "steer", ctrlEnter: "queue", shiftEnter: "steer" }));
        localStorage.setItem("fixture:send-mode", "accept");
      });
      const initial = snapshot();
      initial.tasks[0].provider = provider; initial.selected.provider = provider; initial.settings.provider = provider;
      // An idle source still sends the existing steer intent; server fallback owns its outcome.
      initial.tasks[0].running = false;
      const diagnostics = await openFixture(page, { fixtureSnapshot: initial,
        surface: surface.surface, directTransport: Boolean(surface.directTransport) });
      if (surface.mobile) await page.locator('[data-mobile-dialogs-tab="chat"]').click();
      await page.evaluate(() => window.AgentHub.showSelectedTask());
      const input = page.locator("[data-composer-input]");
      let count = 0;
      for (const [chord, mode] of [["Enter", surface.mobile ? null : "steer"], ["Control+Enter", "queue"], ["Shift+Enter", "steer"]]) {
        const text = `${surface.name} ${provider} ${chord}`;
        await input.fill(text);
        await page.locator("[data-composer-send]").waitFor({ state: "visible" });
        await page.waitForFunction(() => !document.querySelector("[data-composer-send]").disabled, null, { timeout: 5_000 })
          .catch(async (error) => { throw new Error(`${surface.name} ${provider} ${chord}: send disabled; ${JSON.stringify(await bridgeCalls(page, "send-message"))}; ${error.message}`); });
        await input.press(chord);
        if (!mode) {
          assert.equal(await input.inputValue(), text + "\n");
          assert.equal((await bridgeCalls(page, "send-message")).length, count);
          continue;
        }
        count++;
        await page.waitForFunction((count) => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
          .filter((entry) => entry.action === "send-message").length === count, count, { timeout: 5_000 });
        const request = (await bridgeCalls(page, "send-message")).at(-1);
        assert.equal(request.params.followUpMode, mode, `${surface.name} ${provider} ${chord}`);
        assert.equal(request.params.provider, provider);
        assert.equal(request.params.text, text);
        assert.equal(request.transport ?? "ipc", surface.surface === "web" || surface.directTransport ? "http" : "ipc");
        assert.equal(Object.hasOwn(request.params, "exactSteer"), false);
        assert.equal(Object.hasOwn(request.params, "exactTarget"), false);
        assert.equal(await input.inputValue(), "");
      }
      assert.equal((await bridgeCalls(page, "send-message")).length, count);
      assert.deepEqual(diagnostics, []);
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.close();
    }
  } finally { await browser.close(); }
});

async function sends(page) {
  return page.evaluate(() => window.__keyboardIntents.filter((intent) => intent.type === "message:send"));
}

async function addQuote(page) {
  return page.evaluate(async () => {
    window.AgentHub.setMessages("stream-a", [{
      id: "keyboard-message",
      itemId: "keyboard-item",
      turnId: "keyboard-turn",
      threadId: "thread-a",
      provider: "codex",
      role: "agent",
      author: "Codex",
      text: "Quoted source text",
      time: "08:00",
    }]);
    const body = [...document.querySelectorAll(".msg-body")]
      .find((node) => node.textContent.includes("Quoted source text"));
    if (!body) return false;
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return window.AgentHub.addSelectedAnnotation();
  });
}

test("shipped composer inserts Ctrl/Shift newlines at the selection and persists the draft", async () => {
  const browser = await launchBrowser();
  try {
    const page = await openKeyboardPage(browser);
    const composer = page.locator("[data-composer-input]");
    assert.ok((await page.screenshot()).length > 1_000);
    await composer.fill("AB");
    await composer.evaluate((input) => input.setSelectionRange(1, 1));
    await composer.press("Control+Enter");
    assert.equal(await composer.inputValue(), "A\nB");
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [2, 2]);
    await composer.press("Shift+Enter");
    assert.equal(await composer.inputValue(), "A\n\nB");
    await composer.evaluate((input) => input.setSelectionRange(1, 3));
    await composer.press("Control+Enter");
    assert.equal(await composer.inputValue(), "A\nB");
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [2, 2]);
    assert.deepEqual(await sends(page), []);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "A\nB");
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "A\nB");
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
  } finally {
    await browser.close();
  }
});

test("shipped composer keeps Enter, Meta+Enter and send-button queue behavior", async () => {
  const browser = await launchBrowser();
  try {
    for (const { running, action, followUpMode, deferWhileRunning } of [
      { running: false, action: "Enter", followUpMode: "queue", deferWhileRunning: false },
      { running: true, action: "Enter", followUpMode: "queue", deferWhileRunning: true },
      { running: true, action: "Meta+Enter", followUpMode: "steer", deferWhileRunning: false },
      { running: true, action: "button", followUpMode: "queue", deferWhileRunning: true },
    ]) {
      const page = await openKeyboardPage(browser, { running });
      const composer = page.locator("[data-composer-input]");
      await composer.fill("Unsent");
      await composer.press("Control+Enter");
      assert.equal(await composer.inputValue(), "Unsent\n");
      assert.deepEqual(await sends(page), []);
      await composer.fill("Send this");
      if (action === "button") await page.locator("[data-composer-send]").click();
      else await composer.press(action);
      const emitted = await sends(page);
      assert.equal(emitted.length, 1, `${action} / running=${running}`);
      assert.equal(emitted[0].text, "Send this");
      assert.equal(emitted[0].followUpMode, followUpMode);
      assert.equal(emitted[0].deferWhileRunning, deferWhileRunning);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("shipped slash menu ignores Ctrl+Enter and IME, then accepts ordinary Enter", async () => {
  const browser = await launchBrowser();
  try {
    const page = await openKeyboardPage(browser);
    const composer = page.locator("[data-composer-input]");
    const menu = page.locator("[data-slash-menu]");
    await composer.fill("/status");
    assert.equal(await menu.isVisible(), true);
    await composer.press("Control+Enter");
    assert.equal(await composer.inputValue(), "/status\n");
    assert.deepEqual(await sends(page), []);
    assert.equal(await page.evaluate(() => window.__keyboardIntents.some((item) => item.type === "status:open")), false);
    await composer.fill("/status");
    await composer.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    assert.equal(await composer.inputValue(), "/status");
    assert.equal(await menu.isVisible(), true);
    await composer.press("Shift+Enter");
    assert.equal(await composer.inputValue(), "/status\n");
    assert.equal(await page.evaluate(() => window.__keyboardIntents.some((item) => item.type === "status:open")), false);
    await composer.fill("/status");
    await composer.press("Enter");
    assert.equal(await composer.inputValue(), "");
    assert.equal(await page.evaluate(() => window.__keyboardIntents.filter((item) => item.type === "status:open").length), 1);
    assert.deepEqual(await sends(page), []);
  } finally {
    await browser.close();
  }
});

test("shipped quote comments insert newlines without sending and preserve Enter/Meta+Enter", async () => {
  const browser = await launchBrowser();
  try {
    for (const { running, action, expectedMode } of [
      { running: false, action: "Enter", expectedMode: "queue" },
      { running: true, action: "Meta+Enter", expectedMode: "steer" },
    ]) {
      const page = await openKeyboardPage(browser, { running });
      assert.equal(await addQuote(page), true);
      const comment = page.locator("[data-annotation-comment-index='0']");
      await page.locator("[data-composer-input]").fill("Composer body");
      await comment.fill("AB");
      await comment.evaluate((input) => input.setSelectionRange(1, 1));
      await comment.press("Control+Enter");
      assert.equal(await comment.inputValue(), "A\nB");
      await comment.press("Shift+Enter");
      assert.equal(await comment.inputValue(), "A\n\nB");
      await comment.evaluate((input) => input.setSelectionRange(1, 3));
      await comment.press("Control+Enter");
      assert.equal(await comment.inputValue(), "A\nB");
      assert.deepEqual(await comment.evaluate((input) => [input.selectionStart, input.selectionEnd]), [2, 2]);
      await comment.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, repeat: true });
      await comment.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      assert.equal(await comment.inputValue(), "A\nB");
      assert.deepEqual(await sends(page), []);
      await comment.press(action);
      const emitted = await sends(page);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].text, "Composer body");
      assert.equal(emitted[0].annotations[0].annotation, "A\nB");
      assert.equal(emitted[0].followUpMode, expectedMode);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("mobile Enter remains a newline and the visible send button still submits", async () => {
  const browser = await launchBrowser();
  try {
    const page = await openKeyboardPage(browser, { mobile: true });
    const composer = page.locator("[data-composer-input]");
    assert.equal(await page.locator("html").getAttribute("data-surface"), "mobile");
    await composer.fill("Mobile");
    await composer.press("Enter");
    assert.equal(await composer.inputValue(), "Mobile\n");
    await composer.press("Control+Enter");
    assert.equal(await composer.inputValue(), "Mobile\n\n");
    assert.deepEqual(await sends(page), []);
    await page.locator("[data-composer-send]").click();
    assert.equal((await sends(page)).length, 1);
  } finally {
    await browser.close();
  }
});
