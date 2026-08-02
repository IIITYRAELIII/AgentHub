import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callDesktopControl } from "./desktop-control.mjs";
import { delay, stopPid, waitFor } from "./e2e/telegram-harness.mjs";

const ROOT = path.resolve(import.meta.dirname);
const BOT_FILE = path.join(ROOT, "agent-hub-server.mjs");
const FAKE_CODEX_FILE = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");

test("core-only components start without Telegram and keep Web App disabled", { timeout: 20_000 }, async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-e2e-"));
  const dataDir = path.join(runtimeRoot, "data");
  const projectRoot = path.join(runtimeRoot, "project");
  const configPath = path.join(runtimeRoot, "config.json");
  const codexStatePath = path.join(runtimeRoot, "fake-codex-state.json");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  await writeFile(configPath, `${JSON.stringify({
    components: { telegram: false, miniApp: false, androidApp: false },
    provider: "codex",
    projectRoot,
    projects: [{ name: "Journal E2E", path: projectRoot }],
    dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", codexStatePath],
    codexRolloutContext: { enabled: false },
    miniApp: { enabled: true, host: "127.0.0.1", port: 65533 },
  }, null, 2)}\n`, "utf8");

  const bot = spawn(process.execPath, [BOT_FILE], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_HUB_CONFIG: configPath,
      AGENT_HUB_RUNTIME_ROOT: runtimeRoot,
      AGENT_HUB_LAUNCHER: "",
      AGENT_HUB_DISABLE_SECRET_ACL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  bot.stdout.setEncoding("utf8");
  bot.stderr.setEncoding("utf8");
  bot.stdout.on("data", (chunk) => { stdout += chunk; });
  bot.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (bot.exitCode == null) {
      bot.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => bot.once("exit", resolve)), delay(2_000)]);
    }
    if (bot.exitCode == null) await stopPid(bot.pid);
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const snapshot = await waitFor(
    () => callDesktopControl("snapshot", {}, { runtimeRoot }).catch(() => null),
    "journal runtime startup",
  );
  assert.equal(snapshot.apiVersion, 2);
  await waitFor(
    () => (/Agent Hub ready; components: core/u.test(stdout) ? true : null),
    "journal runtime ready log",
  );
  assert.match(stdout, /Agent Hub ready; components: core/u);
  assert.doesNotMatch(stdout, /Mini App ready/u);
  assert.doesNotMatch(stderr, /telegramBotToken|Telegram API/u);
});
