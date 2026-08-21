const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadExtensionProfile } = require("./extension-profile.js");

test("extension profiles keep production and Test Contour independent", async () => {
  const productionRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-extension-production-"));
  const contourRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-extension-contour-"));
  try {
    const environment = { LOCALAPPDATA: "C:/state" };
    const production = loadExtensionProfile(productionRoot, {
      environment,
      platform: "win32",
    });
    await writeFile(
      path.join(contourRoot, "extension-profile.json"),
      `${JSON.stringify({ profile: "test-contour" })}\n`,
      "utf8",
    );
    const contour = loadExtensionProfile(contourRoot, {
      environment,
      platform: "win32",
    });

    assert.equal(production.viewId, "agentHub.view");
    assert.equal(contour.viewId, "agentHubTestContour.view");
    assert.equal(contour.title, "Agent Hub Test");
    assert.equal(production.runtimeRoot, path.resolve("C:/state", "AgentHub"));
    assert.equal(contour.runtimeRoot, path.resolve("C:/state", "AgentHub-TestContour"));
    assert.notEqual(production.commandPrefix, contour.commandPrefix);
    assert.notEqual(production.themeKey, contour.themeKey);
  } finally {
    await Promise.all([
      rm(productionRoot, { recursive: true, force: true }),
      rm(contourRoot, { recursive: true, force: true }),
    ]);
  }
});
