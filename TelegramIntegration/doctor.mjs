import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.mjs";
import { resolveClaudeInvocation } from "./claude-invocation.mjs";

let failed = false;
let config = null;

function check(label, ok, detail = "") {
  console.log(`${ok ? "OK" : "ERROR"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  config = await loadConfig();
  check("configuration", true, config.configPath);
  check("AI provider", true, config.provider);
  for (const project of config.projects) {
    await access(project.path).then(
      () => check(`project ${project.name}`, true, project.path),
      () => check(`project ${project.name}`, false, project.path),
    );
  }
  check("allowed users", config.allowedUserIds.size > 0, String(config.allowedUserIds.size));
  check("private chat restriction", config.privateChatsOnly);
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

function runCommand(command, args) {
  if (process.platform === "win32" && (
    command === "codex" || command === "claude" || /\.(cmd|bat)$/i.test(command)
  )) {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", command, ...args], {
      encoding: "utf8", windowsHide: true, timeout: 10_000, input: "",
    });
  }
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 10_000, input: "" });
}

const claudeInvocation = resolveClaudeInvocation({
  requested: config?.claudeExecutable || "claude",
  prefixArgs: config?.claudeExecutableArgs ?? [],
});
const codexCommand = config?.codexExecutable || "codex";
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
