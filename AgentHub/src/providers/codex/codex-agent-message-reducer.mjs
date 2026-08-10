const MAX_AGENT_MESSAGES = 64;

function normalizedId(value) {
  return String(value ?? "").trim();
}

function isResponseItem(item) {
  return item?.type === "agentMessage" || item?.type === "plan";
}

function agentMessageText(item) {
  return typeof item?.text === "string" ? item.text : "";
}

function agentMessagePhase(item) {
  if (item?.type === "plan") return "final_answer";
  return String(item?.phase ?? "").trim() || null;
}

function agentMessages(run) {
  if (!Array.isArray(run.responseItems)) run.responseItems = [];
  run.responseItems = run.responseItems
    .filter((item) => isResponseItem(item) && normalizedId(item.id))
    .slice(-MAX_AGENT_MESSAGES);
  return run.responseItems;
}

function messageId({ itemId, turnId }) {
  return normalizedId(itemId) || `legacy:${normalizedId(turnId) || "unknown"}`;
}

function upsertAgentMessage(run, reference, defaults = {}) {
  const items = agentMessages(run);
  const id = messageId(reference);
  let item = items.find((candidate) => candidate.id === id);
  if (!item) {
    item = { id, type: defaults.type ?? "agentMessage", text: "", phase: null, status: "inProgress" };
    items.push(item);
    if (items.length > MAX_AGENT_MESSAGES) items.shift();
  }
  Object.assign(item, defaults, {
    id,
    type: defaults.type ?? item.type ?? "agentMessage",
    turnId: normalizedId(reference.turnId) || item.turnId || null,
  });
  return item;
}

function selectedAgentMessage(items) {
  const populated = items.filter((item) => String(item.text ?? "").length > 0);
  const final = populated.filter((item) => item.phase === "final_answer" || item.phase === "finalAnswer");
  return final.at(-1) ?? populated.at(-1) ?? items.at(-1) ?? null;
}

function synchronizeResponse(run) {
  const selected = selectedAgentMessage(agentMessages(run));
  if (!selected) return null;
  run.responseItemId = selected.id;
  run.responseText = String(selected.text ?? "");
  return selected;
}

function replaySuffix(current, delta) {
  if (!delta || current.endsWith(delta)) return "";
  const maximum = Math.min(current.length, delta.length);
  for (let length = maximum; length > 0; length -= 1) {
    if (current.endsWith(delta.slice(0, length))) return delta.slice(length);
  }
  return delta;
}

export function startCodexAgentMessage(run, { turnId = null, item = null } = {}) {
  if (!run || !isResponseItem(item)) return null;
  const phase = agentMessagePhase(item);
  const message = upsertAgentMessage(run, { turnId, itemId: item.id }, {
    type: item.type, ...(phase ? { phase } : {}), status: "inProgress",
  });
  const text = agentMessageText(item);
  if (text) message.text = text;
  synchronizeResponse(run);
  return message;
}

export function appendCodexAgentMessageDelta(run, {
  turnId = null,
  itemId = null,
  delta = "",
  hydrationReplay = false,
} = {}) {
  if (!run) return null;
  const message = upsertAgentMessage(run, { turnId, itemId });
  const value = String(delta ?? "");
  message.text += hydrationReplay ? replaySuffix(message.text, value) : value;
  message.status = "inProgress";
  synchronizeResponse(run);
  return message;
}

export function completeCodexAgentMessage(run, { turnId = null, item = null } = {}) {
  if (!run || !isResponseItem(item)) return null;
  const phase = agentMessagePhase(item);
  const message = upsertAgentMessage(run, { turnId, itemId: item.id }, {
    type: item.type, ...(phase ? { phase } : {}), status: "completed",
  });
  if (typeof item.text === "string") message.text = item.text;
  synchronizeResponse(run);
  return message;
}

export function hydrateCodexAgentMessages(run, items = [], { turnId = null } = {}) {
  if (!run) return null;
  const messages = (Array.isArray(items) ? items : [])
    .filter((item) => isResponseItem(item) && normalizedId(item.id));
  if (!messages.length) return synchronizeResponse(run);
  run.responseItems = messages.slice(-MAX_AGENT_MESSAGES).map((item) => ({
    id: normalizedId(item.id),
    type: item.type,
    turnId: normalizedId(turnId) || null,
    text: agentMessageText(item),
    phase: agentMessagePhase(item),
    status: String(item.status ?? "completed"),
  }));
  return synchronizeResponse(run);
}
