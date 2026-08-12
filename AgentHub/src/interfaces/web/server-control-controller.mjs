import path from "node:path";
import process from "node:process";
import {
  readAgentHubAutostart,
  readRootAgents,
  rootAgentsFile,
  serverPageSnapshot,
  setAgentHubAutostart,
  updateRootAgents,
} from "./server-page.mjs";
import { updateServerConfiguration } from "./server-configuration.mjs";

export class ServerControlController {
  #pendingConfiguration = {};

  constructor({
    config,
    startedAt,
    instanceId,
    releaseId,
    shortcutPath,
    installScriptPath,
    processId = process.pid,
    activeCount = () => 0,
    restartState = () => ({ pending: false, waiting: false, blockingCount: 0 }),
    desktopSnapshot,
    spawnCapture,
    readAutostart = readAgentHubAutostart,
    setAutostart = setAgentHubAutostart,
    readRootAgentsFile = readRootAgents,
    updateRootAgentsFile = updateRootAgents,
    persistConfiguration = updateServerConfiguration,
    createPageSnapshot = serverPageSnapshot,
  } = {}) {
    if (!config) throw new TypeError("config is required");
    if (typeof desktopSnapshot !== "function") throw new TypeError("desktopSnapshot is required");
    if (typeof spawnCapture !== "function") throw new TypeError("spawnCapture is required");
    this.config = config;
    this.startedAt = startedAt;
    this.instanceId = instanceId;
    this.releaseId = releaseId;
    this.shortcutPath = shortcutPath;
    this.installScriptPath = installScriptPath;
    this.processId = processId;
    this.activeCount = activeCount;
    this.restartState = restartState;
    this.desktopSnapshot = desktopSnapshot;
    this.spawnCapture = spawnCapture;
    this.readAutostart = readAutostart;
    this.setAutostartImpl = setAutostart;
    this.rootAgentsFile = rootAgentsFile(config.projectRoot);
    this.readRootAgentsFile = readRootAgentsFile;
    this.updateRootAgentsFile = updateRootAgentsFile;
    this.persistConfiguration = persistConfiguration;
    this.createPageSnapshot = createPageSnapshot;
  }

  async snapshot({ activeCount = this.activeCount(), restart = null } = {}) {
    return this.createPageSnapshot({
      config: this.config,
      pendingConfiguration: this.#pendingConfiguration,
      processId: this.processId,
      startedAt: this.startedAt,
      instanceId: this.instanceId,
      releaseId: this.releaseId,
      activeCount,
      restart: restart ?? this.restartState(),
      autostart: await this.readAutostart({ shortcutPath: this.shortcutPath }),
    });
  }

  async installAutostart() {
    const result = await this.spawnCapture(
      this.installScriptPath,
      ["--install-autostart"],
      {
        cwd: this.config.projectRoot,
        timeoutMs: 30_000,
        maxOutputBytes: 128 * 1024,
      },
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.error?.message || "Не удалось включить автозапуск Agent Hub");
    }
  }

  async setAutostart(params) {
    if (typeof params?.enabled !== "boolean") throw new Error("Укажите состояние автозапуска");
    const autostart = await this.setAutostartImpl(params.enabled, {
      shortcutPath: this.shortcutPath,
      installAutostart: () => this.installAutostart(),
    });
    return {
      accepted: true,
      message: autostart.enabled ? "Автозапуск Agent Hub включён" : "Автозапуск Agent Hub выключен",
      snapshot: await this.desktopSnapshot(),
    };
  }

  async updateConfiguration(params) {
    const changed = await this.persistConfiguration({
      configPath: this.config.configPath,
      changes: params?.changes,
    });
    this.#pendingConfiguration = { ...this.#pendingConfiguration, ...changed };
    return {
      accepted: true,
      message: "Конфигурация сохранена. Перезапустите Hub для применения.",
      snapshot: await this.desktopSnapshot(),
    };
  }

  async readRootAgents() {
    return this.readRootAgentsFile({ file: this.rootAgentsFile });
  }

  async updateRootAgents(params) {
    const document = await this.updateRootAgentsFile(params?.content, { file: this.rootAgentsFile });
    return {
      accepted: true,
      message: "Корневой AGENTS.md сохранён",
      document,
    };
  }

  get pendingConfiguration() {
    return { ...this.#pendingConfiguration };
  }
}

export function defaultAutostartInstallScript(moduleDirectory) {
  return String(process.env.AGENT_HUB_LAUNCHER ?? "").trim()
    || path.resolve(moduleDirectory, "..", "..", "AgentHub.RuntimeHost.exe");
}
