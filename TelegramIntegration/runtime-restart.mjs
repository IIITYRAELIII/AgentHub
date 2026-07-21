import path from "node:path";

function quotedWindowsArgument(value) {
  return `"${String(value).replaceAll("\"", "\"\"")}\"`;
}

export function independentWindowsLauncherInvocation({
  environment = process.env,
  launcher,
} = {}) {
  const powershell = environment.SystemRoot
    ? path.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const resolvedLauncher = path.resolve(launcher);
  const isVisualBasicLauncher = path.extname(resolvedLauncher).toLowerCase() === ".vbs";
  const targetCommandLine = isVisualBasicLauncher
    ? [
      quotedWindowsArgument(path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe")),
      "//B",
      "//Nologo",
      quotedWindowsArgument(resolvedLauncher),
    ].join(" ")
    : [
      quotedWindowsArgument(powershell),
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      quotedWindowsArgument(resolvedLauncher),
    ].join(" ");
  return {
    command: powershell,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
        + "-Arguments @{CommandLine=$env:TELEGRAM_RUNTIME_TARGET_COMMAND}; "
        + "if ($result.ReturnValue -ne 0) { throw ('Win32_Process.Create failed: ' + $result.ReturnValue) }",
    ],
    options: {
      cwd: path.dirname(resolvedLauncher),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...environment,
        TELEGRAM_RUNTIME_TARGET_COMMAND: targetCommandLine,
      },
    },
  };
}

export function botReplacementInvocation({
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  botFile,
  integrationRoot,
} = {}) {
  const launcher = String(environment.TELEGRAM_INTEGRATION_LAUNCHER ?? "").trim();
  if (platform === "win32" && launcher) {
    return independentWindowsLauncherInvocation({ environment, launcher });
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
