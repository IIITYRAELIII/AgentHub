const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const PROFILES = Object.freeze({
  production: Object.freeze({
    name: "production",
    title: "Agent Hub",
    viewId: "agentHub.view",
    commandPrefix: "agentHub",
    panelType: "agentHub.editor",
    themeKey: "agentHub.theme",
  }),
  "test-contour": Object.freeze({
    name: "test-contour",
    title: "Agent Hub Test",
    viewId: "agentHubTestContour.view",
    commandPrefix: "agentHubTestContour",
    panelType: "agentHubTestContour.editor",
    themeKey: "agentHubTestContour.theme",
  }),
});

function profileRuntimeRoot(profile, {
  environment = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  const testContour = profile.name === "test-contour";
  const configured = environment[
    testContour ? "AGENT_HUB_TEST_CONTOUR_ROOT" : "AGENT_HUB_RUNTIME_ROOT"
  ];
  if (configured) return path.resolve(configured);
  if (platform === "win32") {
    return path.resolve(
      environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      testContour ? "AgentHub-TestContour" : "AgentHub",
    );
  }
  return path.resolve(
    environment.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
    testContour ? "agent-hub-test-contour" : "agent-hub",
  );
}

function loadExtensionProfile(extensionRoot = __dirname, options = {}) {
  const file = path.join(extensionRoot, "extension-profile.json");
  let name = "production";
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    name = String(value?.profile ?? "").trim().toLowerCase();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const profile = PROFILES[name];
  if (!profile) throw new Error(`Unknown Agent Hub extension profile: ${name}`);
  return { ...profile, runtimeRoot: profileRuntimeRoot(profile, options) };
}

module.exports = {
  loadExtensionProfile,
  profileRuntimeRoot,
};
