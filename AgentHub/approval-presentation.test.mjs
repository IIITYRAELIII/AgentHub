import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalModeKeyboard,
  formatApprovalMode,
  formatCommandApproval,
} from "./src/interfaces/telegram/approval-presentation.mjs";

test("approval presentation keeps command, directory and reason together", () => {
  const text = formatCommandApproval({ command: "npm test", reason: "verify" }, { projectRoot: "D:/repo" });
  assert.match(text, /npm test/u);
  assert.match(text, /D:\/repo/u);
  assert.match(text, /verify/u);
});

test("approval mode presentation distinguishes provider and auto policy", () => {
  assert.match(formatApprovalMode({
    provider: "codex", autoApprove: true, autoApproveOnStart: true,
  }), /по умолчанию/u);
  assert.match(formatApprovalMode({
    provider: "claude", autoApprove: false, claudePermissionMode: "default",
  }), /headless CLI/u);
  const keyboard = approvalModeKeyboard({ autoApprove: false, callback: (value) => `ctx:${value}` });
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "ctx:approval-mode:auto");
});
