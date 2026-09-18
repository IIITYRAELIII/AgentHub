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

test("personal bug report capture places a Task into Agent HUB by name without Telegram triage", async () => {
  const { calls, taskBoard } = fixture([{ id: "agent-hub", name: "  agent   hub " }]);
  const capture = new BugReportTaskCapture({ taskBoard, workspaceName: "Agent HUB" });
  const result = await capture.capture({
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

test("missing configured Workspace leaves a fresh bug report in Backlog", async () => {
  const { calls, taskBoard } = fixture([{ id: "other", name: "Other" }]);
  const result = await new BugReportTaskCapture({ taskBoard, workspaceName: "Agent HUB" }).capture({
    id: "12345678-1234-4234-8234-123456789abc",
    folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
  }, { text: "Проверить fallback" });

  assert.equal(result.bucket, "backlog");
  assert.equal(calls.length, 1);
});

test("bug report capture is disabled when no personal Workspace name is configured", async () => {
  const capture = new BugReportTaskCapture({ workspaceName: "" });
  assert.equal(await capture.capture({ id: "id", folder: "folder" }, { text: "Не создавать" }), null);
});

test("bug report Task text preserves long descriptions and their report path", () => {
  const text = bugReportTaskText({
    id: "12345678-1234-4234-8234-123456789abc",
    folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
    text: "а".repeat(20_000),
  });
  assert.equal(text, `${"а".repeat(20_000)}\n\nОтчёт: AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc/report.md`);
});

test("first personal bug report scan imports existing reports before recording its baseline", async () => {
  const { calls, taskBoard } = fixture([{ id: "agent-hub", name: "Agent HUB" }]);
  const saved = [];
  const capture = new BugReportTaskCapture({
    taskBoard,
    workspaceName: "Agent HUB",
    reports: {
      addedSince: async (revision) => {
        assert.equal(revision, "");
        return {
          head: "a".repeat(40),
          baseline: true,
          reports: [{
            id: "12345678-1234-4234-8234-123456789abc",
            folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
            text: "Уже был в Git",
            screenshots: 0,
          }],
        };
      },
    },
    cursorStore: {
      load: async () => "",
      save: async (revision) => saved.push(revision),
    },
  });

  assert.deepEqual(await capture.scan(), {
    captured: 1, baseline: true, head: "a".repeat(40),
  });
  assert.deepEqual(saved, ["a".repeat(40)]);
  assert.equal(calls[0][1].sourceKey, "bug-report:12345678-1234-4234-8234-123456789abc");
  assert.match(calls[0][1].text, /^Уже был в Git/u);
  assert.deepEqual(calls[1], ["move", {
    id: "task-1", bucket: "workspace", workspaceId: "agent-hub",
  }]);
});

test("personal bug report scan captures reports added by a later Git pull", async () => {
  const { calls, taskBoard } = fixture([{ id: "agent-hub", name: "Agent HUB" }]);
  let cursor = "a".repeat(40);
  const capture = new BugReportTaskCapture({
    taskBoard,
    workspaceName: "Agent HUB",
    reports: {
      addedSince: async (revision) => {
        assert.equal(revision, "a".repeat(40));
        return {
          head: "b".repeat(40),
          baseline: false,
          reports: [{
            id: "12345678-1234-4234-8234-123456789abc",
            folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
            text: "Пришло через pull",
            screenshots: 1,
          }],
        };
      },
    },
    cursorStore: {
      load: async () => cursor,
      save: async (revision) => { cursor = revision; },
    },
  });

  assert.deepEqual(await capture.scan(), {
    captured: 1, baseline: false, head: "b".repeat(40),
  });
  assert.equal(cursor, "b".repeat(40));
  assert.equal(calls[0][1].source, "bug-report");
  assert.match(calls[0][1].text, /^Пришло через pull/u);
  assert.deepEqual(calls[1], ["move", {
    id: "task-1", bucket: "workspace", workspaceId: "agent-hub",
  }]);
});
