import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { AGENT_HUB_ROOT, loadConfig, pathInsideOrSame } from "./config.mjs";
import { resolveClaudeInvocation } from "./claude-invocation.mjs";
import { resolveCodexExecutable } from "./codex-invocation.mjs";
import {
  probeCodexAppServer,
  probeTelegramConnectivity,
  requiresTelegramChecks,
} from "./doctor-probes.mjs";
import { unavailableLocalMcpOverrides } from "./local-mcp-preflight.mjs";
import { codexStopHookStatus } from "./codex-hook-config.mjs";

let failed = false;
let config = null;

function check(label, ok, detail = "") {
  console.log(`${ok ? "OK" : "ERROR"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  config = await loadConfig();
  check("configuration", true, config.configPath);
  check(
    "external control-plane config",
    !pathInsideOrSame(config.configPath, AGENT_HUB_ROOT),
    config.configPath,
  );
  check(
    "external runtime state",
    !pathInsideOrSame(config.dataDir, AGENT_HUB_ROOT),
    config.dataDir,
  );
  check("AI provider", true, config.provider);
  for (const project of config.projects) {
    await access(project.path).then(
      () => check(`project ${project.name}`, true, project.path),
      () => check(`project ${project.name}`, false, project.path),
    );
  }
  if (requiresTelegramChecks(config)) {
    check("allowed users", config.allowedUserIds.size > 0, String(config.allowedUserIds.size));
    check("private chat restriction", config.privateChatsOnly);
  } else {
    check("Telegram profile", true, "disabled by journal profile");
  }
  if (config.voiceEnabled) {
    await access(config.pythonExe).then(
      () => check("Whisper Python", true, config.pythonExe),
      () => check("Whisper Python", false, `${config.pythonExe}; run python install.py --with-voice`),
    );
  }
  if (config.ttsEnabled) {
    await access(config.ttsPythonExe).then(
      () => check("Silero TTS Python", true, config.ttsPythonExe),
      () => check("Silero TTS Python", false, `${config.ttsPythonExe}; run python install.py --install-voice`),
    );
  }
} catch (error) {
  check("configuration", false, error.message);
}

function decodeBuffer(value, encoding) {
  if (!Buffer.isBuffer(value)) return value;
  try {
    return new TextDecoder(encoding).decode(value);
  } catch {
    return value.toString("utf8");
  }
}

function warn(label, detail = "") {
  console.log(`WARN  ${label}${detail ? `: ${detail}` : ""}`);
}

function runCommand(command, args, { timeoutMs = 10_000, outputEncoding = "utf8" } = {}) {
  const encoding = outputEncoding === "utf8" ? "utf8" : null;
  if (process.platform === "win32" && (
    command === "codex" || command === "claude" || /\.(cmd|bat)$/i.test(command)
  )) {
    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", command, ...args], {
      encoding, windowsHide: true, timeout: timeoutMs, input: "",
    });
    return {
      ...result,
      stdout: decodeBuffer(result.stdout, outputEncoding),
      stderr: decodeBuffer(result.stderr, outputEncoding),
    };
  }
  const result = spawnSync(command, args, {
    encoding, windowsHide: true, timeout: timeoutMs, input: "",
  });
  return {
    ...result,
    stdout: decodeBuffer(result.stdout, outputEncoding),
    stderr: decodeBuffer(result.stderr, outputEncoding),
  };
}

if (config && process.platform === "win32") {
  const acl = runCommand("icacls.exe", [config.configPath], { outputEncoding: "ibm866" });
  const aclText = String(acl.stdout || acl.stderr || acl.error?.message || "").trim();
  check(
    "runtime config ACL excludes CodexSandboxUsers",
    acl.status === 0 && !/CodexSandboxUsers/i.test(aclText),
    aclText,
  );
}

if (config) {
  try {
    const hooks = await codexStopHookStatus({
      runtimeRoot: path.dirname(config.configPath),
    });
    check(
      "Codex UserPromptSubmit/Stop hooks configured",
      hooks.configured,
      JSON.stringify(hooks.events),
    );
    if (hooks.receipts.start || hooks.receipts.stop) {
      check("Codex hook receipts", true, JSON.stringify(hooks.receipts));
    } else {
      warn("Codex hook receipts", "no invocation has been observed by this runtime yet");
    }
  } catch (error) {
    check("Codex hook receipts", false, error.message);
  }
}

const claudeInvocation = resolveClaudeInvocation({
  requested: config?.claudeExecutable || "claude",
  prefixArgs: config?.claudeExecutableArgs ?? [],
});
const codexCommand = await resolveCodexExecutable({ requested: config?.codexExecutable || "" });
const codexArgs = [...(config?.codexExecutableArgs ?? []), "--version"];

for (const [name, command, args] of [
  ["Node.js", process.execPath, ["--version"]],
  ["Codex CLI", codexCommand, codexArgs],
  [`Claude Code CLI (${claudeInvocation.source})`, claudeInvocation.command, [
    ...claudeInvocation.prefixArgs,
    "--version",
  ]],
]) {
  const result = runCommand(command, args);
  check(name, result.status === 0, (result.stdout || result.stderr || result.error?.message || "").trim());
}

if (config && requiresTelegramChecks(config)) {
  try {
    const telegramBot = await probeTelegramConnectivity({
      token: config.token,
      apiBaseUrl: config.telegramApiBaseUrl,
    });
    check(
      "Telegram Bot API connectivity",
      true,
      `${telegramBot.username ? `@${telegramBot.username} · ` : ""}id=${telegramBot.id}`,
    );
  } catch (error) {
    check("Telegram Bot API connectivity", false, error.message);
  }
} else if (config) {
  check("Telegram Bot API connectivity", true, "disabled by journal profile");
}

if (config) {
  try {
    const mcp = await unavailableLocalMcpOverrides();
    const appServer = await probeCodexAppServer({
      command: codexCommand,
      prefixArgs: [...config.codexExecutableArgs, ...mcp.args],
      cwd: config.projectRoot,
      timeoutMs: Math.min(config.codexRpcTimeoutSeconds * 1000, 15_000),
    });
    check(
      "Codex App Server handshake",
      true,
      `${appServer.userAgent || "initialized"}; thread/list OK${mcp.disabled.length ? `; disabled unavailable local MCP: ${mcp.disabled.length}` : ""}`,
    );
  } catch (error) {
    check("Codex App Server handshake", false, error.message);
  }

  const claudeUsage = runCommand(claudeInvocation.command, [
    ...claudeInvocation.prefixArgs,
    "--print", "--output-format", "text", "--permission-mode", "dontAsk", "/usage",
  ], { timeoutMs: 15_000 });
  const claudeUsageText = String(claudeUsage.stdout || claudeUsage.stderr || claudeUsage.error?.message || "").trim();
  check(
    "Claude Code session probe",
    claudeUsage.status === 0 && Boolean(claudeUsageText),
    claudeUsageText,
  );
}

if (process.platform === "win32") {
  const where = runCommand("where.exe", ["pwsh.exe"]);
  const candidates = String(where.stdout ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const selected = candidates[0] ?? "";
  const storeAlias = /\\AppData\\Local\\Microsoft\\WindowsApps\\/i.test(selected);
  const version = selected
    ? runCommand(selected, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"])
    : null;
  check(
    "PowerShell 7",
    Boolean(selected) && !storeAlias && version?.status === 0,
    storeAlias
      ? `${selected}; replace the Windows Store alias with the Program Files PowerShell 7 path`
      : `${selected || "pwsh.exe not found"}${version?.stdout ? ` · ${version.stdout.trim()}` : ""}`,
  );
}

process.exitCode = failed ? 1 : 0;
