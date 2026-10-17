import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const TEST_CONTOUR_PROBE = "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";
export const TEST_CONTOUR_PROBE_RESPONSE = "AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";

export function assertTestContourShellContent(bodyText) {
  const content = bodyText.trim();
  if (content.length < 100 || !content.includes("Потоки")) {
    throw new Error("Agent Hub shell did not render meaningful content");
  }
}

const SMOKE_CONVERSATION_STATE_VERSION = 2;
const SMOKE_CONVERSATION_STATE_FILE = "ui-smoke-conversation.json";
const SMOKE_WORKSPACE_NAME = "Agent Hub Test Contour Smoke";
const SMOKE_STREAM_NAME = "Smoke";
const SMOKE_COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;

function normalizedIdentity(value = {}) {
  return {
    workspaceId: String(value.workspaceId ?? "").trim(),
    streamId: String(value.streamId ?? "").trim(),
    provider: String(value.provider ?? "").trim().toLowerCase(),
    threadId: String(value.threadId ?? "").trim(),
  };
}

function normalizedOperation(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = String(value.action ?? "").trim();
  const commandId = String(value.commandId ?? "").trim();
  const phase = String(value.phase ?? "prepared").trim();
  const params = value.params && typeof value.params === "object" && !Array.isArray(value.params)
    ? structuredClone(value.params)
    : null;
  if (!["new-task", "send-message"].includes(action) || !SMOKE_COMMAND_ID_PATTERN.test(commandId) || !params) return null;
  if (!["prepared", "accepted"].includes(phase)) return null;
  if (
    String(params.provider ?? "").trim().toLowerCase() !== "codex"
    || (action === "new-task" && String(params.settings?.provider ?? "").trim().toLowerCase() !== "codex")
    || (action === "send-message" && (
      params.text !== TEST_CONTOUR_PROBE
      || !String(params.streamId ?? "").trim()
      || !String(params.threadId ?? "").trim()
      || !String(params.clientUserMessageId ?? "").trim()
    ))
  ) return null;
  const accepted = phase === "accepted" && value.accepted && typeof value.accepted === "object"
    ? structuredClone(value.accepted)
    : null;
  if (phase === "accepted" && !accepted) return null;
  return { action, commandId, phase, params, ...(accepted ? { accepted } : {}) };
}

function normalizedSmokeState(value = null) {
  if (!value) {
    return { identity: normalizedIdentity(), operation: null };
  }
  if (![1, SMOKE_CONVERSATION_STATE_VERSION].includes(value.version)) {
    throw new Error(`Unsupported Test Contour smoke state version: ${value.version ?? "missing"}`);
  }
  const operation = value.version === SMOKE_CONVERSATION_STATE_VERSION
    ? normalizedOperation(value.operation)
    : null;
  if (value.version === SMOKE_CONVERSATION_STATE_VERSION && value.operation != null && !operation) {
    throw new Error("Test Contour smoke state has an invalid durable operation");
  }
  return {
    identity: normalizedIdentity(value),
    operation,
  };
}

function exactThread(stream, identity) {
  const threads = Array.isArray(stream?.threads) ? stream.threads : [];
  const active = threads
    .filter((thread) => thread?.detachedAtMs == null)
    .sort((left, right) => Number(left?.position ?? 0) - Number(right?.position ?? 0))
    .at(-1);
  const projected = threads.at(-1);
  if (!active || !projected) return null;
  if (
    String(active.provider ?? "").toLowerCase() !== identity.provider
    || String(active.threadId ?? "") !== identity.threadId
    || String(projected.provider ?? "").toLowerCase() !== identity.provider
    || String(projected.threadId ?? "") !== identity.threadId
    || projected.detachedAtMs != null
  ) return null;
  return active;
}

