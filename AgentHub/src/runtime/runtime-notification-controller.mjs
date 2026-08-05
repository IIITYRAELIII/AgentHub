import path from "node:path";
import process from "node:process";

import {
  cleanRuntimeCallerEnvironment,
  resolveAllowedNotificationCwd,
  resolveAllowedNotificationPath,
} from "../infrastructure/telegram/notification-security.mjs";
import { captureProcess } from "../infrastructure/process/process-capture.mjs";
import {
  parseSendImagesArguments,
  parseSendMessageArguments,
} from "../infrastructure/telegram/notification-command-arguments.mjs";
import { resolveAllowedNotificationChatId } from "../infrastructure/telegram/notification-security.mjs";

const NOTIFICATION_COMMANDS = new Set(["send-message", "send-images"]);

export class RuntimeNotificationController {
  constructor({
    config,
    moduleRoot,
    runProcess = captureProcess,
    stopProcess,
  }) {
    this.config = config;
    this.moduleRoot = moduleRoot;
    this.runProcess = runProcess;
    this.stopProcess = stopProcess;
  }

  supports(command) {
    return NOTIFICATION_COMMANDS.has(command);
  }

  async #spawn(script, args, requestCwd, callerEnvironment = {}) {
    const result = await this.runProcess(
      process.execPath,
      [path.join(this.moduleRoot, script), ...args],
      {
        cwd: requestCwd,
        env: {
          ...cleanRuntimeCallerEnvironment(process.env, callerEnvironment),
          AGENT_HUB_CONFIG: this.config.configPath,
          AGENT_HUB_DIRECT: "1",
        },
        timeoutMs: 180_000,
        maxOutputBytes: 256 * 1024,
        ...(this.stopProcess ? { stopProcess: this.stopProcess } : {}),
      },
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.error?.message || `${script} failed`);
    }
    return result.stdout.trim();
  }

  async handle(request) {
    if (!this.supports(request.command)) {
      throw new Error(`Unsupported runtime notification command: ${request.command}`);
    }
    const allowedRoots = this.config.projects.map((project) => project.path);
    const requestCwd = await resolveAllowedNotificationCwd(request.cwd, { roots: allowedRoots });
    const messageCommand = request.command === "send-message";
    const script = messageCommand ? "send-message.mjs" : "send-images.mjs";
    const options = messageCommand
      ? parseSendMessageArguments(request.args)
      : parseSendImagesArguments(request.args);
    resolveAllowedNotificationChatId(this.config, options.chatId);

    if (messageCommand && options.messageFile) {
      await resolveAllowedNotificationPath(options.messageFile, {
        roots: allowedRoots,
        cwd: requestCwd,
      });
    }
    if (!messageCommand) {
      await Promise.all(options.files.map((file) => resolveAllowedNotificationPath(file, {
        roots: allowedRoots,
        cwd: requestCwd,
      })));
    }
    return this.#spawn(script, request.args, requestCwd, request.environment);
  }
}
