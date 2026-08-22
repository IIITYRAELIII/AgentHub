import { randomUUID } from "node:crypto";

const APPROVAL_ACTIONS = new Set(["once", "session", "decline"]);

export function createApprovalKey() {
  return randomUUID();
}

export function approvalCallbackData(key, action) {
  if (!APPROVAL_ACTIONS.has(action)) throw new Error(`unknown approval action: ${action}`);
  const normalizedKey = String(key ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalizedKey)) {
    throw new Error("invalid approval key");
  }
  return `a:${normalizedKey}:${action}`;
}

export function parseApprovalCallback(value) {
  const match = /^a:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(once|session|decline)$/i.exec(String(value ?? ""));
  return match ? { key: match[1].toLowerCase(), action: match[2] } : null;
}

export function approvalMatchesTelegramMessage(approval, callback) {
  return Number.isSafeInteger(approval?.chatId)
    && Number.isSafeInteger(approval?.messageId)
    && callback?.message?.chat?.id === approval.chatId
    && callback?.message?.message_id === approval.messageId;
}

export function codexApprovalResponse(kind, action, params = {}) {
  if (kind === "permissions") {
    return {
      permissions: action === "decline" ? {} : (params.permissions ?? {}),
      scope: action === "session" ? "session" : "turn",
    };
  }

  return {
    decision: action === "once"
      ? "accept"
      : action === "session"
        ? "acceptForSession"
        : "decline",
  };
}

export function formatPermissionsApproval(params = {}) {
  const reason = String(params.reason ?? "").trim();
  const cwd = String(params.cwd ?? "").trim();
  const permissions = JSON.stringify(params.permissions ?? {}, null, 2);
  const parts = ["Codex запрашивает дополнительные разрешения."];
  if (cwd) parts.push(`Каталог: ${cwd}`);
  if (reason) parts.push(`Причина: ${reason}`);
  parts.push(`Запрашиваемый доступ:\n${permissions}`);
  return parts.join("\n\n").slice(0, 3500);
}

function elicitationEnumValues(schema = {}) {
  if (Array.isArray(schema.enum)) return schema.enum;
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  return variants.map((item) => item?.const).filter((value) => value !== undefined);
}

function affirmativeElicitationValue(schema = {}) {
  const values = elicitationEnumValues(schema);
  return values.find((value) => /^(?:1|true|yes|allow|approve|accept|ok|да|разреш)/iu.test(String(value)))
    ?? null;
}

export function mcpElicitationAutoResponse(params = {}) {
  if (params.mode !== "form" || params.requestedSchema?.type !== "object") return null;
  const properties = params.requestedSchema.properties ?? {};
  const required = Array.isArray(params.requestedSchema.required)
    ? params.requestedSchema.required
    : [];
  const content = {};

  for (const [name, schema] of Object.entries(properties)) {
    if (schema?.default !== undefined && schema.default !== null) content[name] = schema.default;
  }
  for (const name of required) {
    if (Object.hasOwn(content, name)) continue;
    const schema = properties[name] ?? {};
    if (schema.type === "boolean") {
      content[name] = true;
      continue;
    }
    const affirmative = affirmativeElicitationValue(schema);
    if (affirmative !== null) {
      content[name] = affirmative;
      continue;
    }
    return null;
  }
  return { action: "accept", content };
}

export function mcpElicitationUrl(params = {}) {
  if (params.mode !== "url") return "";
  try {
    const url = new URL(String(params.url ?? "").trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

export function mcpElicitationAcceptResponse(params = {}) {
  if (mcpElicitationUrl(params)) return { action: "accept" };
  return mcpElicitationAutoResponse(params);
}

export function formatMcpElicitation(params = {}) {
  const parts = ["MCP запрашивает подтверждение или дополнительные данные."];
  if (params.serverName) parts.push(`Сервер: ${params.serverName}`);
  if (params.message) parts.push(String(params.message));
  if (params.mode === "url" && params.url) parts.push(`Ссылка: ${params.url}`);
  if (params.mode === "form") {
    const properties = params.requestedSchema?.properties ?? {};
    const required = new Set(params.requestedSchema?.required ?? []);
    const fields = Object.entries(properties).map(([name, schema]) => {
      const title = String(schema?.title ?? name);
      const marker = required.has(name) ? "обязательно" : "необязательно";
      const description = schema?.description ? ` — ${schema.description}` : "";
      return `• ${title} (${marker})${description}`;
    });
    if (fields.length) parts.push(`Поля:\n${fields.join("\n")}`);
  }
  return parts.join("\n\n").slice(0, 3500);
}

export function formatToolRequestUserInput(params = {}) {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const rows = questions.map((question, index) => {
    const header = String(question?.header ?? `Вопрос ${index + 1}`).trim();
    const prompt = String(question?.question ?? "").trim();
    const options = (question?.options ?? [])
      .map((option) => String(option?.label ?? "").trim())
      .filter(Boolean);
    return [`${index + 1}. ${header}`, prompt, options.length ? `Варианты: ${options.join(" · ")}` : ""]
      .filter(Boolean)
      .join("\n");
  });
  return ["Codex ожидает ваш ответ, чтобы продолжить ход.", ...rows].join("\n\n").slice(0, 3500);
}

export function codexToolUserInputResponse(params = {}, submitted = {}) {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const source = submitted && typeof submitted === "object" ? submitted : {};
  const answers = {};
  for (const question of questions) {
    const id = String(question?.id ?? "").trim();
    if (!id) continue;
    const raw = Array.isArray(source[id]) ? source[id] : [source[id]];
    const values = raw.map((value) => String(value ?? "").trim()).filter(Boolean);
    if (!values.length && params.isBlocking !== false) {
      throw new Error(`Ответьте на вопрос «${question.header || question.question || id}»`);
    }
    answers[id] = { answers: values };
  }
  return { answers };
}

export function codexThreadWaitingOnApproval(status) {
  return status?.type === "active"
    && Array.isArray(status.activeFlags)
    && status.activeFlags.includes("waitingOnApproval");
}