function orderedWorkspaces(snapshot) {
  return (Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [])
    .filter((workspace) => String(workspace?.id ?? "").trim())
    .slice()
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export function planTestContourSmokeConversation(snapshot, savedState = null, model = "") {
  const saved = normalizedSmokeState(savedState).identity;
  const workspaces = orderedWorkspaces(snapshot);
  const savedWorkspace = workspaces.find((workspace) => String(workspace.id) === saved.workspaceId) ?? null;
  const savedStream = (savedWorkspace?.streams ?? [])
    .find((stream) => String(stream?.id ?? "") === saved.streamId) ?? null;
  if (
    saved.provider === "codex"
    && saved.workspaceId
    && saved.streamId
    && saved.threadId
    && savedStream
    && exactThread(savedStream, saved)
  ) {
    return { kind: "reuse", identity: saved };
  }

  const settings = { provider: "codex", model: String(model ?? "").trim() };
  if (savedStream) {
    return {
      kind: "create-thread",
      params: { streamId: saved.streamId, provider: "codex", settings },
    };
  }
  const workspace = savedWorkspace ?? workspaces[0] ?? null;
  if (workspace) {
    return {
      kind: "create-stream",
      params: {
        workspaceId: String(workspace.id),
        streamName: SMOKE_STREAM_NAME,
        provider: "codex",
        settings,
      },
    };
  }
  return {
    kind: "create-workspace",
    params: {
      workspaceName: SMOKE_WORKSPACE_NAME,
      streamName: SMOKE_STREAM_NAME,
      provider: "codex",
      settings,
    },
  };
}

function boundedDiagnostic(value, limit = 2_048) {
  const text = String(value ?? "").replace(/[\r\n]+/gu, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export async function requestTestContourControl(page, {
  action,
  params = {},
  commandId = "",
  timeoutMs,
  acknowledge = true,
} = {}) {
  const result = await page.evaluate(async (request) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort("timeout"), request.timeoutMs);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: request.action,
          params: request.params,
          ...(request.commandId ? { commandId: request.commandId } : {}),
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch {}
      let acknowledged = null;
      if (
        request.acknowledge
        && response.ok
        && payload?.ok !== false
        && request.commandId
        && payload?.receiptId === request.commandId
      ) {
        acknowledged = await fetch("/api/control/ack", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandId: request.commandId }),
          signal: controller.signal,
        }).then((ack) => ack.ok, () => false);
      }
      return {
        kind: "response",
        ok: response.ok && payload?.ok !== false,
        status: response.status,
        text,
        payload,
        acknowledged,
      };
    } catch (error) {
      return { kind: "unknown", error: String(error?.message ?? error) };
    } finally {
      window.clearTimeout(timer);
    }
  }, { action, params, commandId, timeoutMs, acknowledge });
  if (result.kind === "unknown") {
    throw new Error(
      `Test Contour ${action} outcome is unknown; command ${commandId || "<read>"} was not retried: ${boundedDiagnostic(result.error)}`,
    );
  }
  if (!result.ok) {
    const reason = result.payload?.error ?? result.text ?? "request rejected";
    throw new Error(
      `Test Contour ${action} failed: HTTP ${result.status}; command ${commandId || "<read>"}; ${boundedDiagnostic(reason)}`,
    );
  }
  return {
    result: result.payload?.result,
    receiptId: result.payload?.receiptId ?? null,
    acknowledged: result.acknowledged,
  };
}

async function acknowledgeTestContourControl(page, commandId, timeoutMs) {
  const result = await page.evaluate(async (request) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort("timeout"), request.timeoutMs);
    try {
      const response = await fetch("/api/control/ack", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: request.commandId }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      return { ok: response.ok && payload?.ok !== false, status: response.status, payload };
    } catch (error) {
      return { ok: false, status: 0, payload: { error: String(error?.message ?? error) } };
    } finally {
      window.clearTimeout(timer);
    }
  }, { commandId, timeoutMs });
  if (!result.ok) {
    throw new Error(
      `Test Contour command acknowledgement failed: HTTP ${result.status}; command ${commandId}; ${boundedDiagnostic(result.payload?.error)}`,
    );
  }
  return result.payload?.retired === true;
}

