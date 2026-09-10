import { userDisplayText } from "../../domain/user-message-display.mjs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncSqliteMutationQueue } from "./async-sqlite-mutation-queue.mjs";

import { catalogTaskKey } from "../../domain/task-catalog-identity.mjs";
import { rebaseActiveCodexUsers } from "../../domain/canonical-user-messages.mjs";
import { withoutClaudeManagedTranscriptDuplicates } from "../../domain/claude-transcript.mjs";
import {
  interstreamOriginAuthor,
  normalizeInterstreamOrigin,
} from "../../domain/interstream-message.mjs";
import { normalizedCodexResponseAnnotationReferences } from "../../domain/codex-response-annotation.mjs";
import { normalizedResponseAnnotations } from "../../domain/response-annotation-source.mjs";
import {
  indexedDurableMessageMetadata,
  withDurableMessageMetadata,
} from "../../domain/stream-message-pin.mjs";

const FORMAT_VERSION = 1;
const TASK_SCHEMA_VERSION = 12;
const MODEL_BACKFILL_VERSION = "1";
const SUBAGENT_MODEL_BACKFILL_VERSION = "1";
const SEARCH_BACKFILL_VERSION = "4";
const TERMINAL_HISTORY_BACKFILL_VERSION = "4";
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_RUNNING_FRESHNESS_MS = 10 * 60 * 1000;
const DEFAULT_TASK_LIMIT = 1_000;
const TERMINAL_IDENTITY_RECOVERY_LIMIT = 200;
const TERMINAL_IDENTITY_RECOVERY_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;
const TERMINAL_IDENTITY_RECOVERY_TOTAL_BYTES = 4 * 1024 * 1024;
const TERMINAL_IDENTITY_RECOVERY_INSPECTION_BYTES = 8 * 1024 * 1024;

function cleanText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function persistedCodexSubagentAuthor(model) {
  const value = cleanText(model, 100);
  if (!value) return "Субагент (модель неизвестна)";
  const family = /(?:^|[-_/])(sol|terra|luna)(?:$|[-_/])/iu.exec(value)?.[1];
  const name = family
    ? `${family[0].toUpperCase()}${family.slice(1).toLowerCase()}`
    : value.replace(/^gpt-/iu, "GPT-");
  return `Субагент (${name})`;
}

function cleanAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .slice(-8)
    .flatMap((attachment) => {
      if (attachment?.kind === "task") {
        const taskId = cleanText(attachment.taskId, 300);
        if (!taskId) return [];
        return [{
          kind: "task",
          taskId,
          title: cleanText(attachment.title, 160) || "Task",
          workflowStatus: cleanText(attachment.workflowStatus, 40) || "new",
          workspaceId: cleanText(attachment.workspaceId, 300) || null,
          intent: cleanText(attachment.intent, 20) || "context",
        }];
      }
      const id = cleanText(attachment?.id, 300);
      return id ? [{
        id,
        name: cleanText(attachment?.name, 300),
        type: cleanText(attachment?.type, 100),
      }] : [];
    });
}

function cleanResponseAnnotations(annotations) {
  return normalizedResponseAnnotations(annotations);
}

function cleanResponseAnnotationReferences(references) {
  return normalizedCodexResponseAnnotationReferences(references);
}

function cleanActivities(activities) {
  return (Array.isArray(activities) ? activities : [])
    .map((activity) => ({
      id: cleanText(activity?.id, 200),
      type: cleanText(activity?.type, 40),
      label: cleanText(activity?.label, 500),
      detail: cleanText(activity?.detail, 4_000),
      status: cleanText(activity?.status, 40),
      ...(activity?.time ? { time: cleanText(activity.time, 80) } : {}),
    }))
    .filter((activity) => activity.id || activity.label);
}

function cleanActivityGroups(groups) {
  return (Array.isArray(groups) ? groups : []).flatMap((group, index) => {
    const reasoning = cleanText(group?.reasoning, 40_000);
    const activities = cleanActivities(group?.activities);
    if (!reasoning && !activities.length) return [];
    return [{
      id: cleanText(group?.id, 200) || `group:${index}`,
      reasoning,
      activities,
    }];
  });
}

function withoutPromptlessAnswerEchoes(history) {
  const values = [];
  for (const item of history) {
    const previous = values.at(-1);
    const hasUserMessage = item.messages.some((message) => message.role === "user");
    const duplicateAnswer = Boolean(
      item.completed
      && previous?.completed
      && item.answer
      && item.answer === previous.answer
    );
    if (!item.prompt && !hasUserMessage && duplicateAnswer) continue;
    values.push(item);
  }
  return values;
}

