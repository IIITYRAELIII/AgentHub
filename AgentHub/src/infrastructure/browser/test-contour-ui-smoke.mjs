import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const TEST_CONTOUR_PROBE = "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";
export const TEST_CONTOUR_PROBE_RESPONSE = "AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";

const SMOKE_CONVERSATION_STATE_VERSION = 1;
const SMOKE_CONVERSATION_STATE_FILE = "ui-smoke-conversation.json";
const SMOKE_WORKSPACE_NAME = "Agent Hub Test Contour Smoke";
const SMOKE_STREAM_NAME = "Smoke";

function normalizedIdentity(value = {}) {
  return {
    workspaceId: String(value.workspaceId ?? "").trim(),
    streamId: String(value.streamId ?? "").trim(),
    provider: String(value.provider ?? "").trim().toLowerCase(),
    threadId: String(value.threadId ?? "").trim(),
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
  const saved = savedState?.version === SMOKE_CONVERSATION_STATE_VERSION
    ? normalizedIdentity(savedState)
    : normalizedIdentity();
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
      if (response.ok && payload?.ok !== false && request.commandId && payload?.receiptId === request.commandId) {
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
  }, { action, params, commandId, timeoutMs });
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

async function readSmokeConversationState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeSmokeConversationState(file, identity) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    version: SMOKE_CONVERSATION_STATE_VERSION,
    ...normalizedIdentity(identity),
  }, null, 2)}\n`, "utf8");
  await rename(temporary, file);
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
  const snapshot = (await requestTestContourControl(page, {
    action: "snapshot",
    timeoutMs,
  })).result;
  const saved = await readSmokeConversationState(stateFile);
  const plan = planTestContourSmokeConversation(snapshot, saved, model);
  let identity = plan.identity ?? null;
  let setupCommandId = null;
  let setupAcknowledged = null;
  if (!identity) {
    setupCommandId = commandIdFactory();
    const created = await requestTestContourControl(page, {
      action: "new-task",
      params: plan.params,
      commandId: setupCommandId,
      timeoutMs,
    });
    setupAcknowledged = created.acknowledged;
    identity = normalizedIdentity({
      workspaceId: created.result?.createdTask?.workspaceId,
      streamId: created.result?.createdTask?.streamId,
      provider: created.result?.createdTask?.provider,
      threadId: created.result?.createdTask?.threadId,
    });
    if (!identity.workspaceId) {
      const createdStream = orderedWorkspaces(created.result)
        .flatMap((workspace) => (workspace.streams ?? []).map((stream) => ({ workspace, stream })))
        .find(({ stream }) => String(stream?.id ?? "") === identity.streamId);
      identity.workspaceId = String(createdStream?.workspace?.id ?? "");
    }
    if (!identity.workspaceId || !identity.streamId || identity.provider !== "codex" || !identity.threadId) {
      throw new Error(`Test Contour new-task returned an incomplete identity for command ${setupCommandId}`);
    }
    await writeSmokeConversationState(stateFile, identity);
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
      commandId: String(payload.commandId ?? "").trim(),
      clientUserMessageId: String(params.clientUserMessageId ?? "").trim(),
      streamId: String(params.streamId ?? "").trim(),
      provider: String(params.provider ?? "").trim(),
      threadId: String(params.threadId ?? "").trim(),
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
} = {}) {
  const expected = { ...normalizedIdentity(identity), probe };
  const requestPending = page.waitForRequest(
    (request) => Boolean(testContourSendRequest(request, expected)),
    { timeout: timeoutMs },
  ).then((value) => ({ value }), (error) => ({ error }));
  const responsePending = page.waitForResponse(
    (response) => Boolean(testContourSendRequest(response.request?.(), expected)),
    { timeout: timeoutMs },
  ).then((value) => ({ value }), (error) => ({ error }));
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
  const result = payload?.result ?? {};
  const accepted = {
    ...requestIdentity,
    streamId: String(result.streamId ?? requestIdentity.streamId).trim(),
    provider: String(result.provider ?? requestIdentity.provider).trim(),
    threadId: String(result.threadId ?? requestIdentity.threadId).trim(),
    turnId: String(result.turnId ?? "").trim(),
  };
  if (
    result.accepted !== true
    || String(payload.receiptId ?? "").trim() !== requestIdentity.commandId
    || accepted.streamId !== expected.streamId
    || accepted.provider !== expected.provider
    || accepted.threadId !== expected.threadId
    || String(result.clientUserMessageId ?? "").trim() !== accepted.clientUserMessageId
    || !accepted.turnId
  ) {
    throw new Error(
      `Test Contour send-message returned an invalid acceptance for command ${requestIdentity.commandId}`,
    );
  }
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
    const bodyText = (await page.locator("body").innerText()).trim();
    if (bodyText.length < 100 || !bodyText.includes("Диалоги")) {
      throw new Error("Agent Hub shell did not render meaningful content");
    }

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
      const input = page.locator("[data-composer-input]");
      await input.waitFor({ state: "visible", timeout: timeoutMs });
      await input.fill(TEST_CONTOUR_PROBE);
      send = await observeTestContourSend(page, {
        identity: conversation.identity,
        timeoutMs,
        click: () => page.locator("[data-composer-send]").click(),
      });
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