async function readSmokeConversationState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeSmokeConversationState(file, identity, operation = null) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const exactOperation = operation ? normalizedOperation(operation) : null;
  if (operation && !exactOperation) throw new Error("Refusing to persist an invalid Test Contour smoke operation");
  await writeFile(temporary, `${JSON.stringify({
    version: SMOKE_CONVERSATION_STATE_VERSION,
    ...normalizedIdentity(identity),
    ...(exactOperation ? { operation: exactOperation } : {}),
  }, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function createdConversationIdentity(result) {
  const identity = normalizedIdentity({
    workspaceId: result?.createdTask?.workspaceId,
    streamId: result?.createdTask?.streamId,
    provider: result?.createdTask?.provider,
    threadId: result?.createdTask?.threadId,
  });
  if (!identity.workspaceId) {
    const createdStream = orderedWorkspaces(result)
      .flatMap((workspace) => (workspace.streams ?? []).map((stream) => ({ workspace, stream })))
      .find(({ stream }) => String(stream?.id ?? "") === identity.streamId);
    identity.workspaceId = String(createdStream?.workspace?.id ?? "");
  }
  return identity;
}

function exactCreatedConversation(operation, result, receiptId) {
  if (String(receiptId ?? "").trim() !== operation.commandId) {
    throw new Error(`Test Contour new-task returned an invalid receipt for command ${operation.commandId}`);
  }
  const identity = createdConversationIdentity(result);
  const params = operation.params ?? {};
  if (
    !identity.workspaceId
    || !identity.streamId
    || identity.provider !== "codex"
    || !identity.threadId
    || (params.streamId && identity.streamId !== String(params.streamId).trim())
    || (params.workspaceId && identity.workspaceId !== String(params.workspaceId).trim())
  ) {
    throw new Error(`Test Contour new-task returned an invalid target for command ${operation.commandId}`);
  }
  return identity;
}

function exactAcceptedSend(operation, result, receiptId, expectedIdentity) {
  const expected = normalizedIdentity(expectedIdentity);
  const params = operation.params ?? {};
  const accepted = {
    commandId: operation.commandId,
    clientUserMessageId: String(result?.clientUserMessageId ?? "").trim(),
    streamId: String(result?.streamId ?? "").trim(),
    provider: String(result?.provider ?? "").trim().toLowerCase(),
    threadId: String(result?.threadId ?? "").trim(),
    turnId: String(result?.turnId ?? "").trim(),
  };
  if (
    result?.accepted !== true
    || String(receiptId ?? "").trim() !== operation.commandId
    || accepted.streamId !== expected.streamId
    || accepted.provider !== expected.provider
    || accepted.threadId !== expected.threadId
    || accepted.clientUserMessageId !== String(params.clientUserMessageId ?? "").trim()
    || !accepted.clientUserMessageId
    || !accepted.turnId
  ) {
    throw new Error(`Test Contour send-message returned an invalid acceptance for command ${operation.commandId}`);
  }
  return accepted;
}

function exactQueuedSend(operation, result, receiptId, expectedIdentity) {
  const expected = normalizedIdentity(expectedIdentity);
  const params = operation.params ?? {};
  const queued = {
    clientUserMessageId: String(result?.clientUserMessageId ?? "").trim(),
    streamId: String(result?.streamId ?? "").trim(),
    provider: String(result?.provider ?? "").trim().toLowerCase(),
    threadId: String(result?.threadId ?? "").trim(),
    durableId: String(result?.id ?? "").trim(),
  };
  if (
    result?.accepted !== true
    || result?.deferred !== true
    || result?.queued !== true
    || String(result?.turnId ?? "").trim()
    || String(receiptId ?? "").trim() !== operation.commandId
    || queued.streamId !== expected.streamId
    || queued.provider !== expected.provider
    || queued.threadId !== expected.threadId
    || queued.clientUserMessageId !== String(params.clientUserMessageId ?? "").trim()
    || !queued.clientUserMessageId
    || !queued.durableId
  ) {
    throw new Error(`Test Contour send-message returned an invalid acceptance for command ${operation.commandId}`);
  }
  return queued;
}

function exactAcceptedReceipt(snapshot, operation, expectedIdentity) {
  const expected = normalizedIdentity(expectedIdentity);
  const clientUserMessageId = String(operation.params?.clientUserMessageId ?? "").trim();
  const matching = (Array.isArray(snapshot?.messageReceipts) ? snapshot.messageReceipts : [])
    .filter((receipt) => String(receipt?.clientUserMessageId ?? "").trim() === clientUserMessageId);
  if (matching.length > 1) {
    throw new Error(`Test Contour found ambiguous durable receipts for command ${operation.commandId}`);
  }
  if (!matching.length) return null;
  const receipt = matching[0];
  const receiptIdentityMatches = (
    String(receipt?.streamId ?? "").trim() === expected.streamId
    && String(receipt?.provider ?? "").trim().toLowerCase() === expected.provider
    && String(receipt?.threadId ?? "").trim() === expected.threadId
  );
  if (!receiptIdentityMatches) {
    throw new Error(`Test Contour found a durable receipt for a different target for command ${operation.commandId}`);
  }
  if (receipt?.accepted === true && String(receipt?.turnId ?? "").trim()) {
    return exactAcceptedSend(operation, {
      ...receipt,
      streamId: expected.streamId,
      clientUserMessageId,
    }, operation.commandId, expected);
  }
  if (
    receipt?.rejected === true
    || receipt?.failed === true
    || receipt?.cancelled === true
    || receipt?.attentionRequired === true
    || receipt?.unknown === true
  ) {
    throw new Error(
      `Test Contour send-message did not reach an exact provider turn for command ${operation.commandId}: ${boundedDiagnostic(receipt?.message ?? "terminal receipt")}`,
    );
  }
  return null;
}

async function waitForExactAcceptedReceipt(page, operation, identity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const snapshot = (await requestTestContourControl(page, {
      action: "snapshot",
      timeoutMs: Math.max(1, deadline - Date.now()),
    })).result;
    const accepted = exactAcceptedReceipt(snapshot, operation, identity);
    if (accepted) return accepted;
    if (Date.now() >= deadline) break;
    const delayMs = Math.min(100, Math.max(1, deadline - Date.now()));
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(delayMs);
    else await new Promise((resolve) => setTimeout(resolve, delayMs));
  } while (Date.now() < deadline);
  throw new Error(
    `Test Contour send-message command ${operation.commandId} did not acquire an exact provider turn before timeout`,
  );
}

function selectorValue(value) {
  return String(value ?? "").replace(/[\\"]/gu, "\\$&");
}

export async function selectTestContourConversation(page, identity, timeoutMs) {
  const exact = normalizedIdentity(identity);
  if (!exact.workspaceId || !exact.streamId || exact.provider !== "codex" || !exact.threadId) {
    throw new Error("Test Contour smoke conversation identity is incomplete");
  }
  const workspace = page.locator(
    `[data-workspace-select][data-workspace-id="${selectorValue(exact.workspaceId)}"]:visible`,
  );
  await workspace.waitFor({ state: "visible", timeout: timeoutMs });
  await workspace.click();
  const stream = page.locator(
    `[data-stream-tab-id="${selectorValue(exact.streamId)}"]`
      + `[data-workspace-id="${selectorValue(exact.workspaceId)}"]`
      + '[data-stream-provider="codex"]:visible',
  );
  await stream.waitFor({ state: "visible", timeout: timeoutMs });
  if (String(await stream.getAttribute("data-stream-task-id") ?? "") !== exact.streamId) {
    throw new Error(`Test Contour did not project the exact smoke Stream ${exact.streamId}`);
  }
  await stream.click();
  return stream;
}

export async function prepareTestContourSmokeConversation(page, {
  artifactsDirectory,
  model,
  timeoutMs,
  commandIdFactory = randomUUID,
} = {}) {
  const stateFile = path.join(artifactsDirectory, SMOKE_CONVERSATION_STATE_FILE);
  const persisted = normalizedSmokeState(await readSmokeConversationState(stateFile));
  const snapshot = (await requestTestContourControl(page, {
    action: "snapshot",
    timeoutMs,
  })).result;
  const saved = {
    version: SMOKE_CONVERSATION_STATE_VERSION,
    ...persisted.identity,
  };
  const pending = persisted.operation;
  if (pending?.action === "send-message") {
    const workspace = orderedWorkspaces(snapshot)
      .find((candidate) => String(candidate.id ?? "") === persisted.identity.workspaceId) ?? null;
    const stream = (workspace?.streams ?? [])
      .find((candidate) => String(candidate?.id ?? "") === persisted.identity.streamId) ?? null;
    if (!stream) {
      throw new Error(
        `Test Contour cannot reconcile send-message command ${pending.commandId}: its exact Stream is absent`,
      );
    }
    await selectTestContourConversation(page, persisted.identity, timeoutMs);
    return {
      identity: persisted.identity,
      setup: "reconcile-send",
      setupCommandId: null,
      setupAcknowledged: null,
      pendingSend: pending,
      stateFile,
    };
  }
  const plan = pending?.action === "new-task"
    ? { kind: "reconcile-new-task", params: pending.params }
    : planTestContourSmokeConversation(snapshot, saved, model);
  let identity = plan.identity ?? null;
  let setupCommandId = null;
  let setupAcknowledged = null;
  if (!identity) {
    const operation = pending ?? {
      action: "new-task",
      commandId: commandIdFactory(),
      phase: "prepared",
      params: plan.params,
    };
    setupCommandId = operation.commandId;
    if (!pending) await writeSmokeConversationState(stateFile, persisted.identity, operation);
    let accepted = operation.phase === "accepted" ? operation.accepted : null;
    if (!accepted) {
      const created = await requestTestContourControl(page, {
        action: operation.action,
        params: operation.params,
        commandId: operation.commandId,
        timeoutMs,
        acknowledge: false,
      });
      identity = exactCreatedConversation(operation, created.result, created.receiptId);
      accepted = { ...identity };
      await writeSmokeConversationState(stateFile, identity, {
        ...operation,
        phase: "accepted",
        accepted,
      });
    } else {
      identity = normalizedIdentity(accepted);
    }
    if (!identity.workspaceId || !identity.streamId || identity.provider !== "codex" || !identity.threadId) {
      throw new Error(`Test Contour new-task returned an incomplete identity for command ${setupCommandId}`);
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator("[data-workspace]").waitFor({ state: "visible", timeout: timeoutMs });
    const reloaded = (await requestTestContourControl(page, {
      action: "snapshot",
      timeoutMs,
    })).result;
    const verification = planTestContourSmokeConversation(reloaded, {
      version: SMOKE_CONVERSATION_STATE_VERSION,
      ...identity,
    }, model);
    if (verification.kind !== "reuse") {
      throw new Error(`Test Contour did not persist the created smoke conversation for command ${setupCommandId}`);
    }
    setupAcknowledged = await acknowledgeTestContourControl(page, setupCommandId, timeoutMs);
    await writeSmokeConversationState(stateFile, identity);
  }
  await selectTestContourConversation(page, identity, timeoutMs);
  return {
    identity,
    setup: plan.kind,
    setupCommandId,
    setupAcknowledged,
    stateFile,
  };
}

export function exactTestContourResponsePattern(response) {
  const escaped = String(response ?? "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*$`, "u");
}

