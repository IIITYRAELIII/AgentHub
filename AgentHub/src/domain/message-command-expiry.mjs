import { taskRunIsActive } from "./task-runs.mjs";

export const MESSAGE_COMMAND_LIFETIME_MS = 72 * 60 * 60 * 1_000;

// A command may be a steer/alias of the managed turn's root message. Protect
// exact execution identities as well as the messages explicitly held by it.
export function messageCommandMatchesRun(record, run) {
  if (!taskRunIsActive(run)) return false;
  const id = String(record.clientUserMessageId ?? "");
  if (id && [run.clientUserMessageId, ...(Array.isArray(run.userMessages) ? run.userMessages : [])
    .map((item) => item.clientUserMessageId)]
    .some((value) => String(value ?? "") === id)) return true;
  const result = record.result ?? record.receipt?.result ?? {};
  const provider = String(result.provider ?? record.item?.provider ?? record.receipt?.provider ?? "");
  const threadId = String(result.threadId ?? record.item?.threadId ?? record.receipt?.threadId ?? "");
  if (!provider || !threadId || provider !== run.provider || threadId !== run.threadId) return false;
  return Boolean((result.runId && result.runId === run.id)
    || (result.turnId && result.turnId === run.turnId));
}
