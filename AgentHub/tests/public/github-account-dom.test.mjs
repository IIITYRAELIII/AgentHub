import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { launchBrowser, snapshot } from "./composer-production.fixture.mjs";
import { openClientEventFixture } from "./client-event.fixture.mjs";

for (const width of [1366, 390]) test(`GitHub connection controls preserve secret-free page state at ${width}px`, { timeout: 45_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const initialSnapshot = snapshot();
    initialSnapshot.server.githubAccount = { status: "disconnected", account: null };
    const errors = await openClientEventFixture(page, { fixtureSnapshot: initialSnapshot });
    await page.evaluate(() => {
      const bridge = window.__fixtureBridge;
      const send = bridge.postMessage.bind(bridge);
      window.__githubActions = [];
      bridge.postMessage = message => {
        if (!["connect-github-account", "disconnect-github-account"].includes(message.action)) return send(message);
        // This transport fixture deliberately never retains the token-bearing
        // request in its ordinary localStorage command log.
        window.__githubActions.push({ action: message.action, tokenPresent: Boolean(message.params.token) });
        const githubAccount = message.action === "connect-github-account"
          ? { status: "connected", account: { id: 22, login: "hub-user", name: "Hub User", email: "hub-user@example.invalid" } }
          : { status: "disconnected", account: null };
        window.__agentHubFixture.snapshot.server.githubAccount = githubAccount;
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: message.id, ok: true, result: { githubAccount },
        } }));
      };
    });
    const navigation = width < 600 ? '[data-mobile-button="server"]' : '[data-view-button="server"]';
    await page.locator(navigation).click();
    const panel = page.locator("[data-github-account]");
    await panel.getByText("Не подключён", { exact: true }).waitFor();
    const token = "github_pat_SYNTHETIC_DOM_VALUE_123456";
    const input = panel.getByLabel("GitHub personal access token");
    await input.fill(token);
    // Ordinary snapshot refresh must preserve the unsent local field.
    await page.evaluate(() => window.AgentHub.setServerStatus(window.__agentHubFixture.snapshot.server));
    assert.equal(await input.inputValue(), token);
    await panel.getByRole("button", { name: "Подключить", exact: true }).click();
    await panel.getByText("Подключён", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "");
    assert.equal((await panel.textContent()).includes("Hub User <hub-user@example.invalid>"), true);
    await page.evaluate(() => {
      const state = { status: "expired", account: window.__agentHubFixture.snapshot.server.githubAccount.account };
      window.AgentHub.setGitHubAccount(state);
    });
    await panel.getByText("Авторизация истекла — переподключите аккаунт", { exact: true }).waitFor();
    await input.fill(token);
    await panel.getByRole("button", { name: "Переподключить", exact: true }).click();
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
    assert.equal(state.text.includes(token), false);
    assert.equal(state.storage.includes(token), false);
    assert.deepEqual(state.actions.map(value => value.action), ["connect-github-account", "connect-github-account", "disconnect-github-account"]);
    assert.equal(state.overflow, false);
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
    await panel.getByText("Для подключения откройте Hub на этом компьютере.", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await panel.getByRole("button", { name: "Подключить", exact: true, includeHidden: true }).isDisabled(), true);
    assert.equal(await panel.getByLabel("GitHub personal access token").isDisabled(), true);
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