export function isTestContourModelSettingResponse(response, model) {
  if (!response?.url?.().endsWith("/api/control") || response.request?.().method?.() !== "POST") return false;
  try {
    const payload = JSON.parse(response.request().postData() || "{}");
    return payload.action === "update-setting"
      && payload.params?.name === "model"
      && payload.params?.value === model;
  } catch {
    return false;
  }
}

export async function selectTestContourModel(page, model, timeoutMs) {
  const normalizedModel = String(model ?? "").trim();
  if (!normalizedModel) throw new Error("Test Contour smoke model is required");
  const settingsToggle = page.locator("[data-dialog-settings-toggle]");
  await settingsToggle.waitFor({ state: "visible", timeout: timeoutMs });
  await settingsToggle.click();
  const modelSelect = page.locator('select[data-dialog-options="model"]');
  await modelSelect.waitFor({ state: "attached", timeout: timeoutMs });
  await modelSelect.locator(`option[value="${normalizedModel}"]`)
    .waitFor({ state: "attached", timeout: timeoutMs })
    .catch(() => {});
  const availableModels = await modelSelect.locator("option").evaluateAll((options) => (
    options.map((option) => String(option.value))
  ));
  if (!availableModels.includes(normalizedModel)) {
    throw new Error(
      `Test Contour model is not selectable: ${normalizedModel}; available=${availableModels.join(",")}`,
    );
  }
  if (await modelSelect.inputValue() === normalizedModel) {
    await page.locator("[data-dialog-settings-close]").click();
    return;
  }
  const settingResponse = page.waitForResponse(
    (response) => isTestContourModelSettingResponse(response, normalizedModel),
    { timeout: timeoutMs },
  );
  await modelSelect.selectOption(normalizedModel, { force: true });
  if (await modelSelect.inputValue() !== normalizedModel) {
    throw new Error(`Test Contour did not select model: ${normalizedModel}`);
  }
  const response = await settingResponse;
  if (!response.ok()) throw new Error(`Test Contour model setting failed: HTTP ${response.status()}`);
  await page.locator("[data-dialog-settings-close]").click();
}

