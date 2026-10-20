import assert from "node:assert/strict";
import test from "node:test";

import {
  launchBrowser,
  openFixture,
  snapshot,
  bridgeCalls,
} from "./composer-production.fixture.mjs";

async function openKeyboardPage(browser, { running = false, mobile = false } = {}) {
  const page = await browser.newPage(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 } });
  const fixtureSnapshot = snapshot();
  fixtureSnapshot.version = `keyboard-${running ? "running" : "idle"}-${mobile ? "mobile" : "desktop"}`;
  fixtureSnapshot.tasks[0].running = running;
  fixtureSnapshot.tasks[0].run = running ? {
    turnId: "keyboard-active-turn", operationKind: "user-turn", projectionState: "active", model: "gpt-test",
  } : null;
  const diagnostics = await openFixture(page, { fixtureSnapshot });
  if (mobile) await page.locator('[data-mobile-button="chat"]').click();
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
