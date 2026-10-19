import { homedir } from "node:os";
import path from "node:path";

export function defaultRuntimeRoot({
  environment = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  const configured = String(environment.AGENT_HUB_RUNTIME_ROOT ?? "").trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("AGENT_HUB_RUNTIME_ROOT must be absolute");
    return path.resolve(configured);
  }
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

export function defaultTestContourRoot({
  environment = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  const configured = String(environment.AGENT_HUB_TEST_CONTOUR_ROOT ?? "").trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("AGENT_HUB_TEST_CONTOUR_ROOT must be absolute");
    return path.resolve(configured);
  }
  if (platform === "win32") {
    return path.resolve(
      environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "AgentHub-TestContour",
    );
  }
  return path.resolve(
    environment.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
    "agent-hub-test-contour",
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
    launcherFile: path.join(root, process.platform === "win32" ? "AgentHub.RuntimeHost.exe" : "launch.sh"),
    runtimeHostSourceHashFile: path.join(root, "AgentHub.RuntimeHost.source.sha256"),
    runtimeHostBinaryHashFile: path.join(root, "AgentHub.RuntimeHost.exe.sha256"),
    codexHookLauncherFile: path.join(root, "codex-stop-hook-launcher.mjs"),
  };
}

export function runtimeReleaseDirectory(runtimeRoot, releaseId) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(releaseId ?? ""))) {
    throw new Error("Runtime release id contains unsupported characters");
  }
  return path.join(runtimeLayout(runtimeRoot).releasesDir, releaseId);
}
