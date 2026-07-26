import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalCallbackData,
  approvalMatchesTelegramMessage,
  codexApprovalResponse,
  codexThreadWaitingOnApproval,
  createApprovalKey,
  formatMcpElicitation,
  formatPermissionsApproval,
  mcpElicitationAutoResponse,
  parseApprovalCallback,
} from "./codex-approvals.mjs";

test("approval callbacks use unique UUIDs and bind to the exact Telegram message", () => {
  const first = createApprovalKey();
  const second = createApprovalKey();
  assert.notEqual(first, second);
  const callbackData = approvalCallbackData(first, "once");
  assert.deepEqual(parseApprovalCallback(callbackData), { key: first, action: "once" });
  assert.equal(parseApprovalCallback("a:1:once"), null, "legacy counters must expire after restart");

  const approval = { chatId: 10, messageId: 20 };
  assert.equal(approvalMatchesTelegramMessage(approval, { message: { chat: { id: 10 }, message_id: 20 } }), true);
  assert.equal(approvalMatchesTelegramMessage(approval, { message: { chat: { id: 10 }, message_id: 21 } }), false);
});

test("permission approvals grant exactly the requested profile", () => {
  const params = { permissions: { network: { enabled: true } } };
  assert.deepEqual(codexApprovalResponse("permissions", "once", params), {
    permissions: params.permissions,
    scope: "turn",
  });
  assert.deepEqual(codexApprovalResponse("permissions", "session", params), {
    permissions: params.permissions,
    scope: "session",
  });
  assert.deepEqual(codexApprovalResponse("permissions", "decline", params), {
    permissions: {},
    scope: "turn",
  });
});

test("legacy command and file approval responses stay compatible", () => {
  assert.deepEqual(codexApprovalResponse("command", "once"), { decision: "accept" });
  assert.deepEqual(codexApprovalResponse("file", "session"), { decision: "acceptForSession" });
  assert.deepEqual(codexApprovalResponse("command", "decline"), { decision: "decline" });
});

test("waitingOnApproval is detected from thread active flags", () => {
  assert.equal(codexThreadWaitingOnApproval({ type: "active", activeFlags: ["waitingOnApproval"] }), true);
  assert.equal(codexThreadWaitingOnApproval({ type: "active", activeFlags: [] }), false);
  assert.equal(codexThreadWaitingOnApproval({ type: "idle", activeFlags: ["waitingOnApproval"] }), false);
});

test("permission prompt includes reason, cwd and requested profile", () => {
  const text = formatPermissionsApproval({
    cwd: "C:\\Work",
    reason: "Нужен доступ к тестовой базе",
    permissions: { network: { enabled: true } },
  });
  assert.match(text, /C:\\Work/);
  assert.match(text, /тестовой базе/);
  assert.match(text, /network/);
});

test("safe MCP permission forms can follow auto approval", () => {
  const params = {
    serverName: "test-mcp",
    mode: "form",
    message: "Разрешить действие?",
    requestedSchema: {
      type: "object",
      required: ["approved", "scope"],
      properties: {
        approved: { type: "boolean" },
        scope: { type: "string", enum: ["deny", "allow"] },
        note: { type: "string", default: "trusted" },
      },
    },
  };
  assert.deepEqual(mcpElicitationAutoResponse(params), {
    action: "accept",
    content: { approved: true, scope: "allow", note: "trusted" },
  });
  assert.match(formatMcpElicitation(params), /test-mcp/);
  assert.match(formatMcpElicitation(params), /approved/);
});

test("MCP forms requiring invented text are never auto-filled", () => {
  assert.equal(mcpElicitationAutoResponse({
    mode: "form",
    requestedSchema: {
      type: "object",
      required: ["password"],
      properties: { password: { type: "string" } },
    },
  }), null);
  assert.equal(mcpElicitationAutoResponse({ mode: "url", url: "https://example.test" }), null);
});