function testContourSendRequest(request, expected) {
  if (!request?.url?.().endsWith("/api/control") || request.method?.() !== "POST") return null;
  try {
    const payload = JSON.parse(request.postData() || "{}");
    const params = payload.params ?? {};
    if (
      payload.action !== "send-message"
      || params.text !== expected.probe
      || params.streamId !== expected.streamId
      || params.provider !== expected.provider
      || params.threadId !== expected.threadId
    ) return null;
    return {
      action: payload.action,
      commandId: String(payload.commandId ?? "").trim(),
      clientUserMessageId: String(params.clientUserMessageId ?? "").trim(),
      streamId: String(params.streamId ?? "").trim(),
      provider: String(params.provider ?? "").trim(),
      threadId: String(params.threadId ?? "").trim(),
      params: structuredClone(params),
    };
  } catch {
    return null;
  }
}

export async function observeTestContourSend(page, {
  identity,
  probe = TEST_CONTOUR_PROBE,
  timeoutMs,
  click,
  persistPrepared = null,
  persistAccepted = null,
  acknowledgeAccepted = null,
  persistSettled = null,
} = {}) {
  const expected = { ...normalizedIdentity(identity), probe };
  let routedRequest = null;
  let releaseRoutedRequest;
  let rejectRoutedRequest;
  let routeHandler = null;
  const routedRequestPending = typeof persistPrepared === "function"
    ? new Promise((resolve, reject) => {
      releaseRoutedRequest = resolve;
      rejectRoutedRequest = reject;
    }).then((value) => ({ value }), (error) => ({ error }))
    : null;
  if (routedRequestPending) {
    routeHandler = async (route) => {
      const request = route.request();
      let body = null;
      try { body = JSON.parse(request.postData() || "{}"); } catch {}
      if (
        body?.action === "send-message"
        && testContourSendRequest(request, expected)
      ) {
        const exact = testContourSendRequest(request, expected);
        try {
          if (!routedRequest) {
            await persistPrepared({
              action: exact.action,
              commandId: exact.commandId,
              phase: "prepared",
              params: exact.params,
            });
            routedRequest = request;
            releaseRoutedRequest(request);
          } else if (
            exact.commandId !== testContourSendRequest(routedRequest, expected)?.commandId
            || exact.clientUserMessageId !== testContourSendRequest(routedRequest, expected)?.clientUserMessageId
          ) {
            throw new Error("Test Contour UI changed send-message identity during one operation");
          }
          await route.continue();
        } catch (error) {
          rejectRoutedRequest(error);
          await route.abort("failed").catch(() => {});
        }
        return;
      }
      if (
        body?.commandId
        && routedRequest
        && request.url().endsWith("/api/control/ack")
        && body.commandId === testContourSendRequest(routedRequest, expected)?.commandId
      ) {
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"retired":false}' });
        return;
      }
      await route.continue();
    };
    await page.route("**/api/control*", routeHandler);
  }
  const requestPending = routedRequestPending ?? page.waitForRequest(
    (request) => Boolean(testContourSendRequest(request, expected)),
    { timeout: timeoutMs },
  ).then((value) => ({ value }), (error) => ({ error }));
  const responsePending = page.waitForResponse(
    (response) => Boolean(testContourSendRequest(response.request?.(), expected)),
    { timeout: timeoutMs },
  ).then((value) => ({ value }), (error) => ({ error }));
  try {
    await click();
    const requestOutcome = await requestPending;
    if (requestOutcome.error) {
      await responsePending;
      throw new Error(`Test Contour send-message was not dispatched: ${boundedDiagnostic(requestOutcome.error.message)}`);
    }
    const requestIdentity = testContourSendRequest(requestOutcome.value, expected);
    if (!requestIdentity?.commandId || !requestIdentity.clientUserMessageId) {
      throw new Error("Test Contour send-message request has no exact command identity");
    }
    const responseOutcome = await responsePending;
    if (responseOutcome.error) {
      throw new Error(
        `Test Contour send-message outcome is unknown; command ${requestIdentity.commandId} was not retried: ${boundedDiagnostic(responseOutcome.error.message)}`,
      );
    }
    const response = responseOutcome.value;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok() || payload?.ok === false) {
      throw new Error(
        `Test Contour send-message failed: HTTP ${response.status()}; command ${requestIdentity.commandId}; ${boundedDiagnostic(payload?.error ?? "request rejected")}`,
      );
    }
    const operation = {
      action: requestIdentity.action,
      commandId: requestIdentity.commandId,
      phase: "prepared",
      params: requestIdentity.params,
    };
    let accepted;
    try {
      accepted = exactAcceptedSend(operation, payload?.result ?? {}, payload?.receiptId, expected);
    } catch (error) {
      exactQueuedSend(operation, payload?.result ?? {}, payload?.receiptId, expected);
      accepted = await waitForExactAcceptedReceipt(page, operation, expected, timeoutMs);
    }
    await persistAccepted?.({ ...operation, phase: "accepted", accepted });
    if (routeHandler) await page.unroute("**/api/control*", routeHandler);
    routeHandler = null;
    await acknowledgeAccepted?.(accepted.commandId);
    await persistSettled?.();
    return accepted;
  } finally {
    if (routeHandler) await page.unroute("**/api/control*", routeHandler).catch(() => {});
  }
}

