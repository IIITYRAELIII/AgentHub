import { codexExplicitFinalTurnAnswer, codexFinalTurnAnswer } from "../../application/task-history.mjs";

export function codexTurnAnswerItems(turn) {
  const items = turn?.items ?? [];
  const finalItem = items.findLast((item) => codexExplicitFinalTurnAnswer({ items: [item] }));
  if (finalItem) return [finalItem];
  return items
    .filter((item) => ["agentMessage", "plan"].includes(item?.type) && String(item.text ?? "").trim())
    .filter((item) => !(Array.isArray(item.questions) && item.questions.length))
    .filter((item) => !["analysis", "commentary", "reasoning"].includes(String(item.phase ?? "").trim()));
}

export function codexTurnAnswer(turn) {
  const finalAnswer = codexExplicitFinalTurnAnswer(turn);
  if (finalAnswer) return finalAnswer;
  // Commentary already belongs to the turn's activity groups. It cannot also
  // become the answer body when an observation refreshes the live projection.
  // Unphased legacy messages retain their existing recovery representation.
  return codexTurnAnswerItems(turn)
    .map((item) => String(item.text).trim())
    .join("\n\n")
    .trim();
}

export function codexRolloutLatestAnswer(activity, turnId) {
  const item = activity?.latestAgentMessages?.[turnId];
  return item
    ? codexTurnAnswer({ items: [item] })
    : String(activity?.latestMessages?.[turnId] ?? "").trim();
}

export function lastCompletedCodexAnswer(turns) {
  const completed = (Array.isArray(turns) ? turns : [])
    .findLast((turn) => turn?.status === "completed" && codexFinalTurnAnswer(turn));
  return completed ? codexFinalTurnAnswer(completed) : "";
}
