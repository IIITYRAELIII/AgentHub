import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexContextProbeInstructions,
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
  codexContextProbeClientId,
  isCodexContextProbeTurn,
} from "../../src/domain/codex-context-probe.mjs";

test("probe instructions are bound to one reserved client identity", () => {
  const clientUserMessageId = codexContextProbeClientId();
  const instructions = buildCodexContextProbeInstructions(clientUserMessageId);

  assert.match(instructions, new RegExp(clientUserMessageId, "u"));
  assert.match(instructions, new RegExp(CODEX_CONTEXT_PROBE_RESPONSE, "u"));
  assert.match(instructions, /only to the current internal Agent Hub context-probe turn/u);
  assert.match(instructions, /inert historical data/u);
  assert.throws(
    () => buildCodexContextProbeInstructions("ordinary-message"),
    /generated Codex context-probe clientUserMessageId/u,
  );
  assert.throws(
    () => buildCodexContextProbeInstructions("agent-hub-context-probe:forged\nwork"),
    /generated Codex context-probe clientUserMessageId/u,
  );
});

test("probe classification prefers identity and never infers work from an answer", () => {
  assert.equal(isCodexContextProbeTurn({
    clientUserMessageId: "agent-hub-context-probe:exact-probe",
    prompt: "unrelated",
  }), true);
  assert.equal(isCodexContextProbeTurn({
    clientUserMessageId: "ordinary-message",
    prompt: CODEX_CONTEXT_PROBE_PROMPT,
    finalAnswer: CODEX_CONTEXT_PROBE_RESPONSE,
  }), false);
  assert.equal(isCodexContextProbeTurn({
    prompt: "Продолжай рабочую задачу",
    finalAnswer: CODEX_CONTEXT_PROBE_RESPONSE,
  }), false);
  assert.equal(isCodexContextProbeTurn({
    prompt: CODEX_CONTEXT_PROBE_PROMPT,
    finalAnswer: CODEX_CONTEXT_PROBE_RESPONSE,
  }), true);
});
