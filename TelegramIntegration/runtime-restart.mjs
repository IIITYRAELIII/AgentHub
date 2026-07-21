import path from "node:path";

export function botReplacementInvocation({
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  botFile,
  integrationRoot,
} = {}) {
  const launcher = String(environment.TELEGRAM_INTEGRATION_LAUNCHER ?? "").trim();
  if (platform === "win32" && launcher) {
    const powershell = environment.SystemRoot
      ? path.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    return {
      command: powershell,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve(launcher),
      ],
      options: {
        cwd: path.dirname(path.resolve(launcher)),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    };
  }
  return {
    command: nodeExecutable,
    args: [path.resolve(botFile)],
    options: {
      cwd: path.resolve(integrationRoot),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  };
}
