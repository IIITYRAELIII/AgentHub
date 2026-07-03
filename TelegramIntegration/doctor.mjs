import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.mjs";

let failed = false;

function check(label, ok, detail = "") {
  console.log(`${ok ? "OK" : "ERROR"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  const config = await loadConfig();
  check("configuration", true, config.configPath);
  await access(config.projectRoot).then(
    () => check("projectRoot", true, config.projectRoot),
    () => check("projectRoot", false, config.projectRoot),
  );
  check("allowed users", config.allowedUserIds.size > 0, String(config.allowedUserIds.size));
  check("private chat restriction", config.privateChatsOnly);
  if (config.voiceEnabled) {
    await access(config.pythonExe).then(
      () => check("Whisper Python", true, config.pythonExe),
      () => check("Whisper Python", false, `${config.pythonExe}; run python install.py --with-voice`),
    );
  }
} catch (error) {
  check("configuration", false, error.message);
}

function runCommand(command, args) {
  if (process.platform === "win32" && command === "codex") {
    return spawnSync("cmd.exe", ["/c", "codex", ...args], { encoding: "utf8", windowsHide: true });
  }
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

for (const [name, command, args] of [
  ["Node.js", process.execPath, ["--version"]],
  ["Codex CLI", "codex", ["--version"]],
]) {
  const result = runCommand(command, args);
  check(name, result.status === 0, (result.stdout || result.stderr || result.error?.message || "").trim());
}

process.exitCode = failed ? 1 : 0;