function withoutRepeatedClientMessages(history) {
  const seen = new Set();
  return history.map((turn) => ({
    ...turn,
    messages: turn.messages.filter((message) => {
      const id = String(message?.clientUserMessageId ?? "").trim();
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  }));
}

function withoutInternalContextTurns(history) {
  return history.filter((turn) => (
    !String(turn?.prompt ?? "").trim().startsWith("<codex_internal_context")
    && turn?.operationKind !== "probe" && turn?.contextProbe !== true
  ));
}

function preserveUserDisplay(existingHistory, history, task) {
  const displays = new Map();
  for (const turn of existingHistory ?? []) {
    for (const message of turn.messages ?? []) {
      const identity = { provider: task.provider, threadId: task.threadId, clientUserMessageId: message.clientUserMessageId };
      if (message.role === "user" && userDisplayText(message.userDisplay, identity) !== null) {
        displays.set(message.clientUserMessageId, message.userDisplay);
      }
    }
  }
  return (history ?? []).map((turn) => ({ ...turn, messages: (turn.messages ?? []).map((message) => {
    const display = message.role === "user" ? displays.get(message.clientUserMessageId) : null;
    return display ? { ...message, userDisplay: structuredClone(display) } : message;
  }) }));
}

function cleanHistory(history, limit, { provider = "" } = {}) {
  const source = String(provider).trim().toLowerCase() === "claude"
    ? withoutClaudeManagedTranscriptDuplicates(history)
    : (Array.isArray(history) ? history : []);
  const cleaned = source
    .map((item) => {
      const promptOrigin = normalizeInterstreamOrigin(item?.promptOrigin);
      const promptAuthor = interstreamOriginAuthor(promptOrigin)
        || cleanText(item?.promptAuthor, 1_000);
      const sourceMessages = Array.isArray(item?.messages) ? item.messages : [];
      const messagesTruncated = sourceMessages.length > 100;
      return {
        id: cleanText(item?.id, 100),
        ...(item?.operationKind ? { operationKind: cleanText(item.operationKind, 40) } : {}),
        ...(item?.contextProbe === true ? { contextProbe: true } : {}),
        prompt: cleanText(item?.prompt, 12_000),
        ...(promptAuthor ? { promptAuthor } : {}),
        ...(promptOrigin ? { promptOrigin } : {}),
        answer: cleanText(item?.answer, 40_000),
        status: cleanText(item?.status, 40),
        active: item?.active === true,
        completed: item?.completed === true,
        ...(item?.userMessageAuthority === "terminal-ledger"
          ? { userMessageAuthority: "terminal-ledger" }
          : {}),
        ...(item?.userMessageSnapshotAuthority === "complete" && !messagesTruncated
          ? { userMessageSnapshotAuthority: "complete" }
          : {}),
        promptAnnotations: cleanResponseAnnotations(item?.promptAnnotations),
        ...(cleanText(item?.promptRequest, 12_000)
          ? { promptRequest: cleanText(item.promptRequest, 12_000) }
          : {}),
        ...(item?.startedAt ? { startedAt: cleanText(item.startedAt, 80) } : {}),
        ...(item?.completedAt ? { completedAt: cleanText(item.completedAt, 80) } : {}),
        attachments: cleanAttachments(item?.attachments),
        activities: cleanActivities(item?.activities),
        ...(cleanActivityGroups(item?.activityGroups).length
          ? { activityGroups: cleanActivityGroups(item.activityGroups) }
          : {}),
        messages: sourceMessages
        .slice(-100)
        .flatMap((message) => {
          const role = cleanText(message?.role, 20);
          const text = cleanText(message?.text, role === "agent" ? 40_000 : 12_000);
          if (!["user", "agent"].includes(role) || !text) return [];
          const itemId = cleanText(message?.itemId, 200);
          const kind = cleanText(message?.kind, 40);
          const rawAuthor = cleanText(message?.author, 1_000);
          const agentThreadId = cleanText(message?.agentThreadId, 100);
          const hasSubagentMetadata = kind === "subagent"
            || agentThreadId
            || /^Субагент(?:\s*·|\s*\()/iu.test(rawAuthor);
          const misattributedSubagent = role === "agent"
            && hasSubagentMetadata
            && kind !== "subagent"
            && !agentThreadId
            && !itemId.includes(":subagent:");
          const origin = !misattributedSubagent && role === "user"
            ? normalizeInterstreamOrigin(message?.origin)
            : null;
          const author = interstreamOriginAuthor(origin) || rawAuthor;
          return [{
            itemId,
            ...(message?.clientUserMessageId
              ? { clientUserMessageId: cleanText(message.clientUserMessageId, 200) }
              : {}),
            ...(message?.sourceOccurrenceId
              ? { sourceOccurrenceId: cleanText(message.sourceOccurrenceId, 200) }
              : {}),
            role,
            text,
            ...(role === "user" && userDisplayText(message.userDisplay, {
              provider, threadId: message.userDisplay?.threadId,
              clientUserMessageId: message.clientUserMessageId,
            }) !== null ? { userDisplay: { ...message.userDisplay, text: cleanText(message.userDisplay.text, 12_000) } } : {}),
            ...(!misattributedSubagent && author
              ? { author }
              : {}),
            ...(!misattributedSubagent && (origin || kind)
              ? { kind: origin ? "interstream" : kind }
              : {}),
            ...(origin ? { origin } : {}),
            ...(!misattributedSubagent && agentThreadId
              ? { agentThreadId }
              : {}),
            ...(!misattributedSubagent && cleanText(message?.model, 100)
              ? { model: cleanText(message.model, 100) }
              : {}),
            ...(message?.phase ? { phase: cleanText(message.phase, 40) } : {}),
            ...(message?.time ? { time: cleanText(message.time, 80) } : {}),
            responseAnnotations: cleanResponseAnnotations(message?.responseAnnotations),
            ...(cleanResponseAnnotationReferences(message?.responseAnnotationReferences).length
              ? {
                responseAnnotationReferences: cleanResponseAnnotationReferences(
                  message.responseAnnotationReferences,
                ),
              }
              : {}),
            ...(cleanText(message?.responseAnnotationRequest, 12_000)
              ? { responseAnnotationRequest: cleanText(message.responseAnnotationRequest, 12_000) }
              : {}),
            attachments: cleanAttachments(message?.attachments),
          }];
        }),
      };
    });
  const normalized = withoutRepeatedClientMessages(cleaned);
  return withoutPromptlessAnswerEchoes(withoutInternalContextTurns(normalized)).slice(-limit);
}

const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "interrupted",
  "aborted",
  "cancelled",
  "canceled",
]);

function terminalHistoryTurns(history) {
  const terminals = new Map();
  for (const turn of Array.isArray(history) ? history : []) {
    const id = String(turn?.id ?? "").trim();
    const status = String(turn?.status ?? "").trim().toLowerCase();
    if (id && (turn?.completed === true || TERMINAL_TURN_STATUSES.has(status))) {
      terminals.set(id, structuredClone(turn));
    }
  }
  return terminals;
}

function preserveTerminalHistory(terminals, history) {
  return (Array.isArray(history) ? history : []).map((turn) => {
    const terminal = terminals.get(String(turn?.id ?? "").trim());
    const status = String(turn?.status ?? "").trim().toLowerCase();
    const incomingIsTerminal = turn?.completed === true || TERMINAL_TURN_STATUSES.has(status);
    if (terminal?.userMessageAuthority === "terminal-ledger" && incomingIsTerminal) {
      return {
        ...turn,
        prompt: terminal.prompt,
        promptAuthor: terminal.promptAuthor,
        promptOrigin: terminal.promptOrigin,
        promptAnnotations: terminal.promptAnnotations,
        promptRequest: terminal.promptRequest,
        attachments: terminal.attachments,
        userMessageAuthority: "terminal-ledger",
        messages: [
          ...(Array.isArray(terminal.messages) ? terminal.messages : [])
            .filter((message) => message?.role === "user")
            .map((message) => structuredClone(message)),
          ...(Array.isArray(turn?.messages) ? turn.messages : [])
            .filter((message) => message?.role !== "user")
            .map((message) => structuredClone(message)),
        ],
      };
    }
    return terminal && !incomingIsTerminal ? structuredClone(terminal) : turn;
  });
}

function canonicalTerminalAgentSource(existingMessages, turnId, incomingMessage) {
  if (incomingMessage?.role !== "agent") return null;
  const incomingItemId = String(incomingMessage?.itemId ?? "").trim();
  if (![`${turnId}:agent:final`, `${turnId}:rollout-agent:final`].includes(incomingItemId)) {
    return null;
  }
  const exactSyntheticIds = [
    `${turnId}:agent:live`,
    `${turnId}:agent:final`,
    `${turnId}:rollout-agent:live`,
    `${turnId}:rollout-agent:final`,
  ];
  const candidates = existingMessages.filter((message) => {
    if (message?.role !== "agent" || message?.kind === "subagent") return false;
    if (String(message?.agentThreadId ?? "").trim()) return false;
    if (!cleanResponseAnnotationReferences(message?.responseAnnotationReferences).length) return false;
    const itemId = String(message?.itemId ?? "").trim();
    return exactSyntheticIds.includes(itemId) || itemId.startsWith("msg_");
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function preserveDurableResponseAnnotationReferences(existingHistory, incomingHistory) {
  const existingTurns = new Map((Array.isArray(existingHistory) ? existingHistory : []).flatMap((turn) => {
    const id = String(turn?.id ?? "").trim();
    return id ? [[id, turn]] : [];
  }));
  return (Array.isArray(incomingHistory) ? incomingHistory : []).map((turn) => {
    const existingTurn = existingTurns.get(String(turn?.id ?? "").trim());
    if (!existingTurn) return turn;
    const byItemId = new Map();
    for (const message of Array.isArray(existingTurn.messages) ? existingTurn.messages : []) {
      const itemId = String(message?.itemId ?? "").trim();
      if (itemId) byItemId.set(itemId, message);
    }
    const next = { ...turn };
    if (Array.isArray(turn?.messages)) {
      next.messages = turn.messages.map((message) => {
        const itemId = String(message?.itemId ?? "").trim();
        const existingMessage = itemId ? byItemId.get(itemId) : null;
        const terminalSource = existingMessage ?? canonicalTerminalAgentSource(
          Array.isArray(existingTurn.messages) ? existingTurn.messages : [],
          String(turn?.id ?? "").trim(),
          message,
        );
        const responseAnnotationReferences = cleanResponseAnnotationReferences(
          message?.responseAnnotationReferences,
        ).length
          ? message.responseAnnotationReferences
          : terminalSource?.responseAnnotationReferences;
        return {
          ...message,
          ...(cleanResponseAnnotationReferences(responseAnnotationReferences).length
            ? { responseAnnotationReferences }
            : {}),
        };
      });
    }
    return next;
  });
}

function preserveDurableAttachments(existingHistory, incomingHistory) {
  const existingTurns = new Map((Array.isArray(existingHistory) ? existingHistory : []).flatMap((turn) => {
    const id = String(turn?.id ?? "").trim();
    return id ? [[id, turn]] : [];
  }));
  return (Array.isArray(incomingHistory) ? incomingHistory : []).map((turn) => {
    const existingTurn = existingTurns.get(String(turn?.id ?? "").trim());
    if (!existingTurn) return turn;
    const byItemId = new Map();
    const byClientId = new Map();
    for (const message of Array.isArray(existingTurn.messages) ? existingTurn.messages : []) {
      const itemId = String(message?.itemId ?? "").trim();
      const clientId = String(message?.clientUserMessageId ?? "").trim();
      if (itemId) byItemId.set(itemId, message);
      if (clientId) byClientId.set(clientId, message);
    }
    const next = { ...turn };
    if (!(Array.isArray(turn?.attachments) && turn.attachments.length)
      && Array.isArray(existingTurn.attachments) && existingTurn.attachments.length) {
      next.attachments = existingTurn.attachments;
    }
    if (Array.isArray(turn?.messages)) {
      next.messages = turn.messages.map((message) => {
        const itemId = String(message?.itemId ?? "").trim();
        const clientId = String(message?.clientUserMessageId ?? "").trim();
        const existingMessage = (clientId ? byClientId.get(clientId) : null)
          ?? (itemId ? byItemId.get(itemId) : null);
        if (!existingMessage || (Array.isArray(message?.attachments) && message.attachments.length)) {
          return message;
        }
        return { ...message, attachments: existingMessage.attachments };
      });
    }
    return next;
  });
}

function preserveDurableChronology(existingHistory, incomingHistory) {
  const existingTurns = new Map((Array.isArray(existingHistory) ? existingHistory : []).flatMap((turn) => {
    const id = String(turn?.id ?? "").trim();
    return id ? [[id, turn]] : [];
  }));
  return (Array.isArray(incomingHistory) ? incomingHistory : []).map((turn) => {
    const existingTurn = existingTurns.get(String(turn?.id ?? "").trim());
    if (!existingTurn) return turn;
    const existingMessages = new Map((Array.isArray(existingTurn.messages) ? existingTurn.messages : [])
      .flatMap((message) => {
        const itemId = String(message?.itemId ?? "").trim();
        const role = String(message?.role ?? "").trim();
        return itemId && role ? [[`${role}\0${itemId}`, message]] : [];
      }));
    const next = { ...turn };
    if (!turn?.startedAt && existingTurn?.startedAt) next.startedAt = existingTurn.startedAt;
    if (!turn?.completedAt && existingTurn?.completedAt) next.completedAt = existingTurn.completedAt;
    if (Array.isArray(turn?.messages)) {
      next.messages = turn.messages.map((message) => {
        if (message?.time) return message;
        const itemId = String(message?.itemId ?? "").trim();
        const role = String(message?.role ?? "").trim();
        const existingMessage = itemId && role ? existingMessages.get(`${role}\0${itemId}`) : null;
        return existingMessage?.time ? { ...message, time: existingMessage.time } : message;
      });
    }
    return next;
  });
}

function terminalSafeSnapshot(existing, snapshot, terminals) {
  const turnId = String(snapshot?.turnId ?? "").trim();
  if (snapshot?.active !== true || !turnId || !terminals.has(turnId)) return snapshot;

  const existingTurnId = String(existing?.turnId ?? "").trim();
  if (existing?.running === true && existingTurnId && !terminals.has(existingTurnId)) {
    return {
      active: true,
      turnId: existingTurnId,
      executionOwner: existing.executionOwner,
      activityAtMs: existing.lastActivityAtMs,
      stage: existing.stage,
      answer: existing.answer,
    };
  }

  return {
    active: false,
    turnId: "",
    executionOwner: null,
    activityAtMs: existing?.lastActivityAtMs,
    stage: existing?.stage,
    answer: existing?.answer,
  };
}

function persistedTask(value = {}, canonicalizeProjectRoot = (projectRoot) => projectRoot) {
  const provider = cleanText(value.provider, 20).toLowerCase();
  const threadId = cleanText(value.threadId, 100);
  if (!provider || !threadId) return null;
  const projectRoot = cleanText(value.projectRoot, 2_000);
  return {
    provider,
    threadId,
    projectRoot: cleanText(canonicalizeProjectRoot(projectRoot), 2_000),
    projectName: cleanText(value.projectName, 200),
    sessionCwd: cleanText(value.sessionCwd, 2_000) || null,
    title: cleanText(value.title ?? value.taskTitle, 200),
    model: cleanText(value.model ?? value.modelLabel, 100) || null,
    updatedAtMs: Number(value.updatedAtMs) || 0,
    running: value.running === true,
    executionOwner: cleanText(value.executionOwner, 40) || null,
    turnId: cleanText(value.turnId, 100) || null,
    lastActivityAtMs: Number(value.lastActivityAtMs) || null,
    stage: cleanText(value.stage, 1_000),
    answer: cleanText(value.answer, 40_000),
    syncedAtMs: Number(value.syncedAtMs) || 0,
    history: cleanHistory(value.history, DEFAULT_HISTORY_LIMIT, { provider }),
  };
}

function taskMetadata(value = {}) {
  const { history: _history, syncedAtMs: _syncedAtMs, ...metadata } = value;
  return metadata;
}

function taskMetadataChanged(previous, next) {
  return JSON.stringify(taskMetadata(previous)) !== JSON.stringify(taskMetadata(next));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function exactLedgerTerminalBinding(row, {
  provider,
  threadId,
  turnId,
  runId,
  clientUserMessageId,
}) {
  if (!row || String(row.client_user_message_id ?? "").trim() !== clientUserMessageId) return false;
  if (!TERMINAL_TURN_STATUSES.has(String(row.state ?? "").trim().toLowerCase())) return false;
  const item = parseJsonObject(row.item_json);
  const receipt = parseJsonObject(row.receipt_json);
  const receiptResult = parseJsonObject(receipt.result);
  const result = parseJsonObject(row.result_json);
  const allExact = (field, expected, normalize = (value) => value) => {
    const values = [result, receiptResult, receipt, item]
      .map((value) => String(value?.[field] ?? "").trim())
      .filter(Boolean)
      .map(normalize);
    return values.length > 0 && values.every((value) => value === normalize(expected));
  };
  return allExact("provider", provider, (value) => value.toLowerCase())
    && allExact("threadId", threadId)
    && allExact("turnId", turnId)
    && Boolean(runId)
    && allExact("runId", runId);
}

function recoverTerminalTurnMessages(turn, terminalPayload, ledgerStatement, identity) {
  const history = terminalPayload?.history ?? {};
  const provider = String(identity?.provider ?? "").trim().toLowerCase();
  const threadId = String(identity?.threadId ?? "").trim();
  const turnId = String(identity?.turnId ?? "").trim();
  const runId = String(history?.id ?? "").trim();
  if (String(history?.provider ?? "").trim().toLowerCase() !== provider
    || String(history?.threadId ?? "").trim() !== threadId
    || String(history?.turnId ?? "").trim() !== turnId) return turn;
  const authoritativeUsers = Array.isArray(history.userMessages)
    ? history.userMessages.filter((message) => message?.role !== "agent")
    : [];
  const ids = authoritativeUsers
    .map((message) => String(message?.clientUserMessageId ?? "").trim())
    .filter(Boolean);
  if (!ids.length || new Set(ids).size !== ids.length) return turn;
  if (!ids.every((clientUserMessageId) => exactLedgerTerminalBinding(
    ledgerStatement.get(clientUserMessageId),
    { provider, threadId, turnId, runId, clientUserMessageId },
  ))) return turn;

  const currentMessages = Array.isArray(turn?.messages) ? turn.messages : [];
  const currentAgents = currentMessages.filter((message) => message?.role !== "user");
  return {
    ...turn,
    userMessageAuthority: "terminal-ledger",
    ...(String(history.promptPreview ?? "").trim() ? { prompt: history.promptPreview } : {}),
    messages: [
      ...authoritativeUsers.map((message) => structuredClone(message)),
      ...currentAgents.map((message) => structuredClone(message)),
    ],
  };
}

function normalizedSearchTerms(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .split(/\s+/u)
    .map((term) => term.replaceAll('"', "").trim())
    .filter(Boolean);
}

function ftsSearchQuery(value) {
  return normalizedSearchTerms(value)
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

function compactSearchSnippet(value, terms, limit = 220) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text || text.length <= limit) return text;
  const normalized = text.normalize("NFKC").toLocaleLowerCase("ru-RU");
  const first = terms
    .map((term) => normalized.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, Math.min(first - Math.floor(limit / 3), text.length - limit));
  const end = Math.min(text.length, start + limit);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function searchDocumentKey({
  provider,
  threadId,
  turnId,
  itemId,
  role,
  source = "history",
  occurrence = "",
}) {
  return JSON.stringify([provider, threadId, turnId, itemId, role, source, String(occurrence)]);
}

function legacySearchDocumentKey({ provider, threadId, turnId, itemId, role }) {
  return JSON.stringify([provider, threadId, turnId, itemId, role]);
}

function parseInterstreamOrigin(value) {
  try {
    return normalizeInterstreamOrigin(JSON.parse(String(value ?? "{}")));
  } catch {
    return null;
  }
}

function searchHistoryFingerprint(history) {
  return createHash("sha256")
    .update(JSON.stringify(Array.isArray(history) ? history : []))
    .digest("hex");
}

function configure(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 0;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS task_read_model_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS task_read_model_tasks (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      project_name TEXT NOT NULL,
      session_cwd TEXT,
      title TEXT NOT NULL,
      model TEXT,
      updated_at_ms INTEGER NOT NULL,
      running INTEGER NOT NULL CHECK (running IN (0, 1)),
      execution_owner TEXT,
      turn_id TEXT,
      last_activity_at_ms INTEGER,
      stage TEXT NOT NULL,
      answer TEXT NOT NULL,
      synced_at_ms INTEGER NOT NULL,
      PRIMARY KEY (provider, thread_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS task_read_model_tasks_updated
      ON task_read_model_tasks (updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS task_read_model_tasks_activity
      ON task_read_model_tasks (last_activity_at_ms DESC);
    CREATE TABLE IF NOT EXISTS task_read_model_turns (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      answer TEXT NOT NULL,
      status TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
      started_at TEXT,
      completed_at TEXT,
      prompt_author TEXT NOT NULL DEFAULT '',
      prompt_origin_json TEXT NOT NULL DEFAULT '{}',
      prompt_annotations_json TEXT NOT NULL DEFAULT '[]',
      prompt_request TEXT NOT NULL DEFAULT '',
      attachments_json TEXT NOT NULL,
      activities_json TEXT NOT NULL,
      activity_groups_json TEXT NOT NULL DEFAULT '[]',
      user_message_authority TEXT NOT NULL DEFAULT '',
      user_message_snapshot_authority TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (provider, thread_id, position),
      FOREIGN KEY (provider, thread_id)
        REFERENCES task_read_model_tasks (provider, thread_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS task_read_model_turns_id
      ON task_read_model_turns (provider, thread_id, id);
    CREATE TABLE IF NOT EXISTS task_read_model_messages (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_position INTEGER NOT NULL,
      position INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      client_user_message_id TEXT,
      source_occurrence_id TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      text TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      origin_json TEXT NOT NULL DEFAULT '{}',
      kind TEXT NOT NULL DEFAULT '',
      agent_thread_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      phase TEXT,
      time TEXT,
      response_annotations_json TEXT NOT NULL DEFAULT '[]',
      response_annotation_request TEXT NOT NULL DEFAULT '',
      response_annotation_references_json TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_position, position),
      FOREIGN KEY (provider, thread_id, turn_position)
        REFERENCES task_read_model_turns (provider, thread_id, position) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS task_message_search_documents (
      id INTEGER PRIMARY KEY,
      document_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      message_text TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      annotation_text TEXT NOT NULL DEFAULT '',
      attachment_names TEXT NOT NULL DEFAULT '',
      occurred_at TEXT,
      occurred_at_ms INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL CHECK (source IN ('history', 'journal'))
    );
    CREATE INDEX IF NOT EXISTS task_message_search_identity
      ON task_message_search_documents(provider, thread_id, turn_id, item_id);
    CREATE INDEX IF NOT EXISTS task_message_search_time
      ON task_message_search_documents(occurred_at_ms DESC, document_key);
    CREATE TABLE IF NOT EXISTS task_message_search_threads (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'failed')),
      completed_at_ms INTEGER NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (provider, thread_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS task_message_search_inputs (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id)
    ) WITHOUT ROWID;
    CREATE VIRTUAL TABLE IF NOT EXISTS task_message_search_fts USING fts5(
      message_text,
      annotation_text,
      attachment_names,
      content='task_message_search_documents',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS task_message_search_insert AFTER INSERT ON task_message_search_documents BEGIN
      INSERT INTO task_message_search_fts(rowid, message_text, annotation_text, attachment_names)
      VALUES (new.id, new.message_text, new.annotation_text, new.attachment_names);
    END;
    CREATE TRIGGER IF NOT EXISTS task_message_search_delete AFTER DELETE ON task_message_search_documents BEGIN
      INSERT INTO task_message_search_fts(task_message_search_fts, rowid, message_text, annotation_text, attachment_names)
      VALUES ('delete', old.id, old.message_text, old.annotation_text, old.attachment_names);
    END;
    CREATE TRIGGER IF NOT EXISTS task_message_search_update AFTER UPDATE ON task_message_search_documents BEGIN
      INSERT INTO task_message_search_fts(task_message_search_fts, rowid, message_text, annotation_text, attachment_names)
      VALUES ('delete', old.id, old.message_text, old.annotation_text, old.attachment_names);
      INSERT INTO task_message_search_fts(rowid, message_text, annotation_text, attachment_names)
      VALUES (new.id, new.message_text, new.annotation_text, new.attachment_names);
    END;
  `);
  const taskColumns = new Set(database.prepare(
    "PRAGMA table_info(task_read_model_tasks)",
  ).all().map((column) => String(column.name)));
  if (!taskColumns.has("model")) {
    database.exec("ALTER TABLE task_read_model_tasks ADD COLUMN model TEXT");
  }
  const turnColumns = new Set(database.prepare(
    "PRAGMA table_info(task_read_model_turns)",
  ).all().map((column) => String(column.name)));
  if (!turnColumns.has("prompt_annotations_json")) {
    database.exec("ALTER TABLE task_read_model_turns ADD COLUMN prompt_annotations_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!turnColumns.has("prompt_request")) {
    database.exec("ALTER TABLE task_read_model_turns ADD COLUMN prompt_request TEXT NOT NULL DEFAULT ''");
  }
  if (!turnColumns.has("activity_groups_json")) {
    database.exec("ALTER TABLE task_read_model_turns ADD COLUMN activity_groups_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!turnColumns.has("user_message_authority")) {
    database.exec("ALTER TABLE task_read_model_turns ADD COLUMN user_message_authority TEXT NOT NULL DEFAULT ''");
  }
  if (!turnColumns.has("user_message_snapshot_authority")) {
    database.exec("ALTER TABLE task_read_model_turns ADD COLUMN user_message_snapshot_authority TEXT NOT NULL DEFAULT ''");
  }
  const messageColumns = new Set(database.prepare(
    "PRAGMA table_info(task_read_model_messages)",
  ).all().map((column) => String(column.name)));
  if (!messageColumns.has("source_occurrence_id")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN source_occurrence_id TEXT NOT NULL DEFAULT ''");
  }
  if (!messageColumns.has("response_annotations_json")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN response_annotations_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!messageColumns.has("response_annotation_request")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN response_annotation_request TEXT NOT NULL DEFAULT ''");
  }
  if (!messageColumns.has("response_annotation_references_json")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN response_annotation_references_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!messageColumns.has("display_text")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN display_text TEXT");
  }
  if (!turnColumns.has("prompt_author")) {
    database.exec("ALTER TABLE task_read_model_turns ADD COLUMN prompt_author TEXT NOT NULL DEFAULT ''");
  }
  if (!turnColumns.has("prompt_origin_json")) {
    database.exec("ALTER TABLE task_read_model_turns ADD COLUMN prompt_origin_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!messageColumns.has("author")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN author TEXT NOT NULL DEFAULT ''");
  }
  if (!messageColumns.has("origin_json")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN origin_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!messageColumns.has("kind")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN kind TEXT NOT NULL DEFAULT ''");
  }
  if (!messageColumns.has("agent_thread_id")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN agent_thread_id TEXT NOT NULL DEFAULT ''");
  }
  if (!messageColumns.has("model")) {
    database.exec("ALTER TABLE task_read_model_messages ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
  database.exec(`
    UPDATE task_read_model_messages
    SET author = '', kind = '', agent_thread_id = '', model = ''
    WHERE provider = 'codex'
      AND instr(item_id, ':subagent:') = 0
      AND kind <> 'subagent'
      AND trim(agent_thread_id) = ''
      AND (
        kind = 'subagent'
        OR trim(agent_thread_id) <> ''
        OR author LIKE 'Субагент (%'
        OR author LIKE 'Субагент ·%'
      );
    UPDATE task_read_model_messages
    SET role = 'agent',
        author = CASE WHEN trim(author) = '' THEN 'Субагент (модель неизвестна)' ELSE author END,
        kind = 'subagent',
        agent_thread_id = CASE
          WHEN trim(agent_thread_id) = ''
          THEN substr(item_id, instr(item_id, ':subagent:') + length(':subagent:'))
          ELSE agent_thread_id
        END
    WHERE provider = 'codex' AND instr(item_id, ':subagent:') > 0
  `);
  const searchColumns = new Set(database.prepare(
    "PRAGMA table_info(task_message_search_documents)",
  ).all().map((column) => String(column.name)));
  if (!searchColumns.has("author")) {
    database.exec("ALTER TABLE task_message_search_documents ADD COLUMN author TEXT NOT NULL DEFAULT ''");
  }
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS task_read_model_subagent_insert
    AFTER INSERT ON task_read_model_messages
    WHEN new.provider = 'codex' AND instr(new.item_id, ':subagent:') > 0
      AND (new.role != 'agent' OR new.kind != 'subagent'
        OR trim(new.author) = '' OR trim(new.agent_thread_id) = '')
    BEGIN
      UPDATE task_read_model_messages
      SET role = 'agent',
          author = CASE WHEN trim(author) = '' THEN 'Субагент (модель неизвестна)' ELSE author END,
          kind = 'subagent',
          agent_thread_id = CASE
            WHEN trim(agent_thread_id) = ''
            THEN substr(item_id, instr(item_id, ':subagent:') + length(':subagent:'))
            ELSE agent_thread_id
          END
      WHERE provider = new.provider AND thread_id = new.thread_id
        AND turn_position = new.turn_position AND position = new.position;
    END;
    CREATE TRIGGER IF NOT EXISTS task_read_model_subagent_update
    AFTER UPDATE OF item_id, role, author, kind, agent_thread_id ON task_read_model_messages
    WHEN new.provider = 'codex' AND instr(new.item_id, ':subagent:') > 0
      AND (new.role != 'agent' OR new.kind != 'subagent'
        OR trim(new.author) = '' OR trim(new.agent_thread_id) = '')
    BEGIN
      UPDATE task_read_model_messages
      SET role = 'agent',
          author = CASE WHEN trim(author) = '' THEN 'Субагент (модель неизвестна)' ELSE author END,
          kind = 'subagent',
          agent_thread_id = CASE
            WHEN trim(agent_thread_id) = ''
            THEN substr(item_id, instr(item_id, ':subagent:') + length(':subagent:'))
            ELSE agent_thread_id
          END
      WHERE provider = new.provider AND thread_id = new.thread_id
        AND turn_position = new.turn_position AND position = new.position;
    END;
    CREATE TRIGGER IF NOT EXISTS task_message_search_subagent_insert
    AFTER INSERT ON task_message_search_documents
    WHEN new.provider = 'codex' AND instr(new.item_id, ':subagent:') > 0
      AND (new.role != 'agent' OR trim(new.author) = '')
    BEGIN
      UPDATE task_message_search_documents
      SET role = 'agent',
          author = CASE WHEN trim(author) = '' THEN 'Субагент (модель неизвестна)' ELSE author END
      WHERE id = new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS task_message_search_subagent_update
    AFTER UPDATE OF item_id, role, author ON task_message_search_documents
    WHEN new.provider = 'codex' AND instr(new.item_id, ':subagent:') > 0
      AND (new.role != 'agent' OR trim(new.author) = '')
    BEGIN
      UPDATE task_message_search_documents
      SET role = 'agent',
          author = CASE WHEN trim(author) = '' THEN 'Субагент (модель неизвестна)' ELSE author END
      WHERE id = new.id;
    END;
  `);
  database.prepare(`
    INSERT INTO task_read_model_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(TASK_SCHEMA_VERSION));
}

function taskFromRow(row, history = []) {
  if (!row) return null;
  return {
    provider: String(row.provider),
    threadId: String(row.thread_id),
    projectRoot: String(row.project_root ?? ""),
    projectName: String(row.project_name ?? ""),
    sessionCwd: row.session_cwd ? String(row.session_cwd) : null,
    title: String(row.title ?? ""),
    model: row.model ? String(row.model) : null,
    updatedAtMs: Number(row.updated_at_ms) || 0,
    running: Number(row.running) === 1,
    executionOwner: row.execution_owner ? String(row.execution_owner) : null,
    turnId: row.turn_id ? String(row.turn_id) : null,
    lastActivityAtMs: Number(row.last_activity_at_ms) || null,
    stage: String(row.stage ?? ""),
    answer: String(row.answer ?? ""),
    syncedAtMs: Number(row.synced_at_ms) || 0,
    history,
  };
}

function normalizedHistoryReferences(references) {
  const known = new Set();
  return (Array.isArray(references) ? references : []).flatMap((reference, sourceOrder) => {
    const provider = cleanText(reference?.provider, 20).toLowerCase();
    const threadId = cleanText(reference?.threadId, 100);
    const key = `${provider}\0${threadId}`;
    if (!provider || !threadId || known.has(key)) return [];
    known.add(key);
    return [{ provider, threadId, sourceOrder }];
  });
}

function literalPrefixCondition(column, prefix, params) {
  const value = String(prefix ?? "").trim();
  if (!value) return "0";
  params.push(value, value);
  return `substr(${column}, 1, length(?)) = ?`;
}

function historyPageQuery(references, {
  hiddenProvider = "",
  hiddenTurnIdPrefixes = [],
  hiddenPrompts = [],
  hiddenAnswerPrefixes = [],
  hiddenClientUserMessageIdPrefixes = [],
  hiddenMessageTexts = [],
  hiddenMessageTextPrefixes = [],
  emptyCompletionText = "",
} = {}) {
  const params = [];
  const referenceSql = references.map((reference) => {
    params.push(reference.provider, reference.threadId, reference.sourceOrder);
    return "(?, ?, ?)";
  }).join(", ");
  const hidden = [];
  for (const prefix of hiddenTurnIdPrefixes) {
    hidden.push(literalPrefixCondition("turns.id", prefix, params));
  }
  for (const prompt of hiddenPrompts) {
    const value = String(prompt ?? "").trim();
    if (!value) continue;
    params.push(value);
    hidden.push("trim(turns.prompt) = ?");
  }
  for (const prefix of hiddenAnswerPrefixes) {
    hidden.push(literalPrefixCondition("trim(turns.answer)", prefix, params));
  }
  for (const prefix of hiddenClientUserMessageIdPrefixes) {
    const condition = literalPrefixCondition("messages.client_user_message_id", prefix, params);
    hidden.push(`EXISTS (
      SELECT 1 FROM task_read_model_messages messages
      WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
        AND messages.turn_position = turns.position AND ${condition}
    )`);
  }
  for (const text of hiddenMessageTexts) {
    const value = String(text ?? "").trim();
    if (!value) continue;
    params.push(value);
    hidden.push(`EXISTS (
      SELECT 1 FROM task_read_model_messages messages
      WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
        AND messages.turn_position = turns.position AND trim(messages.text) = ?
    )`);
  }
  for (const prefix of hiddenMessageTextPrefixes) {
    const condition = literalPrefixCondition("trim(messages.text)", prefix, params);
    hidden.push(`EXISTS (
      SELECT 1 FROM task_read_model_messages messages
      WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
        AND messages.turn_position = turns.position AND ${condition}
    )`);
  }
  const completionText = String(emptyCompletionText ?? "").trim();
  if (completionText) {
    params.push(completionText);
    hidden.push(`(
      trim(turns.prompt) = '' AND trim(turns.answer) = ?
      AND NOT EXISTS (
        SELECT 1 FROM task_read_model_messages messages
        WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
          AND messages.turn_position = turns.position AND messages.role = 'user'
          AND (trim(messages.text) <> '' OR messages.attachments_json <> '[]')
      )
    )`);
  }
  let visibleSql = "1";
  const provider = cleanText(hiddenProvider, 20).toLowerCase();
  if (provider && hidden.length) {
    params.push(provider);
    visibleSql = `NOT (turns.provider = ? AND (${hidden.join(" OR ")}))`;
    const providerParam = params.pop();
    params.splice(references.length * 3, 0, providerParam);
  }
  const messageCountSql = `
    (
      SELECT COUNT(*) FROM task_read_model_messages messages
      WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
        AND messages.turn_position = turns.position AND messages.role = 'user'
        AND (trim(messages.text) <> '' OR messages.attachments_json <> '[]'
          OR turns.attachments_json <> '[]')
    )
    + (
      SELECT COUNT(*) FROM task_read_model_messages messages
      WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
        AND messages.turn_position = turns.position AND messages.kind = 'subagent'
        AND (trim(messages.text) <> '' OR messages.attachments_json <> '[]')
    )
    + CASE WHEN (turns.completed = 1 OR turns.active = 0) AND EXISTS (
      SELECT 1 FROM task_read_model_messages messages
      WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
        AND messages.turn_position = turns.position AND messages.role = 'agent'
        AND messages.kind <> 'subagent'
        AND (trim(messages.text) <> '' OR messages.attachments_json <> '[]')
    ) THEN 1 ELSE 0 END
    + CASE WHEN trim(turns.prompt) <> '' AND NOT EXISTS (
      SELECT 1 FROM task_read_model_messages messages
      WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
        AND messages.turn_position = turns.position AND messages.role = 'user'
        AND (trim(messages.text) <> '' OR messages.attachments_json <> '[]'
          OR turns.attachments_json <> '[]')
    ) THEN 1 ELSE 0 END
    + CASE WHEN trim(turns.answer) <> '' AND (turns.completed = 1 OR turns.active = 0)
      AND NOT EXISTS (
        SELECT 1 FROM task_read_model_messages messages
        WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
          AND messages.turn_position = turns.position AND messages.role = 'agent'
          AND messages.kind <> 'subagent'
          AND (trim(messages.text) <> '' OR messages.attachments_json <> '[]')
      ) THEN 1 ELSE 0 END
  `;
  const cte = `WITH selected_threads(provider, thread_id, source_order) AS (
    VALUES ${referenceSql}
  ), base_turns AS (
    SELECT turns.provider, turns.thread_id, turns.position, selected_threads.source_order,
      COALESCE(
        julianday(turns.started_at),
        (
          SELECT MIN(candidate_time) FROM (
            SELECT julianday(messages.time) AS candidate_time
            FROM task_read_model_messages messages
            WHERE messages.provider = turns.provider AND messages.thread_id = turns.thread_id
              AND messages.turn_position = turns.position
            UNION ALL SELECT julianday(turns.completed_at)
          ) WHERE candidate_time IS NOT NULL
        )
      ) AS sort_time,
      ${messageCountSql} AS message_count
    FROM task_read_model_turns turns
    JOIN selected_threads ON selected_threads.provider = turns.provider
      AND selected_threads.thread_id = turns.thread_id
    WHERE ${visibleSql}
  ), turn_groups AS (
    SELECT base_turns.*,
      SUM(CASE WHEN sort_time IS NOT NULL THEN 1 ELSE 0 END) OVER (
        ORDER BY source_order, position ROWS UNBOUNDED PRECEDING
      ) AS previous_time_group,
      SUM(CASE WHEN sort_time IS NOT NULL THEN 1 ELSE 0 END) OVER (
        ORDER BY source_order DESC, position DESC ROWS UNBOUNDED PRECEDING
      ) AS next_time_group
    FROM base_turns
  ), visible_turns AS (
    SELECT turn_groups.*,
      COALESCE(
        sort_time,
        MAX(sort_time) OVER (PARTITION BY next_time_group),
        MAX(sort_time) OVER (PARTITION BY previous_time_group)
      ) AS chronology_anchor
    FROM turn_groups
  )`;
  return { cte, params };
}

export class LocalTaskSyncStore {
  #filePath;
  #databaseFile;
  #terminalDatabaseFile;
  #messageCommandDatabaseFile;
  #database = null;
  #historyLimit;
  #taskLimit;
  #canonicalizeProjectRoot;
  #canonicalizeValue;
  #mutations = new AsyncSqliteMutationQueue();
  #mutationTimeoutMs;
  #revision = 0;

  constructor({
    filePath,
    databaseFile = path.join(path.dirname(filePath), "journal.sqlite"),
    terminalDatabaseFile = path.join(path.dirname(databaseFile), "runtime.sqlite"),
    messageCommandDatabaseFile = path.join(path.dirname(databaseFile), "message-command-ledger.sqlite"),
    historyLimit = DEFAULT_HISTORY_LIMIT,
    taskLimit = DEFAULT_TASK_LIMIT,
    canonicalizeProjectRoot = (projectRoot) => projectRoot,
    canonicalizeValue = (value) => value,
    mutationTimeoutMs = 2_000,
  }) {
    this.#filePath = path.resolve(filePath);
    this.#databaseFile = path.resolve(databaseFile);
    this.#terminalDatabaseFile = path.resolve(terminalDatabaseFile);
    this.#messageCommandDatabaseFile = path.resolve(messageCommandDatabaseFile);
    this.#historyLimit = Math.max(1, Number(historyLimit) || DEFAULT_HISTORY_LIMIT);
    this.#taskLimit = Math.max(1, Number(taskLimit) || DEFAULT_TASK_LIMIT);
    this.#canonicalizeProjectRoot = canonicalizeProjectRoot;
    this.#canonicalizeValue = canonicalizeValue;
    this.#mutationTimeoutMs = mutationTimeoutMs;
  }

  async #open() {
    if (this.#database) return this.#database;
    await mkdir(path.dirname(this.#databaseFile), { recursive: true });
    return this.#mutations.run(() => {
      if (this.#database) return this.#database;
      let database;
      try {
        database = new DatabaseSync(this.#databaseFile);
        configure(database);
        this.#database = database;
        return database;
      } catch (error) {
        database?.close();
        throw error;
      }
    }, { timeoutMs: this.#mutationTimeoutMs });
  }

  #taskRow(task) {
    return this.#database.prepare(`
      SELECT * FROM task_read_model_tasks WHERE provider = ? AND thread_id = ?
    `).get(cleanText(task?.provider, 20).toLowerCase(), cleanText(task?.threadId, 100));
  }

  #readHistory(task, limit = this.#historyLimit) {
    const provider = cleanText(task?.provider, 20).toLowerCase();
    const threadId = cleanText(task?.threadId, 100);
    if (!provider || !threadId) return [];
    const safeLimit = Math.max(1, Math.min(
      Math.floor(Number(limit) || this.#historyLimit),
      this.#historyLimit,
    ));
    const turns = this.#database.prepare(`
      SELECT * FROM (
        SELECT * FROM task_read_model_turns
        WHERE provider = ? AND thread_id = ?
        ORDER BY position DESC
        LIMIT ?
      ) ORDER BY position
    `).all(provider, threadId, safeLimit);
    return this.#hydrateHistoryRows(turns);
  }

  #hydrateHistoryRows(turns) {
    if (!turns.length) return [];
    const identities = turns.map(() => "(?, ?, ?)").join(", ");
    const messages = this.#database.prepare(`
      SELECT * FROM task_read_model_messages
      WHERE (provider, thread_id, turn_position) IN (${identities})
      ORDER BY provider, thread_id, turn_position, position
    `).all(...turns.flatMap((row) => [row.provider, row.thread_id, Number(row.position)]));
    const messagesByTurn = new Map();
    for (const row of messages) {
      const key = `${row.provider}\0${row.thread_id}\0${Number(row.turn_position)}`;
      const turnMessages = messagesByTurn.get(key) ?? [];
      const origin = parseInterstreamOrigin(row.origin_json);
      const responseAnnotationReferences = cleanResponseAnnotationReferences(
        parseJsonArray(row.response_annotation_references_json),
      );
      turnMessages.push({
        itemId: String(row.item_id ?? ""),
        ...(row.client_user_message_id
          ? { clientUserMessageId: String(row.client_user_message_id) }
          : {}),
        ...(row.source_occurrence_id
          ? { sourceOccurrenceId: String(row.source_occurrence_id) }
          : {}),
        role: String(row.role),
        text: String(row.text),
        ...(row.role === "user" && row.client_user_message_id && typeof row.display_text === "string"
          ? { userDisplay: { provider: row.provider, threadId: row.thread_id,
            clientUserMessageId: row.client_user_message_id, text: row.display_text } } : {}),
        ...(row.author ? { author: String(row.author) } : {}),
        ...(origin ? { origin } : {}),
        ...(row.kind ? { kind: String(row.kind) } : {}),
        ...(row.agent_thread_id ? { agentThreadId: String(row.agent_thread_id) } : {}),
        ...(row.model ? { model: String(row.model) } : {}),
        ...(row.phase ? { phase: String(row.phase) } : {}),
        ...(row.time ? { time: String(row.time) } : {}),
        responseAnnotations: cleanResponseAnnotations(parseJsonArray(row.response_annotations_json)),
        ...(responseAnnotationReferences.length
          ? { responseAnnotationReferences }
          : {}),
        ...(row.response_annotation_request
          ? { responseAnnotationRequest: String(row.response_annotation_request) }
          : {}),
        attachments: parseJsonArray(row.attachments_json),
      });
      messagesByTurn.set(key, turnMessages);
    }
    return turns.map((row) => {
      const promptOrigin = parseInterstreamOrigin(row.prompt_origin_json);
      return withDurableMessageMetadata({
        id: String(row.id ?? ""),
        prompt: String(row.prompt ?? ""),
        ...(row.prompt_author ? { promptAuthor: String(row.prompt_author) } : {}),
        ...(promptOrigin ? { promptOrigin } : {}),
        answer: String(row.answer ?? ""),
        status: String(row.status ?? ""),
        active: Number(row.active) === 1,
        completed: Number(row.completed) === 1,
        ...(row.user_message_authority === "terminal-ledger"
          ? { userMessageAuthority: "terminal-ledger" }
          : {}),
        ...(row.user_message_snapshot_authority === "complete"
          ? { userMessageSnapshotAuthority: "complete" }
          : {}),
        ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
        ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
        promptAnnotations: cleanResponseAnnotations(parseJsonArray(row.prompt_annotations_json)),
        ...(row.prompt_request ? { promptRequest: String(row.prompt_request) } : {}),
        attachments: parseJsonArray(row.attachments_json),
        activities: parseJsonArray(row.activities_json),
        ...(parseJsonArray(row.activity_groups_json).length
          ? { activityGroups: parseJsonArray(row.activity_groups_json) }
          : {}),
        messages: messagesByTurn.get(`${row.provider}\0${row.thread_id}\0${Number(row.position)}`) ?? [],
      }, { provider: row.provider, threadId: row.thread_id });
    });
  }

  #readTask(task, withHistory = false) {
    const row = this.#taskRow(task);
    return taskFromRow(row, withHistory ? this.#readHistory(task) : []);
  }

  #latestJournalModel(task, { missingJournalOkay = true } = {}) {
    const provider = cleanText(task?.provider, 20).toLowerCase();
    const threadId = cleanText(task?.threadId, 100);
    if (!provider || !threadId) return null;
    let rows;
    try {
      rows = this.#database.prepare(`
        SELECT record_json FROM journal_records
        WHERE provider = ? AND thread_id = ?
        ORDER BY completed_at_ms DESC
        LIMIT 100
      `).all(provider, threadId);
    } catch (error) {
      if (missingJournalOkay && /no such table:\s*journal_records/iu.test(String(error?.message ?? ""))) {
        return null;
      }
      throw error;
    }
    for (const row of rows) {
      if (!row?.record_json) continue;
      let record;
      try { record = JSON.parse(String(row.record_json)); } catch { continue; }
      const model = cleanText(record?.model, 100);
      if (model) return model;
    }
    return null;
  }

  #withJournalSubagentModels(task, history, { missingJournalOkay = true } = {}) {
    const provider = cleanText(task?.provider, 20).toLowerCase();
    if (!provider) return history;
    const models = new Map();
    let changed = false;
    const hydrated = (Array.isArray(history) ? history : []).map((turn) => ({
      ...turn,
      messages: (Array.isArray(turn?.messages) ? turn.messages : []).map((message) => {
        if (message?.kind !== "subagent") return message;
        const threadId = cleanText(message?.agentThreadId, 100);
        if (!threadId) return message;
        let model = cleanText(message?.model, 100);
        if (!model) {
          if (!models.has(threadId)) {
            models.set(threadId, this.#latestJournalModel(
              { provider, threadId },
              { missingJournalOkay },
            ));
          }
          model = cleanText(models.get(threadId), 100);
        }
        if (!model) return message;
        const author = persistedCodexSubagentAuthor(model);
        if (message.model === model && message.author === author) return message;
        changed = true;
        return { ...message, model, author };
      }),
    }));
    return changed ? hydrated : history;
  }

  #reconcileHistoryWithJournal(task, history, { missingJournalOkay = true } = {}) {
    const provider = cleanText(task?.provider, 20).toLowerCase();
    const threadId = cleanText(task?.threadId, 100);
    const turns = Array.isArray(history) ? history : [];
    const turnIds = [...new Set(turns.map((turn) => cleanText(turn?.id, 100)).filter(Boolean))];
    if (!provider || !threadId || !turnIds.length) return turns;
    const placeholders = turnIds.map(() => "?").join(", ");
    let rows;
    try {
      rows = this.#database.prepare(`
        SELECT turn_id, record_json FROM journal_records
        WHERE provider = ?
          AND (task_thread_id = ? OR thread_id = ?)
          AND turn_id IN (${placeholders})
      `).all(provider, threadId, threadId, ...turnIds);
    } catch (error) {
      if (missingJournalOkay && /no such table:\s*journal_records/iu.test(String(error?.message ?? ""))) {
        return turns;
      }
      throw error;
    }
    const terminals = new Map();
    for (const row of rows) {
      let record;
      try { record = JSON.parse(String(row.record_json ?? "{}")); } catch { continue; }
      const status = cleanText(record?.status, 40);
      if (!TERMINAL_TURN_STATUSES.has(status.toLowerCase())) continue;
      terminals.set(String(row.turn_id), record);
    }
    if (!terminals.size) return turns;
    return turns.map((turn) => {
      const record = terminals.get(String(turn?.id ?? "").trim());
      if (!record) return turn;
      return {
        ...turn,
        prompt: cleanText(record.prompt, 12_000) || turn.prompt,
        answer: turn.answer || cleanText(record.body ?? record.text, 40_000),
        status: cleanText(record.status, 40),
        active: false,
        completed: true,
        ...(record.startedAt ? { startedAt: cleanText(record.startedAt, 80) } : {}),
        ...(record.completedAt ? { completedAt: cleanText(record.completedAt, 80) } : {}),
      };
    });
  }

  #backfillTerminalHistoryFromJournal() {
    const tasks = this.#database.prepare(
      "SELECT provider, thread_id FROM task_read_model_tasks",
    ).all();
    for (const row of tasks) {
      const existing = this.#readTask({ provider: row.provider, threadId: row.thread_id }, true);
      if (!existing) continue;
      const repairedHistory = cleanHistory(this.#reconcileHistoryWithJournal(
        existing,
        existing.history,
        { missingJournalOkay: false },
      ), this.#historyLimit, { provider: row.provider });
      const terminals = terminalHistoryTurns(repairedHistory);
      const effectiveSnapshot = terminalSafeSnapshot(existing, {
        active: existing.running === true,
        turnId: existing.turnId,
        executionOwner: existing.executionOwner,
        activityAtMs: existing.lastActivityAtMs,
        stage: existing.stage,
        answer: existing.answer,
      }, terminals);
      const next = {
        ...existing,
        running: effectiveSnapshot.active === true,
        executionOwner: effectiveSnapshot.executionOwner,
        turnId: effectiveSnapshot.turnId,
        lastActivityAtMs: effectiveSnapshot.activityAtMs,
        stage: effectiveSnapshot.stage,
        answer: effectiveSnapshot.answer,
        history: repairedHistory,
      };
      const historyChanged = JSON.stringify(existing.history) !== JSON.stringify(repairedHistory);
      const metadataChanged = taskMetadataChanged(existing, next);
      if (metadataChanged) this.#writeTask(next);
      if (historyChanged) {
        this.#writeHistory(next, repairedHistory);
        this.#writeSearchHistory(next, repairedHistory);
      }
    }
  }

  #recoverTerminalCommandIdentities(references = null) {
    if (!existsSync(this.#terminalDatabaseFile) || !existsSync(this.#messageCommandDatabaseFile)) {
      return 0;
    }
    let terminalDatabase;
    let ledgerDatabase;
    try {
      terminalDatabase = new DatabaseSync(this.#terminalDatabaseFile, { readOnly: true });
      ledgerDatabase = new DatabaseSync(this.#messageCommandDatabaseFile, { readOnly: true });
      const hasTerminals = terminalDatabase.prepare(`
        SELECT 1 AS present FROM sqlite_schema
        WHERE type = 'table' AND name = 'provider_turn_terminals'
      `).get();
      const hasLedger = ledgerDatabase.prepare(`
        SELECT 1 AS present FROM sqlite_schema
        WHERE type = 'table' AND name = 'message_commands'
      `).get();
      if (!hasTerminals || !hasLedger) return 0;
      const terminalColumns = new Set(terminalDatabase
        .prepare("PRAGMA table_info(provider_turn_terminals)").all()
        .map((column) => String(column.name)));
      const ledgerColumns = new Set(ledgerDatabase
        .prepare("PRAGMA table_info(message_commands)").all()
        .map((column) => String(column.name)));
      if (!["provider", "thread_id", "turn_id", "payload_json", "payload_bytes", "committed_at"]
        .every((column) => terminalColumns.has(column))
        || !["client_user_message_id", "state", "item_json", "receipt_json", "result_json"]
          .every((column) => ledgerColumns.has(column))) return 0;
      const recoveryIndexColumns = terminalDatabase
        .prepare("PRAGMA index_info(provider_turn_terminals_recovery_idx)").all()
        .map((column) => String(column.name));
      if (JSON.stringify(recoveryIndexColumns) !== JSON.stringify([
        "committed_at", "provider", "thread_id", "turn_id", "payload_bytes",
      ])) return 0;
      const candidateByIdentity = references ? terminalDatabase.prepare(`
        SELECT provider, thread_id, turn_id, committed_at, payload_bytes
        FROM provider_turn_terminals
        WHERE provider = ? AND thread_id = ? AND turn_id = ?
      `) : null;
      const candidates = references
        ? references.map((reference) => candidateByIdentity.get(
          reference.provider, reference.threadId, reference.turnId,
        )).filter(Boolean)
        : terminalDatabase.prepare(`
        SELECT provider, thread_id, turn_id,
          committed_at, payload_bytes
        FROM provider_turn_terminals INDEXED BY provider_turn_terminals_recovery_idx
        ORDER BY committed_at DESC, provider, thread_id, turn_id
        LIMIT ?
      `).all(TERMINAL_IDENTITY_RECOVERY_LIMIT);
      const payloadByRow = terminalDatabase.prepare(`
        SELECT payload_json FROM provider_turn_terminals
        WHERE provider = ? AND thread_id = ? AND turn_id = ?
      `);
      const ledger = ledgerDatabase.prepare(`
        SELECT client_user_message_id, state, item_json, receipt_json, result_json
        FROM message_commands WHERE client_user_message_id = ?
      `);
      const histories = new Map();
      let recovered = 0;
      let inspectedBytes = 0;
      let acceptedBytes = 0;
      for (const candidate of candidates) {
        const payloadBytes = Number(candidate.payload_bytes) || 0;
        if (payloadBytes <= 0
          || payloadBytes > TERMINAL_IDENTITY_RECOVERY_PAYLOAD_MAX_BYTES
          || inspectedBytes + payloadBytes > TERMINAL_IDENTITY_RECOVERY_INSPECTION_BYTES) {
          continue;
        }
        const payloadJson = payloadByRow.get(
          candidate.provider,
          candidate.thread_id,
          candidate.turn_id,
        )?.payload_json;
        inspectedBytes += payloadBytes;
        let terminalPayload = null;
        try {
          const parsed = JSON.parse(String(payloadJson ?? ""));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            terminalPayload = parsed;
          }
        } catch {
          // Malformed terminal evidence is skipped without consuming the valid
          // payload admission budget.
        }
        if (!terminalPayload) continue;
        if (acceptedBytes + payloadBytes > TERMINAL_IDENTITY_RECOVERY_TOTAL_BYTES) continue;
        acceptedBytes += payloadBytes;
        const provider = String(candidate.provider);
        const threadId = String(candidate.thread_id);
        const turnId = String(candidate.turn_id);
        // Page recovery re-reads the exact durable turn inside the writer lane.
        // It must neither scan the Thread nor overwrite another page/position.
        if (references) {
          const rows = this.#database.prepare(`
            SELECT * FROM task_read_model_turns
            WHERE provider = ? AND thread_id = ? AND id = ?
          `).all(provider, threadId, turnId);
          if (rows.length !== 1 || Number(rows[0].completed) !== 1
            || Number(rows[0].active) === 1 || rows[0].user_message_authority === "terminal-ledger") continue;
          const [turn] = this.#hydrateHistoryRows(rows);
          const nextTurn = recoverTerminalTurnMessages(
            turn, terminalPayload, ledger, { provider, threadId, turnId },
          );
          if (nextTurn === turn) continue;
          const cleaned = cleanHistory([nextTurn], 1, { provider });
          this.#writeHistory({ provider, threadId }, cleaned, [Number(rows[0].position)]);
          // Invalidate the whole-Thread search fingerprint; update only this
          // turn's history documents, leaving journal and other turns intact.
          this.#writeSearchHistory({ provider, threadId }, cleaned, "");
          recovered += 1;
          continue;
        }
        const key = `${provider}\0${threadId}`;
        const history = histories.get(key) ?? this.#readHistory({ provider, threadId });
        histories.set(key, history);
        const position = history.findIndex((turn) => String(turn?.id ?? "").trim() === turnId);
        if (position < 0) continue;
        const nextTurn = recoverTerminalTurnMessages(
          history[position],
          terminalPayload,
          ledger,
          { provider, threadId, turnId },
        );
        if (JSON.stringify(nextTurn) === JSON.stringify(history[position])) continue;
        history[position] = nextTurn;
        recovered += 1;
      }
      for (const [key, history] of histories) {
        const [provider, threadId] = key.split("\0");
        const task = this.#readTask({ provider, threadId }, true);
        if (!task) continue;
        const cleaned = cleanHistory(history, this.#historyLimit, { provider });
        if (JSON.stringify(task.history) === JSON.stringify(cleaned)) continue;
        const next = { ...task, history: cleaned };
        this.#writeTask(next);
        this.#writeHistory(next, cleaned);
        this.#writeSearchHistory(next, cleaned);
      }
      return recovered;
    } finally {
      terminalDatabase?.close();
      ledgerDatabase?.close();
    }
  }

  #backfillModelsFromJournal() {
    const tasks = this.#database.prepare(`
      SELECT provider, thread_id FROM task_read_model_tasks
      WHERE model IS NULL OR trim(model) = ''
    `).all();
    const update = this.#database.prepare(`
      UPDATE task_read_model_tasks SET model = ?
      WHERE provider = ? AND thread_id = ?
    `);
    for (const task of tasks) {
      const model = this.#latestJournalModel({
        provider: task.provider,
        threadId: task.thread_id,
      }, { missingJournalOkay: false });
      if (model) update.run(model, task.provider, task.thread_id);
    }
  }

  #writeTask(task) {
    this.#database.prepare(`
      INSERT INTO task_read_model_tasks (
        provider, thread_id, project_root, project_name, session_cwd, title,
        model, updated_at_ms, running, execution_owner, turn_id,
        last_activity_at_ms, stage, answer, synced_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, thread_id) DO UPDATE SET
        project_root = excluded.project_root,
        project_name = excluded.project_name,
        session_cwd = excluded.session_cwd,
        title = excluded.title,
        model = COALESCE(excluded.model, task_read_model_tasks.model),
        updated_at_ms = excluded.updated_at_ms,
        running = excluded.running,
        execution_owner = excluded.execution_owner,
        turn_id = excluded.turn_id,
        last_activity_at_ms = excluded.last_activity_at_ms,
        stage = excluded.stage,
        answer = excluded.answer,
        synced_at_ms = excluded.synced_at_ms
    `).run(
      task.provider,
      task.threadId,
      task.projectRoot,
      task.projectName,
      task.sessionCwd,
      task.title,
      task.model,
      task.updatedAtMs,
      task.running ? 1 : 0,
      task.executionOwner,
      task.turnId,
      task.lastActivityAtMs,
      task.stage,
      task.answer,
      task.syncedAtMs,
    );
  }

  #writeHistory(task, history, positions = null) {
    const provider = task.provider;
    const threadId = task.threadId;
    if (positions) {
      const remove = this.#database.prepare(`
        DELETE FROM task_read_model_turns WHERE provider = ? AND thread_id = ? AND position = ?
      `);
      for (const position of positions) remove.run(provider, threadId, position);
    } else {
      this.#database.prepare(`
        DELETE FROM task_read_model_turns WHERE provider = ? AND thread_id = ?
      `).run(provider, threadId);
    }
    const insertTurn = this.#database.prepare(`
      INSERT INTO task_read_model_turns (
        provider, thread_id, position, id, prompt, answer, status, active,
        completed, started_at, completed_at, prompt_author, prompt_origin_json,
        prompt_annotations_json, prompt_request,
        attachments_json, activities_json, activity_groups_json, user_message_authority,
        user_message_snapshot_authority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = this.#database.prepare(`
      INSERT INTO task_read_model_messages (
        provider, thread_id, turn_position, position, item_id,
        client_user_message_id, source_occurrence_id, role, text, author, kind,
        agent_thread_id, model, phase, time,
        origin_json, response_annotations_json, response_annotation_request,
        response_annotation_references_json, attachments_json, display_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    history.forEach((turn, index) => {
      const turnPosition = positions ? positions[index] : index;
      insertTurn.run(
        provider,
        threadId,
        turnPosition,
        turn.id,
        turn.prompt,
        turn.answer,
        turn.status,
        turn.active ? 1 : 0,
        turn.completed ? 1 : 0,
        turn.startedAt ?? null,
        turn.completedAt ?? null,
        turn.promptAuthor ?? "",
        JSON.stringify(turn.promptOrigin ?? {}),
        JSON.stringify(turn.promptAnnotations),
        turn.promptRequest ?? "",
        JSON.stringify(turn.attachments),
        JSON.stringify(turn.activities),
        JSON.stringify(turn.activityGroups ?? []),
        turn.userMessageAuthority ?? "",
        turn.userMessageSnapshotAuthority ?? "",
      );
      turn.messages.forEach((message, messagePosition) => {
        insertMessage.run(
          provider,
          threadId,
          turnPosition,
          messagePosition,
          message.itemId,
          message.clientUserMessageId ?? null,
          message.sourceOccurrenceId ?? "",
          message.role,
          message.text,
          message.author ?? "",
          message.kind ?? "",
          message.agentThreadId ?? "",
          message.model ?? "",
          message.phase ?? null,
          message.time ?? null,
          JSON.stringify(message.origin ?? {}),
          JSON.stringify(message.responseAnnotations),
          message.responseAnnotationRequest ?? "",
          JSON.stringify(message.responseAnnotationReferences ?? []),
          JSON.stringify(message.attachments),
          message.role === "user" ? userDisplayText(message.userDisplay, {
            provider, threadId, clientUserMessageId: message.clientUserMessageId,
          }) : null,
        );
      });
    });
  }

  #writeSearchDocument(document, { replace = true } = {}) {
    const occurredAt = String(document.occurredAt ?? "").trim() || null;
    const occurredAtMs = occurredAt ? Date.parse(occurredAt) : 0;
    const source = document.source ?? "history";
    this.#database.prepare(`
      DELETE FROM task_message_search_documents
      WHERE document_key = ? AND source = ?
    `).run(legacySearchDocumentKey(document), source);
    const values = [
      searchDocumentKey(document),
      document.provider,
      document.threadId,
      document.turnThreadId ?? document.threadId,
      document.turnId,
      document.itemId,
      document.role,
      String(document.text ?? "").trim(),
      String(document.author ?? "").trim(),
      String(document.annotationText ?? "").trim(),
      String(document.attachmentNames ?? "").trim(),
      occurredAt,
      Number.isFinite(occurredAtMs) ? occurredAtMs : 0,
      source,
    ];
    const conflict = replace ? `DO UPDATE SET
      turn_thread_id = excluded.turn_thread_id,
      message_text = excluded.message_text,
      author = excluded.author,
      annotation_text = excluded.annotation_text,
      attachment_names = excluded.attachment_names,
      occurred_at = excluded.occurred_at,
      occurred_at_ms = excluded.occurred_at_ms,
      source = excluded.source` : "DO NOTHING";
    this.#database.prepare(`
      INSERT INTO task_message_search_documents (
        document_key, provider, thread_id, turn_thread_id, turn_id, item_id,
        role, message_text, author, annotation_text, attachment_names,
        occurred_at, occurred_at_ms, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_key) ${conflict}
    `).run(...values);
  }

  #searchHistoryFingerprint(task) {
    const provider = cleanText(task?.provider, 20).toLowerCase();
    const threadId = cleanText(task?.threadId, 100);
    if (!provider || !threadId) return "";
    return String(this.#database.prepare(`
      SELECT fingerprint FROM task_message_search_inputs
      WHERE provider = ? AND thread_id = ?
    `).get(provider, threadId)?.fingerprint ?? "");
  }

  #backfillSubagentModelsFromJournal() {
    const tasks = this.#database.prepare(`
      SELECT DISTINCT provider, thread_id FROM task_read_model_messages
      WHERE kind = 'subagent'
        AND trim(agent_thread_id) <> ''
        AND (trim(model) = '' OR trim(author) = '' OR author = 'Субагент (модель неизвестна)')
    `).all();
    for (const task of tasks) {
      const existing = this.#readTask({ provider: task.provider, threadId: task.thread_id }, true);
      if (!existing) continue;
      const repairedHistory = cleanHistory(this.#withJournalSubagentModels(
        existing,
        existing.history,
        { missingJournalOkay: false },
      ), this.#historyLimit, { provider: existing.provider });
      if (JSON.stringify(existing.history) === JSON.stringify(repairedHistory)) continue;
      const next = { ...existing, history: repairedHistory };
      this.#writeHistory(next, repairedHistory);
      this.#writeSearchHistory(next, repairedHistory);
    }
  }

  #writeSearchHistory(task, history, fingerprint = searchHistoryFingerprint(history)) {
    const provider = cleanText(task?.provider, 20).toLowerCase();
    const threadId = cleanText(task?.threadId, 100);
    if (!provider || !threadId) return;
    const turns = Array.isArray(history) ? history : [];
    const removeTurn = this.#database.prepare(`
      DELETE FROM task_message_search_documents
      WHERE provider = ? AND thread_id = ? AND turn_id = ? AND source = 'history'
    `);
    for (const turn of turns) {
      if (!turn.id) continue;
      removeTurn.run(provider, threadId, turn.id);
      if (turn.operationKind === "probe" || turn.contextProbe === true) continue;
      const messages = (Array.isArray(turn?.messages) ? turn.messages : []).flatMap((message) => {
        const role = String(message?.role ?? "").trim() === "assistant"
          ? "agent"
          : String(message?.role ?? "").trim();
        return ["user", "agent"].includes(role) ? [{ ...message, role }] : [];
      });
      if (!messages.some((message) => message.role === "user") && turn?.prompt) {
        messages.unshift({
          itemId: `${turn.id}:prompt`,
          role: "user",
          text: turn.prompt,
          time: turn.startedAt,
          attachments: turn.attachments,
          responseAnnotations: turn.promptAnnotations,
        });
      }
      if (!messages.some((message) => message.role === "agent") && turn?.answer) {
        messages.push({
          itemId: `${turn.id}:answer`,
          role: "agent",
          text: turn.answer,
          time: turn.completedAt,
          attachments: [],
        });
      }
      for (const [position, message] of messages.entries()) {
        const text = String(message?.text ?? "").trim();
        const annotations = [
          ...(Array.isArray(message?.responseAnnotations) ? message.responseAnnotations : []),
          ...(message.role === "user" && Array.isArray(turn?.promptAnnotations)
            ? turn.promptAnnotations : []),
        ];
        const annotationText = annotations.flatMap((annotation) => [annotation?.text, annotation?.annotation])
          .map((value) => String(value ?? "").trim()).filter(Boolean).join(" \n");
        const attachmentNames = (Array.isArray(message?.attachments) ? message.attachments : [])
          .map((attachment) => String(attachment?.name ?? "").trim()).filter(Boolean).join(" \n");
        if (!text && !annotationText && !attachmentNames) continue;
        this.#writeSearchDocument({
          provider,
          threadId,
          turnThreadId: threadId,
          turnId: turn.id,
          itemId: String(message?.itemId ?? "").trim() || `${turn.id}:${message.role}:${position}`,
          role: message.role,
          text,
          author: message.author,
          annotationText,
          attachmentNames,
          occurredAt: message?.time
            ?? (message.role === "user" ? turn.startedAt : turn.completedAt),
          source: "history",
          occurrence: position,
        });
      }
    }
    this.#database.prepare(`
      INSERT INTO task_message_search_inputs (provider, thread_id, fingerprint)
      VALUES (?, ?, ?)
      ON CONFLICT(provider, thread_id) DO UPDATE SET fingerprint = excluded.fingerprint
    `).run(provider, threadId, fingerprint);
  }

  #backfillTaskSearchIndex() {
    for (const task of this.#database.prepare(
      "SELECT provider, thread_id FROM task_read_model_tasks",
    ).all()) {
      this.#writeSearchHistory({ provider: task.provider, threadId: task.thread_id }, this.#readHistory({
        provider: task.provider,
        threadId: task.thread_id,
      }));
    }
  }

  #backfillJournalSearchIndex() {
    const rows = this.#database.prepare(`
      SELECT provider, thread_id, task_thread_id, turn_id, record_json
      FROM journal_records ORDER BY completed_at_ms
    `).all();
    for (const row of rows) {
      let record;
      try { record = JSON.parse(String(row.record_json ?? "{}")); } catch { continue; }
      if (record?.aggregateOnly === true || String(record?.parentThreadId ?? "").trim()) continue;
      const provider = String(row.provider ?? record?.provider ?? "").trim().toLowerCase();
      const threadId = String(row.task_thread_id ?? record?.taskThreadId ?? row.thread_id ?? "").trim();
      const turnThreadId = String(row.thread_id ?? record?.threadId ?? threadId).trim();
      const turnId = String(row.turn_id ?? record?.turnId ?? "").trim();
      if (!provider || !threadId || !turnId) continue;
      for (const candidate of [
        { role: "user", itemId: `${turnId}:prompt`, text: record?.prompt, occurredAt: record?.startedAt },
        { role: "agent", itemId: `${turnId}:answer`, text: record?.body ?? record?.text, occurredAt: record?.completedAt },
      ]) {
        if (!String(candidate.text ?? "").trim()) continue;
        this.#writeSearchDocument({
          provider,
          threadId,
          turnThreadId,
          turnId,
          ...candidate,
          source: "journal",
        }, { replace: false });
      }
    }
  }

  #journalBackfillIdentity() {
    const journalTable = this.#database.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'journal_records'
    `).get();
    if (!journalTable) return "";
    const revisionTable = this.#database.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'journal_store_meta'
    `).get();
    if (revisionTable) {
      const revision = this.#database.prepare(`
        SELECT value FROM journal_store_meta WHERE key = 'revision'
      `).get();
      if (revision) return `revision:${String(revision.value)}`;
    }
    const hash = createHash("sha256");
    for (const row of this.#database.prepare(`
      SELECT provider, thread_id, turn_id, record_json
      FROM journal_records ORDER BY provider, thread_id, turn_id
    `).all()) {
      hash.update(JSON.stringify([row.provider, row.thread_id, row.turn_id, row.record_json]));
    }
    return `legacy:${hash.digest("hex")}`;
  }

  #runVersionedBackfill(key, version, backfill) {
    const current = this.#database.prepare(
      "SELECT value FROM task_read_model_meta WHERE key = ?",
    ).get(key);
    if (String(current?.value ?? "") === version) return false;
    backfill();
    this.#database.prepare(`
      INSERT INTO task_read_model_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, version);
    return true;
  }

  #transaction(run) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const changesBefore = this.#database.prepare("SELECT total_changes() AS count").get().count;
      const result = run();
      const changed = this.#database.prepare("SELECT total_changes() AS count").get().count !== changesBefore;
      this.#database.exec("COMMIT");
      if (changed) this.#revision += 1;
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #prune() {
    const count = Number(this.#database.prepare(
      "SELECT COUNT(*) AS count FROM task_read_model_tasks",
    ).get()?.count ?? 0);
    if (count <= this.#taskLimit) return false;
    const removeCount = count - this.#taskLimit;
    const removable = this.#database.prepare(`
      SELECT provider, thread_id FROM task_read_model_tasks
      WHERE running = 0
      ORDER BY COALESCE(NULLIF(synced_at_ms, 0), updated_at_ms), provider, thread_id
      LIMIT ?
    `).all(removeCount);
    const remove = this.#database.prepare(`
      DELETE FROM task_read_model_tasks WHERE provider = ? AND thread_id = ?
    `);
    for (const row of removable) remove.run(row.provider, row.thread_id);
    return removable.length > 0;
  }

  async #migrateLegacyFile() {
    let source;
    let sourceInfo;
    try {
      [source, sourceInfo] = await Promise.all([
        readFile(this.#filePath, "utf8"),
        stat(this.#filePath),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const fingerprint = createHash("sha256").update(source).digest("hex");
    const migrated = this.#database.prepare(`
      SELECT value FROM task_read_model_meta WHERE key = 'legacy_task_sync_sha256'
    `).get();
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Cannot migrate invalid task-sync.json: ${error.message}`, { cause: error });
    }
    if (Number(parsed?.version) !== FORMAT_VERSION) {
      throw new Error(`Cannot migrate task-sync.json version ${parsed?.version ?? "unknown"}`);
    }
    const canonical = this.#canonicalizeValue(parsed);
    const tasks = (Array.isArray(canonical.tasks) ? canonical.tasks : [])
      .map((value) => persistedTask(value, this.#canonicalizeProjectRoot))
      .filter(Boolean);
    if (String(migrated?.value ?? "") !== fingerprint) {
      await this.#mutations.run(() => this.#transaction(() => {
        for (const task of tasks) {
          this.#writeTask(task);
          this.#writeHistory(task, cleanHistory(task.history, this.#historyLimit, { provider: task.provider }));
        }
        this.#prune();
        this.#database.prepare(`
          INSERT INTO task_read_model_meta (key, value) VALUES ('legacy_task_sync_sha256', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(fingerprint);
      }), { timeoutMs: this.#mutationTimeoutMs, requestId: `task-sync:migrate:${fingerprint}` });
    }
    for (const expected of tasks) {
      const actual = this.#readTask(expected, true);
      if (!actual || JSON.stringify(actual) !== JSON.stringify({
        ...expected,
        history: cleanHistory(expected.history, this.#historyLimit, { provider: expected.provider }),
      })) {
        throw new Error(`SQLite verification failed for ${catalogTaskKey(expected)}`);
      }
    }
    await unlink(this.#filePath);
    console.log(`Migrated ${tasks.length} task(s) from ${path.basename(this.#filePath)} to SQLite and removed the verified source (${sourceInfo.size} bytes).`);
  }

  async load() {
    await this.#open();
    await this.#migrateLegacyFile();
    await this.#mutations.run(() => this.#transaction(() => {
      this.#recoverTerminalCommandIdentities();
      this.#runVersionedBackfill(
        "backfill_task_message_search_version",
        SEARCH_BACKFILL_VERSION,
        () => this.#backfillTaskSearchIndex(),
      );
      const journalIdentity = this.#journalBackfillIdentity();
      if (!journalIdentity) return;
      this.#runVersionedBackfill(
        "backfill_terminal_task_history_version",
        TERMINAL_HISTORY_BACKFILL_VERSION,
        () => this.#backfillTerminalHistoryFromJournal(),
      );
      this.#runVersionedBackfill(
        "backfill_models_from_journal_version",
        `${MODEL_BACKFILL_VERSION}:${journalIdentity}`,
        () => this.#backfillModelsFromJournal(),
      );
      this.#runVersionedBackfill(
        "backfill_subagent_models_from_journal_version",
        `${SUBAGENT_MODEL_BACKFILL_VERSION}:${journalIdentity}`,
        () => this.#backfillSubagentModelsFromJournal(),
      );
      this.#runVersionedBackfill(
        "backfill_journal_message_search_version",
        `${SEARCH_BACKFILL_VERSION}:${journalIdentity}`,
        () => this.#backfillJournalSearchIndex(),
      );
    }), { timeoutMs: this.#mutationTimeoutMs, requestId: "task-sync:load" });
    return this;
  }

  catalog({
    provider = null,
    nowMs = Date.now(),
    runningFreshnessMs = DEFAULT_RUNNING_FRESHNESS_MS,
  } = {}) {
    const normalizedProvider = provider ? String(provider).toLowerCase() : null;
    const rows = normalizedProvider
      ? this.#database.prepare(
        "SELECT * FROM task_read_model_tasks WHERE provider = ?",
      ).all(normalizedProvider)
      : this.#database.prepare("SELECT * FROM task_read_model_tasks").all();
    return rows.map((row) => taskFromRow(row)).map((task) => {
      const activityAtMs = Number(task.lastActivityAtMs ?? task.syncedAtMs);
      const running = task.running
        && Number.isFinite(activityAtMs)
        && nowMs - activityAtMs <= runningFreshnessMs;
      return {
        provider: task.provider,
        threadId: task.threadId,
        projectRoot: task.projectRoot,
        projectName: task.projectName,
        ...(task.sessionCwd ? { sessionCwd: task.sessionCwd } : {}),
        title: task.title,
        model: task.model,
        updatedAtMs: task.updatedAtMs,
        running,
        executionOwner: running ? task.executionOwner : null,
        turnId: running ? task.turnId : null,
        lastActivityAtMs: activityAtMs || null,
      };
    });
  }

  recordCatalog(entries, nowMs = Date.now()) {
    const captured = (Array.isArray(entries) ? entries : []).map((entry) => ({ ...entry }));
    return this.#mutations.run(() => this.#recordCatalog(captured, nowMs), {
      timeoutMs: this.#mutationTimeoutMs,
      requestId: "task-sync:catalog",
    });
  }

  #recordCatalog(entries, nowMs) {
    let changed = false;
    this.#transaction(() => {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const existing = this.#readTask(entry) ?? {};
        const next = persistedTask({
          ...existing,
          ...entry,
          model: entry.model ?? existing.model ?? this.#latestJournalModel(entry),
          syncedAtMs: nowMs,
        }, this.#canonicalizeProjectRoot);
        if (!next || !taskMetadataChanged(existing, next)) continue;
        this.#writeTask(next);
        changed = true;
      }
      this.#prune();
    });
    return changed;
  }

  recordSnapshot(task, snapshot = {}, {
    executionOwner = null,
    nowMs = Date.now(),
  } = {}) {
    const capturedTask = { ...task };
    const capturedSnapshot = { ...snapshot };
    return this.#mutations.run(() => this.#recordSnapshot(capturedTask, capturedSnapshot, {
      executionOwner, nowMs,
    }), {
      timeoutMs: this.#mutationTimeoutMs,
      requestId: `task-sync:snapshot:${catalogTaskKey(capturedTask)}`,
    });
  }

  #recordSnapshot(task, snapshot, { executionOwner, nowMs }) {
    const existing = this.#readTask(task) ?? {};
    const activityAtMs = Number(snapshot.activityAtMs ?? snapshot.modifiedAtMs ?? nowMs) || nowMs;
    const next = persistedTask({
      ...existing,
      ...task,
      title: task.title ?? task.taskTitle ?? existing.title,
      model: snapshot.model ?? task.model ?? existing.model ?? this.#latestJournalModel(task),
      running: snapshot.active === true,
      executionOwner: executionOwner ?? snapshot.executionOwner ?? existing.executionOwner,
      turnId: snapshot.turnId ?? existing.turnId,
      lastActivityAtMs: activityAtMs,
      stage: snapshot.stage ?? existing.stage,
      answer: snapshot.answer ?? existing.answer,
      syncedAtMs: nowMs,
    }, this.#canonicalizeProjectRoot);
    if (!next || !taskMetadataChanged(existing, next)) return false;
    this.#transaction(() => {
      this.#writeTask(next);
      this.#prune();
    });
    return true;
  }

  recordHistory(task, history, snapshot = null, nowMs = Date.now()) {
    const capturedTask = { ...task };
    const capturedSnapshot = snapshot ? { ...snapshot } : null;
    const capturedHistory = structuredClone(history);
    return this.#mutations.run(() => this.#recordHistory(capturedTask, capturedHistory, capturedSnapshot, nowMs), {
      timeoutMs: this.#mutationTimeoutMs,
      requestId: `task-sync:history:${catalogTaskKey(capturedTask)}`,
    });
  }

  #recordHistory(task, history, snapshot, nowMs) {
    const existing = this.#readTask(task, true) ?? {};
    const terminals = terminalHistoryTurns(existing.history);
    const rebasedHistory = task.provider === "codex" ? rebaseActiveCodexUsers(existing.history, history) : history;
    const journalHistory = this.#reconcileHistoryWithJournal(task, rebasedHistory);
    const reconciledHistory = preserveTerminalHistory(terminals, journalHistory);
    const durableAttachments = preserveDurableAttachments(existing.history, reconciledHistory);
    const durableHistory = preserveDurableChronology(existing.history, durableAttachments);
    const enrichedHistory = this.#withJournalSubagentModels(task, durableHistory);
    const durableMetadataHistory = preserveDurableResponseAnnotationReferences(existing.history, enrichedHistory);
    const displayHistory = preserveUserDisplay(existing.history, durableMetadataHistory, task);
    const cleanedHistory = cleanHistory(displayHistory, this.#historyLimit, { provider: task.provider });
    const effectiveSnapshot = terminalSafeSnapshot(existing, snapshot, terminals);
    const next = persistedTask({
      ...existing,
      ...task,
      title: task.title ?? task.taskTitle ?? existing.title,
      model: effectiveSnapshot?.model ?? task.model ?? existing.model ?? this.#latestJournalModel(task),
      running: effectiveSnapshot ? effectiveSnapshot.active === true : existing.running === true,
      executionOwner: effectiveSnapshot?.executionOwner ?? existing.executionOwner,
      turnId: effectiveSnapshot?.turnId ?? existing.turnId,
      lastActivityAtMs: effectiveSnapshot?.activityAtMs ?? existing.lastActivityAtMs,
      stage: effectiveSnapshot?.stage ?? existing.stage,
      answer: effectiveSnapshot?.answer ?? existing.answer,
      syncedAtMs: nowMs,
      history: cleanedHistory,
    }, this.#canonicalizeProjectRoot);
    const metadataChanged = next && taskMetadataChanged(existing, next);
    const historyChanged = JSON.stringify(existing.history ?? []) !== JSON.stringify(cleanedHistory);
    const searchFingerprint = searchHistoryFingerprint(enrichedHistory);
    const searchChanged = this.#searchHistoryFingerprint(next) !== searchFingerprint;
    if (!next) return false;
    if (!metadataChanged && !historyChanged && !searchChanged) return false;
    this.#transaction(() => {
      if (metadataChanged || historyChanged) this.#writeTask(next);
      if (searchChanged) this.#writeSearchHistory(next, enrichedHistory, searchFingerprint);
      if (historyChanged) this.#writeHistory(next, cleanedHistory);
      this.#prune();
    });
    return Boolean(metadataChanged || historyChanged);
  }

  searchMessages({ references = [], query, offset = 0, limit = 40 } = {}) {
    const normalizedReferences = (Array.isArray(references) ? references : [])
      .map((reference) => ({
        provider: cleanText(reference?.provider, 20).toLowerCase(),
        threadId: cleanText(reference?.threadId, 100),
      }))
      .filter((reference) => reference.provider && reference.threadId);
    const terms = normalizedSearchTerms(query).slice(0, 20);
    if (!normalizedReferences.length || !terms.length) return { total: 0, results: [] };
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 40), 100));
    const identitySql = normalizedReferences.map(() => "(d.provider = ? AND d.thread_id = ?)").join(" OR ");
    const identityParams = normalizedReferences.flatMap((reference) => [reference.provider, reference.threadId]);
    const match = ftsSearchQuery(terms.join(" "));
    const fromSql = `
      FROM task_message_search_fts AS f
      JOIN task_message_search_documents AS d ON d.id = f.rowid
      WHERE task_message_search_fts MATCH ? AND (${identitySql})
    `;
    const total = Number(this.#database.prepare(`SELECT COUNT(*) AS count ${fromSql}`)
      .get(match, ...identityParams)?.count ?? 0);
    const rows = this.#database.prepare(`
      SELECT d.* ${fromSql}
      ORDER BY d.occurred_at_ms DESC, d.document_key
      LIMIT ? OFFSET ?
    `).all(match, ...identityParams, safeLimit, safeOffset);
    return {
      total,
      results: rows.map((row) => {
        const matchedField = terms.some((term) => String(row.attachment_names ?? "")
          .normalize("NFKC").toLocaleLowerCase("ru-RU").includes(term))
          ? "attachment" : "text";
        const source = matchedField === "attachment" ? row.attachment_names : (
          String(row.message_text ?? "").trim() || row.annotation_text
        );
        return {
          id: String(row.document_key),
          provider: String(row.provider),
          threadId: String(row.thread_id),
          turnThreadId: String(row.turn_thread_id),
          turnId: String(row.turn_id),
          itemId: String(row.item_id),
          role: String(row.role),
          ...(row.author ? { author: String(row.author) } : {}),
          matchedField,
          snippet: compactSearchSnippet(source, terms),
          occurredAt: row.occurred_at ? String(row.occurred_at) : null,
        };
      }),
    };
  }

  searchMessage({ provider, threadId, turnId, itemId } = {}) {
    const row = this.#database.prepare(`
      SELECT * FROM task_message_search_documents
      WHERE provider = ? AND thread_id = ? AND turn_id = ? AND item_id = ?
      ORDER BY source = 'history' DESC LIMIT 1
    `).get(
      cleanText(provider, 20).toLowerCase(),
      cleanText(threadId, 100),
      cleanText(turnId, 100),
      cleanText(itemId, 200),
    );
    if (!row) return null;
    const value = {
      provider: String(row.provider),
      threadId: String(row.thread_id),
      turnThreadId: String(row.turn_thread_id),
      turnId: String(row.turn_id),
      itemId: String(row.item_id),
      role: String(row.role),
      text: String(row.message_text),
      ...(row.author ? { author: String(row.author) } : {}),
      attachmentNames: String(row.attachment_names ?? "").split(/\s*\n\s*/u).filter(Boolean),
      occurredAt: row.occurred_at ? String(row.occurred_at) : null,
    };
    return { ...value, ...indexedDurableMessageMetadata(value) };
  }

  durableMessageCandidate({ provider, threadId, turnId, itemId, role } = {}) {
    const normalizedProvider = cleanText(provider, 20).toLowerCase();
    const normalizedThreadId = cleanText(threadId, 100);
    const normalizedTurnId = cleanText(turnId, 100);
    const normalizedItemId = cleanText(itemId, 200);
    const normalizedRole = cleanText(role, 20);
    const row = this.#database.prepare(`
      SELECT * FROM task_read_model_turns
      WHERE provider = ? AND thread_id = ? AND id = ?
      ORDER BY position DESC LIMIT 1
    `).get(normalizedProvider, normalizedThreadId, normalizedTurnId);
    if (row) {
      const turn = this.#hydrateHistoryRows([row])[0];
      const message = turn?.messages?.find((candidate) => (
        String(candidate?.itemId ?? "") === normalizedItemId
        && String(candidate?.role ?? "") === normalizedRole
      ));
      if (message) {
        return {
          provider: normalizedProvider,
          threadId: normalizedThreadId,
          turnThreadId: normalizedThreadId,
          turnId: normalizedTurnId,
          ...message,
          occurredAt: message.time ?? (message.role === "user" ? turn.startedAt : turn.completedAt) ?? null,
        };
      }
    }
    const indexed = this.searchMessage({
      provider: normalizedProvider,
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
      itemId: normalizedItemId,
    });
    return indexed?.role === normalizedRole ? indexed : null;
  }

  messageSearchStatus(references = []) {
    const normalized = (Array.isArray(references) ? references : []).map((reference) => ({
      provider: cleanText(reference?.provider, 20).toLowerCase(),
      threadId: cleanText(reference?.threadId, 100),
    })).filter((reference) => reference.provider && reference.threadId);
    const read = this.#database.prepare(`
      SELECT state, completed_at_ms, last_error FROM task_message_search_threads
      WHERE provider = ? AND thread_id = ?
    `);
    const threads = normalized.map((reference) => {
      const row = read.get(reference.provider, reference.threadId);
      return {
        ...reference,
        state: String(row?.state ?? "pending"),
        completedAtMs: Number(row?.completed_at_ms) || null,
        error: String(row?.last_error ?? ""),
      };
    });
    return {
      totalThreads: threads.length,
      completedThreads: threads.filter((thread) => thread.state === "ready").length,
      failedThreads: threads.filter((thread) => thread.state === "failed").length,
      threads,
    };
  }

  markMessageSearchThread(reference, { error = "", nowMs = Date.now() } = {}) {
    const provider = cleanText(reference?.provider, 20).toLowerCase();
    const threadId = cleanText(reference?.threadId, 100);
    if (!provider || !threadId) return false;
    const lastError = cleanText(error, 2_000);
    this.#database.prepare(`
      INSERT INTO task_message_search_threads (
        provider, thread_id, state, completed_at_ms, last_error
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, thread_id) DO UPDATE SET
        state = excluded.state,
        completed_at_ms = excluded.completed_at_ms,
        last_error = excluded.last_error
    `).run(provider, threadId, lastError ? "failed" : "ready", Number(nowMs) || Date.now(), lastError);
    return true;
  }

  history(task, { limit = this.#historyLimit } = {}) {
    return cleanHistory(this.#readHistory(task, limit), limit, { provider: task.provider });
  }

  async readHistoryPage(references, options = {}) {
    const page = this.historyPage(references, options);
    const candidates = page.items.filter(({ turn }) => (
      turn.completed === true && turn.active !== true
      && turn.userMessageAuthority !== "terminal-ledger"
    )).map(({ provider, threadId, turn }) => ({ provider, threadId, turnId: turn.id }));
    if (!candidates.length) return page;
    await this.#mutations.run(() => this.#transaction(() => (
      this.#recoverTerminalCommandIdentities(candidates)
    )), { timeoutMs: this.#mutationTimeoutMs, requestId: "task-sync:page-terminal-recovery" });
    return this.historyPage(references, options);
  }

  historyPage(references, {
    before,
    limit = 10,
    ...visibility
  } = {}) {
    const normalizedReferences = normalizedHistoryReferences(references);
    if (!normalizedReferences.length) {
      return { total: 0, messageTotal: 0, start: 0, end: 0, items: [] };
    }
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 10), 20));
    const query = historyPageQuery(normalizedReferences, visibility);
    const aggregate = this.#database.prepare(`${query.cte}
      SELECT COUNT(*) AS total, COALESCE(SUM(message_count), 0) AS message_total
      FROM base_turns
    `).get(...query.params);
    const total = Number(aggregate?.total) || 0;
    const requestedEnd = Number(before);
    const end = Number.isSafeInteger(requestedEnd)
      ? Math.max(0, Math.min(requestedEnd, total))
      : total;
    const start = Math.max(0, end - safeLimit);
    if (start === end) {
      return {
        total,
        messageTotal: Number(aggregate?.message_total) || 0,
        start,
        end,
        items: [],
      };
    }
    const rows = this.#database.prepare(`${query.cte}, selected_page AS (
      SELECT provider, thread_id, position, chronology_anchor, source_order
      FROM visible_turns
      ORDER BY chronology_anchor, source_order, position
      LIMIT ? OFFSET ?
    )
      SELECT turns.* FROM selected_page
      JOIN task_read_model_turns turns
        ON turns.provider = selected_page.provider AND turns.thread_id = selected_page.thread_id
        AND turns.position = selected_page.position
      ORDER BY selected_page.chronology_anchor, selected_page.source_order, selected_page.position
    `).all(...query.params, end - start, start);
    const history = this.#hydrateHistoryRows(rows);
    return {
      total,
      messageTotal: Number(aggregate?.message_total) || 0,
      start,
      end,
      items: history.map((turn, index) => ({
        provider: String(rows[index].provider),
        threadId: String(rows[index].thread_id),
        turn,
      })),
    };
  }

  snapshot(task, {
    nowMs = Date.now(),
    runningFreshnessMs = DEFAULT_RUNNING_FRESHNESS_MS,
  } = {}) {
    const value = this.#readTask(task);
    if (!value) return null;
    const activityAtMs = Number(value.lastActivityAtMs ?? value.syncedAtMs);
    const active = value.running
      && Number.isFinite(activityAtMs)
      && nowMs - activityAtMs <= runningFreshnessMs;
    return {
      active,
      completed: !active,
      turnId: active ? value.turnId : null,
      activityAtMs: activityAtMs || null,
      executionOwner: active ? value.executionOwner : null,
      stage: value.stage,
      answer: value.answer,
    };
  }

  save() {
    return this.#mutations.idle();
  }

  mutationDiagnostics() {
    return this.#mutations.diagnostics();
  }

  // Process-local read-model invalidation, never a command/CAS identity.
  get revision() {
    return this.#revision;
  }

  close() {
    if (this.#mutations.diagnostics().queued > 0) return this.#mutations.idle().then(() => this.close());
    this.#database?.close();
    this.#database = null;
  }
}
