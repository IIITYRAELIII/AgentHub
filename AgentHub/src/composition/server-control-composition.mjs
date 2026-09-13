import {
  defaultAutostartInstallScript,
  ServerControlController,
} from "../interfaces/web/server-control-controller.mjs";

export function createServerControlComposition({
  config,
  agentHubRoot,
  serverStartedAt,
  serverInstanceId,
  serverReleaseId,
  shortcutPath,
  activeRunCount,
  restartSnapshot,
  desktopSnapshot,
  spawnCapture,
  preTurnInstructions,
  providerLogin = null,
  controllerOptions = {},
}) {
  return new ServerControlController({
    config,
    startedAt: serverStartedAt,
    instanceId: serverInstanceId,
    releaseId: serverReleaseId,
    shortcutPath,
    installScriptPath: defaultAutostartInstallScript(agentHubRoot),
    activeCount: activeRunCount,
    restartState: restartSnapshot,
    desktopSnapshot,
    spawnCapture,
    preTurnInstructions,
    providerLogin,
    ...controllerOptions,
  });
}