export async function reconcileTestContourSend(page, { operation, identity, stateFile, timeoutMs } = {}) {
  const exactOperation = normalizedOperation(operation);
  if (!exactOperation || exactOperation.action !== "send-message") {
    throw new Error("Test Contour has no durable send-message operation to reconcile");
  }
  let accepted = exactOperation.phase === "accepted" ? exactOperation.accepted : null;
  if (!accepted) {
    const response = await requestTestContourControl(page, {
      action: exactOperation.action,
      params: exactOperation.params,
      commandId: exactOperation.commandId,
      timeoutMs,
      acknowledge: false,
    });
    try {
      accepted = exactAcceptedSend(exactOperation, response.result, response.receiptId, identity);
    } catch (error) {
      exactQueuedSend(exactOperation, response.result, response.receiptId, identity);
      accepted = await waitForExactAcceptedReceipt(page, exactOperation, identity, timeoutMs);
    }
    await writeSmokeConversationState(stateFile, identity, {
      ...exactOperation,
      phase: "accepted",
      accepted,
    });
  } else {
    accepted = exactAcceptedSend(
      exactOperation,
      { accepted: true, ...accepted },
      exactOperation.commandId,
      identity,
    );
  }
  await acknowledgeTestContourControl(page, exactOperation.commandId, timeoutMs);
  await writeSmokeConversationState(stateFile, identity);
  return accepted;
}

