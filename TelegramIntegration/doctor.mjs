import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.mjs";

let failed = false;
let provider = "codex";
let claudeExecutable = "claude";

function check(label, ok, detail = "") {
  console.log(`${ok ? "OK" : "ERROR"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  const config = await loadConfig();
  provider = config.provider;
  claudeExecutable = config.claudeExecutable;
  check("configuration", true, config.configPath);
  check("AI provider", true, provider);
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
    return spawnSync("cmd.exe", ["/d", "/s", "/c", command, ...args], { encoding: "utf8", windowsHide: true });
  }
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

const providerCommand = provider === "claude"
  ? ["Claude Code CLI", claudeExecutable, ["--version"]]
  : ["Codex CLI", "codex", ["--version"]];

for (const [name, command, args] of [
  ["Node.js", process.execPath, ["--version"]],
  providerCommand,
]) {
  const result = runCommand(command, args);
  check(name, result.status === 0, (result.stdout || result.stderr || result.error?.message || "").trim());
}

process.exitCode = failed ? 1 : 0;
