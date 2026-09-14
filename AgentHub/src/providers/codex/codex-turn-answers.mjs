import { codexExplicitFinalTurnAnswer, codexFinalTurnAnswer } from "../../application/task-history.mjs";

export function codexTurnAnswer(turn) {
  const finalAnswer = codexExplicitFinalTurnAnswer(turn);
  if (finalAnswer) return finalAnswer;
  // Commentary already belongs to the turn's activity groups. It cannot also
  // become the answer body when an observation refreshes the live projection.
  // Unphased legacy messages retain their existing recovery representation.
  return (turn?.items ?? [])
    .filter((item) => ["agentMessage", "plan"].includes(item?.type) && String(item.text ?? "").trim())
    .filter((item) => !(Array.isArray(item.questions) && item.questions.length))
    .filter((item) => !["analysis", "commentary", "reasoning"].includes(String(item.phase ?? "").trim()))
    .map((item) => String(item.text).trim())
    .join("\n\n")
    .trim();
}

export function lastCompletedCodexAnswer(turns) {
  const completed = (Array.isArray(turns) ? turns : [])
    .findLast((turn) => turn?.status === "completed" && codexFinalTurnAnswer(turn));
  return completed ? codexFinalTurnAnswer(completed) : "";
}
