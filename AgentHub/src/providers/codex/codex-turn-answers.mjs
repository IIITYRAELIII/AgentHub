import { codexFinalTurnAnswer } from "../../application/task-history.mjs";

export function codexTurnAnswer(turn) {
  return (turn?.items ?? [])
    .filter((item) => ["agentMessage", "plan"].includes(item?.type) && String(item.text ?? "").trim())
    .map((item) => String(item.text).trim())
    .join("\n\n")
    .trim();
}

export function lastCompletedCodexAnswer(turns) {
  const completed = (Array.isArray(turns) ? turns : [])
    .findLast((turn) => turn?.status === "completed" && codexFinalTurnAnswer(turn));
  return completed ? codexFinalTurnAnswer(completed) : "";
}
