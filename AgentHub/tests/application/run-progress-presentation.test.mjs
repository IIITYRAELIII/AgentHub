import assert from "node:assert/strict";
import test from "node:test";
import { RunProgressPresentation } from "../../src/application/run-progress-presentation.mjs";

function presentation(overrides = {}) {
  return new RunProgressPresentation({
    telegramLimit: 4_096,
    claudeModelLabels: { opus: "Opus" },
    codexReasoningLabels: { high: "High" },
    codexModelLabel: (value) => `model:${value}`,
    taskExecutionRuntimeLabel: (value) => `runtime:${value}`,
    formatProgressHeading: (value) => JSON.stringify(value),
    formatProgressHeartbeat: () => "heartbeat",
    showProject: () => false,
    taskTitle: () => "Task",
    projectName: () => "Project",
    currentCodexModel: () => "sol",
    currentClaudeModel: () => "opus",
    currentCodexReasoning: () => "high",
    currentClaudeReasoning: () => "high",
    taskExecutionOwners: { VSCODE: "vscode", HUB: "hub" },
    ...overrides,
  });
}

test("managed Codex heading resolves current model and HUB runtime", () => {
  const value = JSON.parse(presentation().heading({ provider: "codex" }));
  assert.deepEqual(value, {
    done: false,
    provider: "Codex",
    model: "model:sol",
    reasoning: "High",
    runtime: "runtime:hub",
    task: "Task",
    project: null,
  });
});

test("observed Claude heading keeps explicit model and external runtime", () => {
  const value = JSON.parse(presentation({ showProject: () => true }).heading({
    provider: "claude",
    observer: true,
    model: "Opus 5",
    reasoning: "Observed",
  }));
  assert.equal(value.provider, "Claude Code");
  assert.equal(value.model, "Opus 5");
  assert.equal(value.reasoning, "Observed");
  assert.equal(value.runtime, "Внешний Claude CLI");
  assert.equal(value.project, "Project");
});

test("render includes live details and removes them from terminal card", () => {
  const run = {
    provider: "codex",
    progressStage: "Working",
    progressReasoning: "Reason",
    responseText: "Answer",
    activeTurnCount: 2,
  };
  const live = presentation().render(run);
  assert.match(live, /Активных ходов.*2/);
  assert.match(live, /heartbeat/);
  assert.match(live, /Reason/);
  assert.match(live, /Answer/);
  const done = presentation().render(run, true);
  assert.match(done, /Working/);
  assert.doesNotMatch(done, /heartbeat|Reason|Answer/);
});
