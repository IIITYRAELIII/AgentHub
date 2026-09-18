import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const WEB_APP = new URL("../../assets/web-app/", import.meta.url);
const app = await readFile(new URL("app.js", WEB_APP), "utf8");
const hubClient = await readFile(new URL("hub-client.js", WEB_APP), "utf8");
const index = await readFile(new URL("index.html", WEB_APP), "utf8");

async function panelApi() {
  const source = await readFile(new URL("provider-login-panel.js", WEB_APP), "utf8");
  const window = {};
  vm.runInNewContext(source, { Boolean, JSON, Object, String, window });
  return window.AgentHubProviderLoginPanel;
}

const CODE = "Kc0de-AbC_123#sTaTe-456_xyz";

test("current account replaces attempt history and account switches change the render key", async () => {
  const panel = await panelApi();
  const account = { provider: "codex", status: "idle", currentAccount: { state: "signed-in", email: "one@example.test", method: "chatgpt" } };
  assert.equal(panel.accountView(account).statusText, "one@example.test");
  assert.equal(panel.accountView(account).loginStatusText, null);
  const changed = { ...account, currentAccount: { ...account.currentAccount, email: "two@example.test" } };
  assert.notEqual(panel.renderKey([panel.accountView(account)]), panel.renderKey([panel.accountView(changed)]));
  assert.equal(panel.accountView({ ...account, status: "pending" }).loginStatusText, "Ожидает входа в браузере");
  assert.equal(panel.accountView({ ...account, currentAccount: { state: "signed-out" } }).statusText, "Не выполнен вход");
  assert.equal(panel.accountView({ ...account, currentAccount: { state: "signed-in", method: "apiKey" } }).statusText, "API-ключ");
  assert.equal(panel.accountView({ ...account, currentAccount: { state: "checking" } }).statusText, "Проверяем аккаунт…");
});

test("the sign-in link and code field belong only to the local client of the same attempt", async () => {
  const panel = await panelApi();
  const pending = { provider: "claude", status: "pending", attemptId: "7", error: null };
  const local = { attemptId: "7", authUrl: "https://claude.com/cai/oauth/authorize?x=1" };

  const own = panel.accountView(pending, local);
  assert.equal(own.authUrl, local.authUrl);
  assert.equal(own.acceptsCode, true);
  assert.equal(own.canCancel, true);
  assert.equal(own.startText, "Войти заново");

  for (const foreign of [null, {}, { attemptId: "6", authUrl: local.authUrl }]) {
    const view = panel.accountView(pending, foreign);
    assert.equal(view.authUrl, null, "a client that did not start this attempt gets no link");
    assert.equal(view.acceptsCode, false);
  }
  assert.equal(panel.accountView({ ...pending, provider: "codex" }, local).acceptsCode, false, "Codex has no manual code");
  assert.equal(panel.accountView({ ...pending, status: "succeeded" }, local).authUrl, null);
  assert.equal(panel.accountView(pending, { attemptId: "7", authUrl: "http://insecure" }).authUrl, null);
});

test("a start response bound against a prior idle snapshot keeps the link and code field for the new pending attempt", async () => {
  const panel = await panelApi();
  // Mirrors renderServerAccounts: drop local state only when retainLocal says so.
  let local = null;
  const render = (account) => {
    if (!panel.retainLocal(account, local)) local = null;
    return panel.accountView(account, local);
  };
  const claudeUrl = "https://claude.com/cai/oauth/authorize?x=1";

  render({ provider: "claude", status: "idle", attemptId: null });
  local = { attemptId: "5", authUrl: claudeUrl };
  const stale = render({ provider: "claude", status: "cancelled", attemptId: "4" });
  assert.notEqual(local, null, "a snapshot taken before the start must not drop the new attempt");
  assert.equal(stale.acceptsCode, false);
  const idleAgain = render({ provider: "claude", status: "idle", attemptId: null });
  assert.notEqual(local, null);
  assert.equal(idleAgain.authUrl, null);

  const pending = render({ provider: "claude", status: "pending", attemptId: "5" });
  assert.equal(pending.authUrl, claudeUrl, "the open button is visible");
  assert.equal(pending.acceptsCode, true, "the Claude code field is visible");

  const done = render({ provider: "claude", status: "succeeded", attemptId: "5" });
  assert.equal(local, null, "the terminal state of the same attempt clears it");
  assert.equal(done.authUrl, null);

  local = { attemptId: "5", authUrl: "https://auth.example/codex" };
  const foreign = render({ provider: "codex", status: "pending", attemptId: "6" });
  assert.equal(local, null, "a newer foreign attempt clears it");
  assert.equal(foreign.authUrl, null);

  local = { attemptId: "8", authUrl: "https://auth.example/codex" };
  render({ provider: "codex", status: "idle", attemptId: null });
  assert.equal(render({ provider: "codex", status: "pending", attemptId: "8" }).authUrl, "https://auth.example/codex",
    "Codex keeps its fallback button through the same ordering");
});

