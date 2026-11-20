import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { launchBrowser, snapshot } from "./composer-production.fixture.mjs";
import { openClientEventFixture } from "./client-event.fixture.mjs";

for (const width of [1366, 390]) test(`GitHub connection controls preserve secret-free page state at ${width}px`, { timeout: 45_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 600 });
    const initialSnapshot = snapshot();
    initialSnapshot.server.githubAccount = { status: "disconnected", account: null };
    const errors = await openClientEventFixture(page, { fixtureSnapshot: initialSnapshot });
    await page.evaluate(() => {
      const bridge = window.__fixtureBridge;
      const send = bridge.postMessage.bind(bridge);
      window.__githubActions = [];
      bridge.postMessage = message => {
        if (!["connect-github-account", "disconnect-github-account", "poll-github-account-login", "cancel-github-account-login"].includes(message.action)) return send(message);
        window.__githubActions.push({ action: message.action, tokenPresent: Boolean(message.params.token) });
        let githubAccount = window.__agentHubFixture.snapshot.server.githubAccount;
        let login;
        if (message.action === "connect-github-account") {
          login = { attemptId: "device-fixture", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 900000, waitMs: 25 };
        } else if (message.action === "poll-github-account-login") {
          login = window.__githubAllow ? { status: "connected" } : { status: "pending", waitMs: 25 };
          if (window.__githubAllow) githubAccount = { status: "connected", account: { id: 22, login: "hub-user", name: "Hub User", email: "hub-user@example.invalid" } };
        } else if (message.action === "disconnect-github-account") githubAccount = { status: "disconnected", account: null };
        window.__agentHubFixture.snapshot.server.githubAccount = githubAccount;
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: message.id, ok: true, result: { githubAccount, login },
        } }));
      };
    });
    const navigation = width < 600 ? '[data-mobile-button="server"]' : '[data-view-button="server"]';
    await page.locator(navigation).click();
    const panel = page.locator("[data-github-account]");
    await panel.getByText("Не подключён", { exact: true }).waitFor();
    assert.equal(await panel.locator('input').count(), 0);
    const help = panel.getByLabel("О подключении GitHub", { exact: true });
    const tooltip = panel.getByRole("tooltip");
    assert.equal(await tooltip.isVisible(), false);
    await help.hover();
    await tooltip.waitFor({ state: "visible" });
    assert.equal(await tooltip.textContent(), "Общий Git-профиль Hub и агентов. Вход по одноразовому коду.");
    await page.mouse.move(1, 1);
    await help.focus();
    await help.press("Enter");
    assert.equal(await panel.locator("details").evaluate(node => node.open), true);
    await help.press("Escape");
    await panel.locator("details").evaluate(node => { node.open = false; });
    await page.mouse.move(1, 1);
    if (width < 600) {
      await help.tap();
      await tooltip.waitFor({ state: "visible" });
      await help.tap();
    }
    await panel.getByRole("button", { name: "Войти", exact: true }).click();
    await panel.getByLabel("Код входа GitHub").waitFor({ state: "visible" });
    assert.equal(await panel.getByLabel("Код входа GitHub").textContent(), "ABCD-EFGH");
    assert.equal(await panel.getByRole("link", { name: "Открыть GitHub" }).getAttribute("href"), "https://github.com/login/device");
    await page.evaluate(() => window.AgentHub.setServerStatus(window.__agentHubFixture.snapshot.server));
    assert.equal(await panel.getByLabel("Код входа GitHub").textContent(), "ABCD-EFGH");
    if (process.env.AGENT_HUB_TEST_SCREENSHOTS) {
      await mkdir(process.env.AGENT_HUB_TEST_SCREENSHOTS, { recursive: true });
      await panel.screenshot({ path: path.join(process.env.AGENT_HUB_TEST_SCREENSHOTS, `github-device-${width}.png`) });
    }
    await page.evaluate(() => { window.__githubAllow = true; });
    await panel.getByText("Подключён", { exact: true }).waitFor();
    assert.equal(await panel.locator(".github-device-login").isVisible(), false);
    assert.equal((await panel.textContent()).includes("Hub User <hub-user@example.invalid>"), true);
    await page.evaluate(() => {
      window.__githubAllow = false;
      const state = { status: "expired", account: window.__agentHubFixture.snapshot.server.githubAccount.account };
      window.AgentHub.setGitHubAccount(state);
    });
    await panel.getByText("Авторизация истекла — войди через GitHub снова", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Войти", exact: true }).click();
    await panel.getByRole("button", { name: "Отменить вход" }).click();
    await panel.getByRole("button", { name: "Войти", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Войти", exact: true }).click();
    await page.evaluate(() => { window.__githubAllow = true; });
    await panel.getByText("Подключён", { exact: true }).waitFor();
    if (process.env.AGENT_HUB_TEST_SCREENSHOTS) {
      await mkdir(process.env.AGENT_HUB_TEST_SCREENSHOTS, { recursive: true });
      await panel.screenshot({ path: path.join(process.env.AGENT_HUB_TEST_SCREENSHOTS, `github-${width}.png`) });
    }
    await panel.getByRole("button", { name: "Отключить", exact: true }).click();
    await panel.getByText("Не подключён", { exact: true }).waitFor();
    const state = await page.evaluate(() => ({ text: document.body.innerText,
      storage: JSON.stringify({ ...localStorage, ...sessionStorage }), actions: window.__githubActions,
      overflow: document.documentElement.scrollWidth > innerWidth }));
    assert.equal(state.text.includes("Personal access token"), false);
    assert.equal(state.storage.includes("ABCD-EFGH"), false);
    assert.deepEqual(state.actions.filter(value => value.action !== "poll-github-account-login").map(value => value.action), ["connect-github-account", "connect-github-account", "cancel-github-account-login", "connect-github-account", "disconnect-github-account"]);
    assert.equal(state.actions.some(value => value.tokenPresent), false);
    assert.equal(state.overflow, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("late response from a cancelled OAuth attempt cannot replace the next connected account", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const initialSnapshot = snapshot();
    initialSnapshot.server.githubAccount = { status: "disconnected", account: null };
    const errors = await openClientEventFixture(page, { fixtureSnapshot: initialSnapshot });
    await page.evaluate(() => {
      const bridge = window.__fixtureBridge, send = bridge.postMessage.bind(bridge);
      let attempt = 0;
      const reply = (message, result) => window.dispatchEvent(new MessageEvent("message", { data: {
        type: "agenthub:control-result", id: message.id, ok: true, result,
      } }));
      const account = login => ({ status: "connected", account: { id: login === "new-user" ? 22 : 11, login, name: login, email: `${login}@example.invalid` } });
      bridge.postMessage = message => {
        if (!/github-account/u.test(message.action)) return send(message);
        if (message.action === "connect-github-account") return reply(message, {
          githubAccount: { status: "disconnected", account: null },
          login: { attemptId: `attempt-${++attempt}`, userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", waitMs: 10 },
        });
        if (message.action === "cancel-github-account-login") return reply(message, { githubAccount: { status: "disconnected", account: null } });
        if (message.action === "poll-github-account-login") {
          if (message.params.attemptId === "attempt-1") {
            window.__releaseOldGithubPoll = () => reply(message, { githubAccount: account("old-user"), login: { status: "connected" } });
          } else {
            window.__agentHubFixture.snapshot.server.githubAccount = account("new-user");
            reply(message, { githubAccount: account("new-user"), login: { status: "connected" } });
          }
        }
      };
    });
    await page.locator('[data-mobile-button="server"]').click();
    const panel = page.locator("[data-github-account]");
    await panel.getByRole("button", { name: "Войти", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__releaseOldGithubPoll));
    await panel.getByRole("button", { name: "Отменить вход" }).click();
    await panel.getByRole("button", { name: "Войти", exact: true }).click();
    await panel.getByText("new-user · new-user <new-user@example.invalid>", { exact: true }).waitFor();
    await page.evaluate(async () => { window.__releaseOldGithubPoll(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await panel.getByText("new-user · new-user <new-user@example.invalid>", { exact: true }).isVisible(), true);
    assert.equal((await panel.innerText()).includes("old-user"), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("remote browser cannot collect or relay a GitHub token, including forged client intents", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const fixtureSnapshot = snapshot();
    fixtureSnapshot.server.githubAccount = { status: "disconnected", account: null };
    const errors = await openClientEventFixture(page, { fixtureSnapshot, surface: "web" });
    assert.equal(await page.locator('[data-mobile-button="server"]').isVisible(), false);
    const panel = page.locator("[data-github-account]");
    const signIn = panel.getByRole("button", { name: "Войти", exact: true, includeHidden: true });
    await signIn.waitFor({ state: "attached" });
    assert.equal(await signIn.isDisabled(), true);
    assert.equal(await panel.getByText("Для подключения откройте Hub на этом компьютере.", { exact: true }).count(), 0);
    assert.equal(await panel.locator("input").count(), 0);
    await page.evaluate(async () => {
      // Even a forged presentation flag cannot replace actual local auth.
      window.AgentHub.setGitHubLocalAccess(true);
      await window.__dispatchClientFixture("server:github-connect", { token: "github_pat_SYNTHETIC_REMOTE_123456789" });
    });
    await panel.getByText("Подключение GitHub доступно только локально на компьютере Hub", { exact: true }).waitFor({ state: "attached" });
    const state = await page.evaluate(() => ({
      githubCalls: window.__agentHubFixture.log.filter(value => /github-account/u.test(value.action)),
      storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
    }));
    assert.deepEqual(state.githubCalls, []);
    assert.equal(state.storage.includes("github_pat_SYNTHETIC_REMOTE_123456789"), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
