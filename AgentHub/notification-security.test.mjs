import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanRuntimeCallerEnvironment,
  resolveAllowedNotificationChatId,
  resolveAllowedNotificationPath,
} from "./src/infrastructure/telegram/notification-security.mjs";

test("notification recipients are restricted to configured users and chats", () => {
  const config = {
    allowedUserIds: new Set([101]),
    allowedChatIds: new Set([-202]),
  };
  assert.equal(resolveAllowedNotificationChatId(config, "101"), 101);
  assert.equal(resolveAllowedNotificationChatId(config, "-202"), -202);
  assert.throws(
    () => resolveAllowedNotificationChatId(config, "-1002999999999"),
    /not in the configured allowlist/,
  );
});

test("notification files stay inside real configured project roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "notification-security-"));
  const project = path.join(root, "project");
  const outside = path.join(root, "secret.json");
  await mkdir(project);
  await writeFile(path.join(project, "message.txt"), "ok", "utf8");
  await writeFile(outside, "secret", "utf8");
  assert.equal(
    await resolveAllowedNotificationPath("message.txt", { roots: [project], cwd: project }),
    await realpath(path.join(project, "message.txt")),
  );
  await assert.rejects(
    resolveAllowedNotificationPath(outside, { roots: [project], cwd: project }),
    /outside the configured project roots/,
  );
});

test("runtime caller environment replaces rather than combines AI session identities", () => {
  const environment = cleanRuntimeCallerEnvironment({
    PATH: "system",
    CODEX_THREAD_ID: "stale-codex",
    CLAUDE_CODE_SESSION_ID: "stale-claude",
    CLAUDECODE: "stale",
  }, {
    CLAUDE_CODE_SESSION_ID: "current-claude",
    CLAUDECODE: "1",
    TELEGRAM_BOT_TOKEN: "must-not-pass",
  });
  assert.equal(environment.PATH, "system");
  assert.equal(environment.CODEX_THREAD_ID, undefined);
  assert.equal(environment.CLAUDE_CODE_SESSION_ID, "current-claude");
  assert.equal(environment.CLAUDECODE, "1");
  assert.equal(environment.TELEGRAM_BOT_TOKEN, undefined);
});

