import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callDesktopControl } from "../../desktop-control.mjs";
import { cleanupE2eTemporaryRoot, E2eChildProcessOwner, waitFor } from "../../e2e/telegram-harness.mjs";

const source = path.resolve(import.meta.dirname, "../..");

test("running Hub exposes GitHub account state and starts browser authorization through local control", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-github-startup-"));
  const configFile = path.join(root, "config.json");
  const projectRoot = path.join(root, "project");
  const owner = new E2eChildProcessOwner({ label: "GitHub account startup" });
  try {
    await mkdir(projectRoot);
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false, codexContextCleanup: false },
      provider: "codex", projectRoot, dataDir: path.join(root, "data"),
      codexExecutable: process.execPath,
      codexExecutableArgs: [path.join(source, "e2e/fake-codex-app-server.mjs"), "--state", path.join(root, "provider.json")],
      codexExecutableAutoUpdate: false, createInitialThreadOnStartup: false,
      codexRolloutContext: { enabled: false }, codexRateLimitPolling: false, claudeRateLimitPolling: false,
      diagnostics: { sentry: { enabled: false, dsn: "" } },
    }));
    // Keep actual application startup and local control. Replace only the OAuth broker response.
    const network = `const original = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (String(url) === "https://auth.darksanctuary.ru/github/start") {
          const body = JSON.parse(options.body);
          if (options.method !== "POST" || !/^[A-Za-z0-9_-]{43}$/.test(body.challenge)) throw Error("Unexpected browser start");
          return Promise.resolve(Response.json({state:"s".repeat(43)}));
        }
        if (new URL(String(url)).hostname.endsWith("github.com")) throw Error("Unexpected GitHub request");
        return original(url, options);
      };`;
    const env = { ...process.env, AGENT_HUB_CONFIG: configFile, AGENT_HUB_RUNTIME_ROOT: root,
      AGENT_HUB_LAUNCHER: "", AGENT_HUB_DISABLE_SECRET_ACL: "1",
      USERPROFILE: path.join(root, "home"), APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "localappdata"), CODEX_HOME: path.join(root, "codex") };
    delete env.NODE_OPTIONS;
    const child = owner.start(() => spawn(process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(network)}`, path.join(source, "agent-hub-main.mjs")],
      { cwd: source, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
    let diagnostics = "";
    child.stdout.on("data", bytes => { diagnostics += bytes; });
    child.stderr.on("data", bytes => { diagnostics += bytes; });
    try {
      await waitFor(() => /Agent Hub ready;/u.test(diagnostics), "Hub Ready", 15000);
    } catch (error) {
      throw new Error(`${error.message}\n${diagnostics}`, { cause: error });
    }
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot: root });
    assert.equal(snapshot.server.githubAccount.status, "disconnected");
    const result = await callDesktopControl("connect-github-account", {}, { runtimeRoot: root });
    const authorization = new URL(result.login.authorizationUrl);
    assert.equal(authorization.origin + authorization.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(authorization.searchParams.get("redirect_uri"), "https://auth.darksanctuary.ru/github/callback");
    assert.deepEqual(Object.keys(result.login).sort(), ["attemptId", "authorizationUrl", "expiresAt", "waitMs"]);
    await callDesktopControl("cancel-github-account-login", { attemptId: result.login.attemptId }, { runtimeRoot: root });
  } finally {
    await owner.stop();
    await cleanupE2eTemporaryRoot(root);
  }
});
