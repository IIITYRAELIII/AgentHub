import assert from "node:assert/strict";
import test from "node:test";

import { createServerControlComposition } from "../../src/composition/server-control-composition.mjs";

test("server control composition binds runtime metadata and deferred Desktop snapshot", async () => {
  const controller = createServerControlComposition({
    config: {
      projectRoot: "C:/work",
      configPath: "C:/runtime/config.json",
      components: {},
      miniApp: {},
    },
    agentHubRoot: "C:/runtime/releases/current",
    serverStartedAt: "2026-08-06T00:00:00.000Z",
    serverInstanceId: "instance",
    serverReleaseId: "release",
    shortcutPath: "C:/Startup/Agent Hub.lnk",
    activeRunCount: () => 2,
    restartSnapshot: () => ({ pending: true, waiting: false, blockingCount: 1 }),
    desktopSnapshot: async () => ({ refreshed: true }),
    spawnCapture: async () => ({ code: 0, stdout: "", stderr: "" }),
    controllerOptions: {
      processId: 42,
      readAutostart: async () => ({ supported: true, enabled: false }),
      createPageSnapshot: (value) => value,
    },
  });

  const snapshot = await controller.snapshot();
  assert.equal(snapshot.processId, 42);
  assert.equal(snapshot.startedAt, "2026-08-06T00:00:00.000Z");
  assert.equal(snapshot.instanceId, "instance");
  assert.equal(snapshot.releaseId, "release");
  assert.equal(snapshot.activeCount, 2);
  assert.deepEqual(snapshot.restart, { pending: true, waiting: false, blockingCount: 1 });
  assert.deepEqual(snapshot.autostart, { supported: true, enabled: false });
  assert.match(controller.installScriptPath, /AgentHub\.RuntimeHost\.exe$/u);
});
