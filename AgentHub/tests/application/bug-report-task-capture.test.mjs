import assert from "node:assert/strict";
import test from "node:test";

import {
  BugReportTaskCapture,
  bugReportTaskText,
} from "../../src/application/bug-report-task-capture.mjs";

function fixture(workspaces = [{ id: "agent-hub", name: "Agent HUB" }]) {
  const calls = [];
  const taskBoard = {
    create: (payload) => {
      calls.push(["create", payload]);
      return { id: "task-1", bucket: "backlog", ...payload };
    },
    workspaces: () => workspaces,
    move: (payload) => {
      calls.push(["move", payload]);
      return { id: payload.id, bucket: payload.bucket, workspaceId: payload.workspaceId };
    },
  };
  return { calls, taskBoard };
}

test("personal bug report capture places a Task into Agent HUB by name without Telegram triage", () => {
  const { calls, taskBoard } = fixture([{ id: "agent-hub", name: "  agent   hub " }]);
  const capture = new BugReportTaskCapture({ taskBoard, workspaceName: "Agent HUB" });
  const result = capture.capture({
    id: "12345678-1234-4234-8234-123456789abc",
    folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
    screenshots: 2,
  }, { text: "Не открывается карточка" });

  assert.equal(result.workspaceId, "agent-hub");
  assert.equal(calls[0][0], "create");
  assert.equal(calls[0][1].source, "bug-report");
  assert.equal(calls[0][1].sourceKey, "bug-report:12345678-1234-4234-8234-123456789abc");
  assert.match(calls[0][1].text, /^Не открывается карточка\n\nОтчёт: AgentHub\/Bugs\/bug-12345678/u);
  assert.deepEqual(calls[0][1].sourceDetails, {
    bugReportId: "12345678-1234-4234-8234-123456789abc",
    folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
    reportFile: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc/report.md",
    screenshots: 2,
  });
  assert.deepEqual(calls[1], ["move", {
    id: "task-1", bucket: "workspace", workspaceId: "agent-hub",
  }]);
});

test("missing configured Workspace leaves a fresh bug report in Backlog", () => {
  const { calls, taskBoard } = fixture([{ id: "other", name: "Other" }]);
  const result = new BugReportTaskCapture({ taskBoard, workspaceName: "Agent HUB" }).capture({
    id: "12345678-1234-4234-8234-123456789abc",
    folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
  }, { text: "Проверить fallback" });

  assert.equal(result.bucket, "backlog");
  assert.equal(calls.length, 1);
});

test("bug report capture is disabled when no personal Workspace name is configured", () => {
  const capture = new BugReportTaskCapture({ workspaceName: "" });
  assert.equal(capture.capture({ id: "id", folder: "folder" }, { text: "Не создавать" }), null);
});

test("bug report Task text stays bounded and always contains its report path", () => {
  const text = bugReportTaskText({
    id: "12345678-1234-4234-8234-123456789abc",
    folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
    text: "а".repeat(20_000),
  });
  assert.equal(text.length, 20_000);
  assert.match(text, /…\n\nОтчёт: AgentHub\/Bugs\/bug-12345678-1234-4234-8234-123456789abc\/report\.md$/u);
});
