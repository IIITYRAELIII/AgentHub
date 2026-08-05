import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeNotificationController } from "./src/runtime/runtime-notification-controller.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-notification-controller-"));
  const project = path.join(root, "project");
  await mkdir(project);
  const messageFile = path.join(project, "message.txt");
  const imageFile = path.join(project, "image.png");
  await writeFile(messageFile, "Готово", "utf8");
  await writeFile(imageFile, "png", "utf8");
  const calls = [];
  const controller = new RuntimeNotificationController({
    config: {
      configPath: path.join(root, "config.json"),
      projects: [{ path: project }],
      allowedUserIds: new Set([101]),
      allowedChatIds: new Set([-202]),
    },
    moduleRoot: path.join(root, "release"),
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: "sent\n", stderr: "" };
    },
  });
  return { controller, calls, project, messageFile, imageFile };
}

test("runtime notifications validate files and execute the release script", async () => {
  const { controller, calls, project, messageFile, imageFile } = await fixture();
  const environment = {
    CODEX_THREAD_ID: "current-thread",
    TELEGRAM_BOT_TOKEN: "must-not-pass",
  };

  assert.equal(await controller.handle({
    command: "send-message",
    args: ["--chat-id", "101", "--message-file", messageFile],
    cwd: project,
    environment,
  }), "sent");
  assert.equal(await controller.handle({
    command: "send-images",
    args: ["--chat-id", "-202", imageFile],
    cwd: project,
    environment,
  }), "sent");

  assert.equal(calls.length, 2);
  assert.equal(path.basename(calls[0].args[0]), "send-message.mjs");
  assert.equal(path.basename(calls[1].args[0]), "send-images.mjs");
  assert.equal(calls[0].options.cwd, await realpath(project));
  assert.equal(calls[0].options.env.CODEX_THREAD_ID, "current-thread");
  assert.equal(calls[0].options.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(calls[0].options.env.AGENT_HUB_DIRECT, "1");
});

test("runtime notifications reject recipients and files outside configured roots", async () => {
  const { controller, calls, project } = await fixture();
  const outside = path.join(path.dirname(project), "secret.txt");
  await writeFile(outside, "secret", "utf8");

  await assert.rejects(controller.handle({
    command: "send-message",
    args: ["--chat-id", "999", "text"],
    cwd: project,
    environment: {},
  }), /allowlist/);
  await assert.rejects(controller.handle({
    command: "send-images",
    args: [outside],
    cwd: project,
    environment: {},
  }), /outside the configured project roots/);
  assert.equal(calls.length, 0);
});

test("runtime notification controller rejects lifecycle commands", async () => {
  const { controller } = await fixture();
  assert.equal(controller.supports("turn-start"), false);
  await assert.rejects(controller.handle({ command: "turn-start" }), /Unsupported/);
});