export function locateTestContourResponse(page, { streamId, turnId, response } = {}) {
  const exactStreamId = String(streamId ?? "").trim();
  const exactTurnId = String(turnId ?? "").trim();
  if (!exactStreamId || !exactTurnId) throw new Error("Test Contour response identity is incomplete");
  return page.locator(
    `[data-stream-chat-task-id="${selectorValue(exactStreamId)}"]`
      + ` .msg-agent[data-turn-id="${selectorValue(exactTurnId)}"] .msg-body`,
  ).filter({ hasText: exactTestContourResponsePattern(response) }).last();
}

function playwrightRuntime(automationRoot) {
  const require = createRequire(path.join(automationRoot, "package.json"));
  return require("playwright-core");
}

async function verifySameTabLocalAccess(browser, protectedUrl, timeoutMs) {
  const target = new URL(protectedUrl);
  const accessHash = target.hash;
  if (!/^#access=[A-Za-z0-9_-]{43,128}$/u.test(accessHash)) {
    throw new Error("Test Contour URL has no protected local access secret");
  }
  target.hostname = target.hostname === "localhost" ? "127.0.0.1" : "localhost";
  target.hash = "";
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator(".browser-auth[data-browser-auth]")
      .waitFor({ state: "visible", timeout: timeoutMs });
    await page.evaluate((hash) => { window.location.hash = hash; }, accessHash);
    await page.waitForFunction(
      () => !window.location.hash.startsWith("#access="),
      null,
      { timeout: timeoutMs },
    );
    await page.locator("[data-workspace]").waitFor({ state: "visible", timeout: timeoutMs });
    if (page.url().includes("#access=")) {
      throw new Error("Test Contour kept the local access secret in the address bar");
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator("[data-workspace]").waitFor({ state: "visible", timeout: timeoutMs });
    if (await page.locator(".browser-auth[data-browser-auth]").isVisible()) {
      throw new Error("Test Contour lost the local session after a browser reload");
    }
  } finally {
    await page.close();
  }
}

