import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function approvalFormApi() {
  const source = await readFile(
    new URL("../../assets/web-app/approval-form.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubApprovalForm;
}

function question(id, { selected = "", other = "" } = {}) {
  return {
    dataset: { approvalQuestion: id },
    querySelector(selector) {
      if (selector === "input[type='radio']:checked") return selected ? { value: selected } : null;
      if (selector === "[data-approval-other]") return { value: other };
      return null;
    },
  };
}

test("Plan clarification answers are collected from the approval card around the submit button", async () => {
  const { collectAnswers } = await approvalFormApi();
  const fields = [
    question("interface", { selected: "Web" }),
    question("scope", { selected: "Кратко", other: "Полный план" }),
  ];
  const approval = {
    querySelectorAll(selector) {
      assert.equal(selector, "[data-approval-question]");
      return fields;
    },
  };
  const submitButton = {
    dataset: { approvalId: "approval-1" },
    closest(selector) {
      assert.equal(selector, ".approval");
      return approval;
    },
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(collectAnswers(submitButton))),
    { interface: ["Web"], scope: ["Полный план"] },
  );
});

test("URL MCP approval exposes one action that opens the link and continues", async () => {
  const { approvalOptions } = await approvalFormApi();
  assert.deepEqual(JSON.parse(JSON.stringify(approvalOptions({
    kind: "mcp-elicitation",
    canAccept: true,
    canAllowSession: false,
    url: "https://example.test/sign-in",
  }))), [
    {
      id: "once",
      label: "Открыть и продолжить",
      kind: "primary",
      href: "https://example.test/sign-in",
    },
    { id: "decline", label: "Отклонить", kind: "danger" },
  ]);
});

test("async questions follow their Stream across rotation while ordinary approvals follow run identity", async () => {
  const { approvalsForTask, approvalOptions } = await approvalFormApi();
  const approvals = [
    { key: "a", kind: "async-user-input", streamId: "a", threadId: "old-thread" },
    { key: "b", kind: "async-user-input", streamId: "b" },
    { key: "run-a", kind: "command", runId: "run-a" },
    { key: "run-b", kind: "command", runId: "run-b" },
    { key: "legacy", kind: "command" },
  ];
  const selected = approvalsForTask(approvals, { streamId: "a", threadId: "new-thread", run: { id: "run-a" } });
  assert.deepEqual(Array.from(selected, (value) => value.id), ["a", "run-a"]);
  assert.deepEqual(Array.from(approvalsForTask(approvals, { streamId: "b" }), (value) => value.id), ["b"]);
  assert.deepEqual(Array.from(approvalOptions({ kind: "async-user-input", state: "pending" }), (value) => value.id), ["decline"]);
  assert.equal(approvalOptions({ kind: "async-user-input", state: "dispatching" }).length, 0);
});
