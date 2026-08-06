import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_SANDBOX_MODES,
  codexThreadSandboxSettings,
  codexTurnSandboxSettings,
  normalizeCodexSandboxMode,
} from "../../../src/providers/codex/codex-sandbox.mjs";

test("Codex sandbox mode defaults to workspace-write and rejects unknown values", () => {
  assert.deepEqual(CODEX_SANDBOX_MODES, ["workspace-write", "danger-full-access"]);
  assert.equal(normalizeCodexSandboxMode(), "workspace-write");
  assert.equal(normalizeCodexSandboxMode("danger-full-access"), "danger-full-access");
  assert.throws(() => normalizeCodexSandboxMode("unelevated"), /codexSandboxMode/u);
});

test("Codex thread settings use the configured sandbox mode", () => {
  assert.deepEqual(codexThreadSandboxSettings("workspace-write"), {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  assert.deepEqual(codexThreadSandboxSettings("danger-full-access"), {
    approvalPolicy: "on-request",
    sandbox: "danger-full-access",
  });
});

test("Codex turns use a matching App Server sandbox policy", () => {
  assert.deepEqual(codexTurnSandboxSettings("workspace-write", "D:/project"), {
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["D:/project"],
      networkAccess: false,
    },
  });
  assert.deepEqual(codexTurnSandboxSettings("danger-full-access", "D:/ignored"), {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
});