export async function runTestContourUiSmoke({
  url,
  automationRoot,
  artifactsDirectory,
  withAgent = true,
  model = "",
  probeResponse = TEST_CONTOUR_PROBE_RESPONSE,
  isolatedFakeProvider = false,

  timeoutMs = 180_000,
  launchOptions = { channel: "msedge", headless: true },
} = {}) {
  if (!url) throw new Error("Test Contour URL is required");
  if (withAgent && isolatedFakeProvider !== true) {
    throw new Error("Test Contour agent smoke requires the verified isolated fake provider");
  }
  const { chromium } = playwrightRuntime(automationRoot);
  await mkdir(artifactsDirectory, { recursive: true });
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response ${response.status()}: ${response.url()}`);
  });
  try {
    await verifySameTabLocalAccess(browser, url, timeoutMs);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator("[data-workspace]").waitFor({ state: "visible", timeout: timeoutMs });
    const title = await page.title();
    if (title !== "Agent Hub") throw new Error(`Unexpected Test Contour title: ${title}`);
    assertTestContourShellContent(await page.locator("body").innerText());

    await page.locator('[data-view-button="dashboard"]').click();
    await page.locator('html[data-view="dashboard"]').waitFor({ state: "attached", timeout: 10_000 });
    await page.locator('[data-view-button="chat"]').click();
    await page.locator('html[data-view="chat"]').waitFor({ state: "attached", timeout: 10_000 });

    let conversation = null;
    let send = null;
    if (withAgent) {
      await selectTestContourModel(page, model, timeoutMs);
      conversation = await prepareTestContourSmokeConversation(page, {
        artifactsDirectory,
        model,
        timeoutMs,
      });
      if (conversation.pendingSend) {
        send = await reconcileTestContourSend(page, {
          operation: conversation.pendingSend,
          identity: conversation.identity,
          stateFile: conversation.stateFile,
          timeoutMs,
        });
      } else {
        const input = page.locator("[data-composer-input]");
        await input.waitFor({ state: "visible", timeout: timeoutMs });
        await input.fill(TEST_CONTOUR_PROBE);
        send = await observeTestContourSend(page, {
          identity: conversation.identity,
          timeoutMs,
          click: () => page.locator("[data-composer-send]").click(),
          persistPrepared: (operation) => writeSmokeConversationState(
            conversation.stateFile,
            conversation.identity,
            operation,
          ),
          persistAccepted: (operation) => writeSmokeConversationState(
            conversation.stateFile,
            conversation.identity,
            operation,
          ),
          acknowledgeAccepted: (commandId) => acknowledgeTestContourControl(page, commandId, timeoutMs),
          persistSettled: () => writeSmokeConversationState(conversation.stateFile, conversation.identity),
        });
      }
      const response = locateTestContourResponse(page, { ...send, response: probeResponse });
      await response.waitFor({ state: "visible", timeout: timeoutMs });
      const responseText = (await response.innerText()).trim();
      if (responseText !== probeResponse) {
        throw new Error(`Unexpected Test Contour response: ${JSON.stringify(responseText)}`);
      }
    }

    const screenshot = path.join(artifactsDirectory, "ui-smoke.png");
    await page.screenshot({ path: screenshot, fullPage: false });
    if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`);
    return {
      title,
      screenshot,
      withAgent,
      sameTabAuth: true,
      ...(conversation ? { conversation: conversation.identity, setup: conversation.setup } : {}),
      ...(send ? send : {}),
      errors: [],
    };
  } finally {
    await browser.close();
  }
}
