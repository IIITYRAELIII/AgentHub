import assert from "node:assert/strict";
import test from "node:test";

import { createRunShellComposition } from "../../src/composition/run-shell-composition.mjs";

function bindingPort() {
  return {
    value: null,
    bind(value) {
      this.value = value;
      return value;
    },
  };
}

test("run shell owns diff persistence and binds presentation/admission ports", async () => {
  const telegramDelivery = bindingPort();
  const runAdmission = bindingPort();
  const deferredInput = bindingPort();
  const runShell = bindingPort();
  const persisted = [];
  const selectedDiffs = [];
  const run = { id: "run-1", gitBaseline: {}, latestDiff: "old" };

  const shell = createRunShellComposition({
    presentation: {
      telegramLimit: 4096,
      claudeModelLabels: {},
      codexReasoningLabels: {},
      codexModelLabel: (value) => value,
      taskExecutionRuntimeLabel: () => "HUB",
      formatProgressHeading: () => "heading",
      formatProgressHeartbeat: () => "heartbeat",
      showProject: () => false,
      runTaskTitle: () => "Task",
      runProject: () => ({ name: "Project" }),
      agentPreferences: {},
      taskExecutionOwners: {},
      dataDir: ".",
      appendMessageBindings: async () => {},
      readMessageBindings: async () => [],
      removeMessageBindings: async () => {},
      approvalController: { pending: new Map() },
      samePath: (left, right) => left === right,
      taskRuns: { forTask: () => run },
      telegram: async () => ({}),
      sendMessageTo: async () => ({}),
      deliveryOutbox: {},
      scheduleDeliveryOutboxFlush: () => {},
      taskRunKey: () => "task-1",
      mediaController: { rememberSpeechText: () => {} },
      taskViewCallbackData: () => "view",
      managedRunLifecycle: { complete: async () => {} },
      runJournal: { rememberLastMessage: () => {} },
      rememberLastSeenTurn: () => {},
      selectedTask: () => ({}),
      activeTaskTitle: () => "Task",
      activeProjectName: () => "Project",
      taskSwitchSettings: () => ({}),
      showLastMessageReplyMarkup: () => ({}),
      formatTaskSwitchMessage: () => "switch",
      formatTaskAlreadySelectedMessage: () => "selected",
      saveState: async () => {},
      retainProgressMessageAfterEditError: () => false,
    },
    admission: {
      config: { deferredInputTtlHours: 1 },
      samePath: (left, right) => left === right,
      sendRpc: async () => ({ data: [] }),
      contextCompactions: { isManualTurn: () => false },
      codexUsageTracker: new Map(),
      turnSpeechButtons: new Map(),
      turnTemporaryFiles: new Map(),
      managedRunLifecycle: { complete: async () => {} },
      agentProviders: { call: async () => ({ state: "inactive" }) },
      taskRuns: { forTask: () => null },
      runCoordinator: { start: async () => ({}), startDeferred: async () => ({}) },
      runConflictPolicy: { check: async () => false },
      pendingInputs: new Map(),
      queuedInputs: new Map(),
      getSelectedTask: () => ({}),
      getActiveThreadTitle: () => "Task",
      getChatId: () => 1,
      taskExecutionOwners: {},
      deferredInputPresentation: {
        updateTelegramMessage: async () => {},
        updateDesktopReceipt: async () => {},
      },
      sendMessageTo: async () => {},
      saveState: async () => {},
    },
    diff: {
      capture: async () => "new diff",
      dataDir: ".",
      persist: async (...args) => persisted.push(args),
      taskKey: () => "task-1",
      isSelected: () => true,
      setSelected: (value) => selectedDiffs.push(value),
    },
    ports: { telegramDelivery, runAdmission, deferredInput, runShell },
  });

  assert.equal(telegramDelivery.value, shell.telegramDeliveryService);
  assert.equal(runAdmission.value.deferredInputController, shell.deferredInputController);
  assert.equal(deferredInput.value, shell.deferredInputController);
  assert.equal(runShell.value.refreshTaskDiff, shell.refreshTaskDiff);
  assert.equal(await shell.refreshTaskDiff(run), "new diff");
  assert.deepEqual(persisted, [["task-1", "new diff"]]);
  assert.deepEqual(selectedDiffs, ["new diff"]);
});
