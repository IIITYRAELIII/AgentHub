import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../../assets/web-app/bug-report-flow.js", import.meta.url), "utf8");
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const flow = context.window.AgentHubBugReportFlow;

test("bug report remains visible while Git publication is pending", () => {
  assert.deepEqual({ ...flow.pending() }, {
    sending: true,
    formHidden: false,
    expanded: true,
    status: "Создаём отчёт и отправляем его в Git…",
    statusState: "pending",
    focus: false,
  });
});

test("failed publication keeps the draft form open and focusable", () => {
  assert.deepEqual({ ...flow.complete({ error: "Сеть недоступна" }) }, {
    sending: false,
    formHidden: false,
    expanded: true,
    status: "Сеть недоступна",
    statusState: "error",
    focus: true,
  });
});

test("successful publication closes the form", () => {
  assert.deepEqual({ ...flow.complete({ pushed: true }) }, {
    sending: false,
    formHidden: true,
    expanded: false,
    status: "",
    statusState: "",
    focus: false,
  });
});