test("status, completion, cancel and failure are shown from the shared state", async () => {
  const panel = await panelApi();
  assert.equal(panel.accountView({ provider: "codex", status: "idle" }).statusText, "Не удалось определить аккаунт");
  assert.equal(panel.accountView({ provider: "claude", status: "succeeded" }).statusText, "Не удалось определить аккаунт");
  const cancelled = panel.accountView({ provider: "claude", status: "cancelled" });
  assert.equal(cancelled.loginStatusText, "Вход отменён");
  assert.equal(cancelled.canCancel, false);
  const failed = panel.accountView({ provider: "claude", status: "failed", error: "Claude Code завершился с кодом 1" });
  assert.equal(failed.error, "Claude Code завершился с кодом 1");
  const rejectedCode = panel.accountView({ provider: "claude", status: "pending", attemptId: "1", error: "Claude Code не принял код" });
  assert.equal(rejectedCode.error, "Claude Code не принял код");
});

test("only a well-formed code for the exact attempt is submitted", async () => {
  const panel = await panelApi();
  const view = panel.accountView({ provider: "claude", status: "pending", attemptId: "3" }, { attemptId: "3" });
  for (const bad of ["", "no-hash", "#state", "code#", "a#b#c", "code #state"]) {
    assert.equal(panel.codeSubmission(view, bad), null);
  }
  assert.deepEqual({ ...panel.codeSubmission(view, `  ${CODE} `) }, { provider: "claude", attemptId: "3", code: CODE });
  assert.equal(panel.codeSubmission(panel.accountView({ provider: "claude", status: "pending", attemptId: "3" }), CODE), null);
});

test("snapshot re-renders do not depend on the typed code", async () => {
  const panel = await panelApi();
  const views = [panel.accountView({ provider: "claude", status: "pending", attemptId: "3" }, { attemptId: "3" })];
  assert.equal(panel.renderKey(views), panel.renderKey(views));
  assert.equal(panel.renderKey(views).includes("Kc0de"), false);
  const changed = [panel.accountView({ provider: "claude", status: "succeeded", attemptId: "3" }, { attemptId: "3" })];
  assert.notEqual(panel.renderKey(views), panel.renderKey(changed));
});

test("the page keeps the code local: memory-only draft, cleared on submit, never stored or opened", () => {
  assert.match(index, /<script src="\/provider-login-panel\.js" defer><\/script>/u);
  assert.match(app, /const providerLoginCodeDrafts = new Map\(\);/u);
  assert.match(app, /providerLoginCodeDrafts\.delete\(view\.provider\);\s*input\.value = "";/u);
  assert.match(app, /if \(!panel\.retainLocal\(account, providerLoginLocal\.get\(account\?\.provider\)\)\) \{/u);
  assert.match(
    hubClient,
    /control\("start-provider-login", \{ provider \}\);[\s\S]*?applySnapshot\(result\.snapshot\);[\s\S]*?agentHub\.setProviderLoginUrl\?\.\(provider,/u,
    "the start response binds its attempt only after the new snapshot is applied",
  );
  assert.doesNotMatch(app, /localStorage[^\n]*providerLogin|sessionStorage[^\n]*providerLogin/u);
  assert.match(hubClient, /control\("submit-provider-login-code", \{ provider, attemptId, code \}\)/u);
  assert.match(hubClient, /if \(provider === "codex" && login\?\.authUrl\) await openProviderLoginPage\(login\.authUrl\);/u);
});
