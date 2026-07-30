import { homedir } from "node:os";
import path from "node:path";

export function defaultRuntimeRoot({
  environment = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  if (platform === "win32") {
    return path.resolve(
      environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "AgentHub",
    );
  }
  return path.resolve(
    environment.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
    "agent-hub",
  );
}

export function runtimeLayout(runtimeRoot = defaultRuntimeRoot()) {
  const root = path.resolve(runtimeRoot);
  return {
    root,
    releasesDir: path.join(root, "releases"),
    configFile: path.join(root, "config.json"),
    dataDir: path.join(root, "data"),
    currentFile: path.join(root, "current.json"),
    activationFile: path.join(root, "active.json"),
    launcherFile: path.join(root, process.platform === "win32" ? "launch.vbs" : "launch.sh"),
    legacyWindowsLauncherFile: path.join(root, "runtime-launch.vbs"),
    powershellLauncherFile: path.join(root, "launch.ps1"),
    codexHookLauncherFile: path.join(root, "codex-stop-hook-launcher.mjs"),
  };
}

export function runtimeReleaseDirectory(runtimeRoot, releaseId) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(releaseId ?? ""))) {
    throw new Error("Runtime release id contains unsupported characters");
  }
  return path.join(runtimeLayout(runtimeRoot).releasesDir, releaseId);
}
