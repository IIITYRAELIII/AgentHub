import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function approvalFormApi() {
  const source = await readFile(
    new URL("../../assets/mini-app/approval-form.js", import.meta.url),
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
