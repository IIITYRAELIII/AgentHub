import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { callDesktopControl } from "../../desktop-control.mjs";
import {
  runTestContourUiSmoke,
  TEST_CONTOUR_PROBE,
} from "../../src/infrastructure/browser/test-contour-ui-smoke.mjs";
import { localWebAccessUrl } from "../../src/infrastructure/network/loopback-web-access.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import {
  TEST_CONTOUR_FAKE_MODEL,
  TEST_CONTOUR_MODELS,
} from "../../src/runtime/test-contour-manager.mjs";
import {
  CHAT_ID,
  delay,
  FakeTelegramApi,
  stopPid,
  USER_ID,
  waitFor,
} from "../../e2e/telegram-harness.mjs";

// Design §13, scenario 6: the production Test Contour browser smoke against a
// disposable Hub with historical named Threads, live unnamed Threads and an
// empty catalog. The Hub, Web UI, desktop control router, durable message
// ledger and fake Codex App Server are the real production components; no
// provider credentials are used. Evidence is read from the server-side ledger,
// the provider state and a transport proxy, never from the smoke's own claims.

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const AUTOMATION_ROOT = path.resolve(
  String(process.env.AGENT_HUB_TEST_AUTOMATION_ROOT ?? "").trim() || ROOT,
);
const BOT_FILE = path.join(ROOT, "agent-hub-main.mjs");
const FAKE_CODEX_FILE = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");
const PROBE_MARKER = "AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";
const PROBE_RESPONSE = "Принято";
const SMOKE_TIMEOUT_MS = 60_000;
const EARLY_REFUSAL_LIMIT_MS = 10_000;
const INJECTED_REFUSAL = "scenario6 injected send refusal";
const HISTORICAL_THREAD = "20000000-0000-4000-8000-000000000001";
const LIVE_UNNAMED_THREADS = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fakeThread(id, cwd, { name = "" } = {}) {
  return {
    id,
    cwd,
    name,
    preview: "",
    updatedAt: Math.floor(Date.now() / 1000),
    turns: [],
    model: TEST_CONTOUR_FAKE_MODEL,
    reasoningEffort: "medium",
    archived: false,
  };
}

// A named Stream whose Thread the provider no longer knows, with a completed
// historical probe turn that already rendered the expected answer.
async function seedHistoricalNamedStream({ dataDir, projectRoot }) {
  const journalFile = path.join(dataDir, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile: journalFile });
  await catalog.load();
  let streamId;
  try {
    const { stream } = catalog.createWorkspaceWithStream({
      name: "History",
      streamName: "Archived named",
      settings: { provider: "codex", model: TEST_CONTOUR_FAKE_MODEL },
    });
    streamId = stream.id;
    catalog.bindThread({ provider: "codex", threadId: HISTORICAL_THREAD, streamId, projectRoot, source: "migration" });
  } finally {
    catalog.close();
  }
  const task = {
    provider: "codex",
    threadId: HISTORICAL_THREAD,
    projectRoot,
    title: "Archived named",
    running: false,
    updatedAtMs: Date.now() - 86_400_000,
  };
  const store = new LocalTaskSyncStore({ filePath: path.join(dataDir, "task-sync.json"), databaseFile: journalFile });
  await store.load();
  try {
    await store.recordCatalog([task], Date.now() - 86_400_000);
    await store.recordHistory(task, [{
      id: "historical-probe-turn",
      prompt: TEST_CONTOUR_PROBE,
      answer: PROBE_RESPONSE,
      status: "completed",
      active: false,
      completed: true,
      messages: [
        { itemId: "historical-probe-turn:user", role: "user", text: TEST_CONTOUR_PROBE },
        { itemId: "historical-probe-turn:agent:final", role: "agent", text: PROBE_RESPONSE },
      ],
    }]);
  } finally {
    store.close();
  }
  return { historicalStreamId: streamId };
}

async function startScenarioHub(t, { liveThreads = [], seed = async () => ({}) } = {}) {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "hub260-scenario6-"));
  const dataDir = path.join(runtimeRoot, "data");
  const projectRoot = path.join(runtimeRoot, "project");
  const configPath = path.join(runtimeRoot, "config.json");
  const codexStatePath = path.join(runtimeRoot, "fake-codex-state.json");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const port = await freePort();
  // The Web App component requires the Telegram component; the contour uses a
  // loopback-only fake Bot API, and so does this fixture.
  const telegram = new FakeTelegramApi();
  await telegram.start();
  t.after(() => telegram.stop());
  await writeFile(configPath, `${JSON.stringify({
    components: {
      telegram: true,
      miniApp: true,
      androidApp: false,
      sharedDashboardBot: false,
      codexContextCleanup: false,
    },
    telegramBotToken: "123:scenario6-token",
    telegramApiBaseUrl: telegram.baseUrl,
    allowedUserIds: [USER_ID],
    allowedChatIds: [CHAT_ID],
    privateChatsOnly: true,
    provider: "codex",
    projectRoot,
    projects: [{ name: "Scenario 6", path: projectRoot }],
    dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", codexStatePath, "--accept-all"],
    codexRolloutContext: { enabled: false },
    codexModel: TEST_CONTOUR_FAKE_MODEL,
    codexReasoningEffort: "medium",
    codexModels: TEST_CONTOUR_MODELS.map((model) => ({ ...model })),
    miniApp: { enabled: true, host: "127.0.0.1", port, quickTunnel: { enabled: false }, worker: { enabled: false } },
    showProjectButton: false,
    voiceEnabled: false,
    ttsEnabled: false,
    progressStartDelayMs: 50,
  }, null, 2)}\n`, "utf8");
  await writeFile(codexStatePath, `${JSON.stringify({
    nextThread: 90,
    nextTurn: 90,
    nextMessage: 90,
    threads: liveThreads.map((id) => fakeThread(id, projectRoot)),
    crashedOnce: false,
    requestCounts: {},
  }, null, 2)}\n`, "utf8");
  const seeded = await seed({ dataDir, projectRoot });

  const hub = spawn(process.execPath, [BOT_FILE], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_HUB_CONFIG: configPath,
      AGENT_HUB_RUNTIME_ROOT: runtimeRoot,
      AGENT_HUB_LAUNCHER: "",
      AGENT_HUB_DISABLE_SECRET_ACL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  hub.stdout.setEncoding("utf8");
  hub.stderr.setEncoding("utf8");
  hub.stdout.on("data", (chunk) => { stdout += chunk; });
  hub.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (hub.exitCode == null) {
      hub.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => hub.once("exit", resolve)), delay(2_000)]);
    }
    if (hub.exitCode == null) await stopPid(hub.pid);
    if (process.env.SCENARIO6_KEEP === "1") return;
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  try {
    // The shared waitFor keeps polling through errors, so an exited Hub is raced
    // explicitly instead of being waited out.
    await Promise.race([
      waitFor(() => (/Agent Hub ready/u.test(stdout) ? true : null), "scenario 6 hub ready", 60_000),
      new Promise((_, reject) => hub.once("exit", (code) => reject(new Error(`Agent Hub exited with ${code}`)))),
    ]);
  } catch (error) {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
  }
  const secret = String(await readFile(path.join(runtimeRoot, "local-web.secret"), "utf8")).trim();
  const startupView = await catalogView(runtimeRoot);
  return {
    runtimeRoot,
    dataDir,
    port,
    secret,
    seeded,
    // Streams that existed before the smoke: seeded history plus the Hub's own
    // startup system Streams. A proven target is never one of these.
    preexistingStreamIds: new Set(startupView.streams.map((stream) => stream.streamId)),
    startupView,
    url: localWebAccessUrl(`http://127.0.0.1:${port}/`, secret),
    probeCommands: () => probeCommands(dataDir),
    providerProbeTurns: async () => providerProbeTurns(codexStatePath),
    view: () => catalogView(runtimeRoot),
  };
}

async function catalogView(runtimeRoot) {
  const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
  return {
    streams: (snapshot.workspaces ?? []).flatMap((workspace) => (workspace.streams ?? []).map((stream) => ({
      streamId: stream.id ?? stream.streamId ?? null,
      name: stream.name ?? null,
      workspace: workspace.name ?? null,
      model: stream.settings?.model ?? null,
    }))),
  };
}

function probeCommands(dataDir) {
  const database = new DatabaseSync(path.join(dataDir, "message-command-ledger.sqlite"), { readOnly: true });
  try {
    return database.prepare(`
      SELECT client_user_message_id AS id, state, item_json AS item, result_json AS result
      FROM message_commands ORDER BY accepted_at_ms
    `).all().flatMap((row) => {
      const item = JSON.parse(row.item ?? "{}");
      if (!JSON.stringify(item).includes(PROBE_MARKER)) return [];
      const result = JSON.parse(row.result ?? "null");
      return [{
        id: row.id,
        itemId: item.id ?? null,
        state: row.state,
        streamId: item.streamId ?? result?.streamId ?? null,
        threadId: item.threadId ?? result?.threadId ?? null,
      }];
    });
  } finally {
    database.close();
  }
}

// Authoritative control receipts of the Hub, keyed by the desktop command id.
function durableControlReceipts(dataDir, commandIds) {
  if (!commandIds.length) return [];
  const database = new DatabaseSync(path.join(dataDir, "desktop-control-receipts.sqlite"), { readOnly: true });
  try {
    const placeholders = commandIds.map(() => "?").join(", ");
    return database.prepare(`
      SELECT id, action, phase, fingerprint, result_json AS result
      FROM durable_command_receipts WHERE id IN (${placeholders})
    `).all(...commandIds).map((row) => {
      const stored = JSON.parse(row.result ?? "null");
      const result = stored?.result ?? stored;
      return {
        commandId: row.id,
        action: row.action,
        phase: row.phase,
        fingerprint: row.fingerprint,
        resultId: result?.id ?? null,
        clientUserMessageId: result?.clientUserMessageId ?? null,
      };
    });
  } finally {
    database.close();
  }
}

function parsedReply(text) {
  try {
    const payload = JSON.parse(text ?? "");
    const result = payload?.result ?? {};
    return {
      ok: payload?.ok === true,
      resultId: result.id ?? null,
      clientUserMessageId: result.clientUserMessageId ?? null,
      threadId: result.threadId ?? null,
      streamId: result.streamId ?? null,
      queued: result.queued ?? null,
      duplicate: result.duplicate ?? null,
      turnId: result.turnId ?? null,
    };
  } catch {
    return { ok: false, unparsable: true };
  }
}

// Sanitized evidence (no access secret or URL) is kept on PASS and on FAIL when
// SCENARIO6_EVIDENCE_DIR names a directory.
async function saveEvidence(name, evidence) {
  const directory = String(process.env.SCENARIO6_EVIDENCE_DIR ?? "").trim();
  if (!directory) return null;
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `scenario6-${name}-evidence.json`);
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return file;
}

async function providerProbeTurns(codexStatePath) {
  const state = JSON.parse(await readFile(codexStatePath, "utf8"));
  return state.threads.flatMap((thread) => thread.turns
    .filter((turn) => String(turn.prompt ?? "").includes(PROBE_MARKER))
    .map((turn) => ({ threadId: thread.id, threadModel: thread.model, turnId: turn.id, status: turn.status })));
}

// A loopback proxy in front of the Hub Web App. It forwards everything and
// records every request that carries the probe text. `refuse` answers the first
// probe request with a definite refusal without forwarding it; `drop-response`
// forwards it and then destroys the browser connection after the Hub replied.
async function startProbeProxy(t, hub, { mode = "forward" } = {}) {
  const probeRequests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const carriesProbe = request.method === "POST" && body.includes(PROBE_MARKER);
      let entry = null;
      if (carriesProbe) {
        let payload = {};
        try { payload = JSON.parse(body.toString("utf8")); } catch {}
        entry = {
          atMs: Date.now(),
          url: request.url,
          action: payload.action ?? null,
          commandId: payload.commandId ?? null,
          clientUserMessageId: payload.params?.clientUserMessageId ?? null,
        };
        probeRequests.push(entry);
      }
      if (carriesProbe && mode === "refuse" && probeRequests.length === 1) {
        response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(`${JSON.stringify({ ok: false, error: INJECTED_REFUSAL })}\n`);
        return;
      }
      const upstream = http.request({
        host: "127.0.0.1",
        port: hub.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      }, (upstreamResponse) => {
        if (carriesProbe && mode === "drop-response" && probeRequests.length === 1) {
          const droppedChunks = [];
          upstreamResponse.on("data", (chunk) => droppedChunks.push(chunk));
          upstreamResponse.on("end", () => {
            entry.hubStatus = upstreamResponse.statusCode;
            entry.hubReply = Buffer.concat(droppedChunks).toString("utf8");
            probeRequests[0].droppedAfterHubReplyMs = Date.now();
            request.socket.destroy();
          });
          return;
        }
        if (entry) {
          const replyChunks = [];
          upstreamResponse.on("data", (chunk) => replyChunks.push(chunk));
          upstreamResponse.on("end", () => {
            entry.hubStatus = upstreamResponse.statusCode;
            entry.hubReply = Buffer.concat(replyChunks).toString("utf8");
          });
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => request.socket.destroy());
      upstream.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    probeRequests,
    url: localWebAccessUrl(`http://127.0.0.1:${port}/`, hub.secret),
  };
}

async function runProductionSmoke(hub, { url = hub.url } = {}) {
  const startedAtMs = Date.now();
  try {
    const result = await runTestContourUiSmoke({
      url,
      automationRoot: AUTOMATION_ROOT,
      artifactsDirectory: path.join(hub.runtimeRoot, "artifacts"),
      withAgent: true,
      model: TEST_CONTOUR_FAKE_MODEL,
      probeResponse: PROBE_RESPONSE,
      // Accepted by the exact-smoke owner; ignored by owners without the guard.
      isolatedFakeProvider: true,
      timeoutMs: SMOKE_TIMEOUT_MS,
    });
    return { ok: true, startedAtMs, finishedAtMs: Date.now(), result };
  } catch (error) {
    return { ok: false, startedAtMs, finishedAtMs: Date.now(), error: String(error?.message ?? error) };
  }
}

function describe(value) {
  return JSON.stringify(value, null, 1).slice(0, 3_000);
}

// The single probe must land on a Thread the provider knows, under the fake
// model, bound through the durable command to the same Stream/Thread, and
// neither on the historical Thread nor on a Stream that existed before the
// smoke (seeded history or the Hub's own startup system Streams).
async function assertExactSendableProbe(hub, outcome) {
  const commands = hub.probeCommands();
  const turns = await hub.providerProbeTurns();
  const evidence = describe({ outcome, commands, turns, preexisting: hub.startupView });
  assert.equal(outcome.ok, true, `production smoke did not complete: ${evidence}`);
  assert.equal(commands.length, 1, `expected exactly one durable probe command: ${evidence}`);
  assert.equal(turns.length, 1, `expected exactly one provider probe turn: ${evidence}`);
  const [command] = commands;
  const [turn] = turns;
  assert.equal(command.threadId, turn.threadId, `durable command and provider turn target different Threads: ${evidence}`);
  assert.notEqual(turn.threadId, HISTORICAL_THREAD, `probe was sent to the historical Thread: ${evidence}`);
  assert.equal(turn.threadModel, TEST_CONTOUR_FAKE_MODEL, `probe did not run on the fake provider model: ${evidence}`);
  assert.ok(command.streamId, `durable command has no exact Stream: ${evidence}`);
  assert.equal(hub.preexistingStreamIds.has(command.streamId), false,
    `probe targeted a Stream that existed before the smoke (historical or Hub system Stream): ${evidence}`);
}

test("scenario 6: historical named and live unnamed Threads — the smoke proves one exact sendable target", {  }, async (t) => {
  const hub = await startScenarioHub(t, {
    liveThreads: LIVE_UNNAMED_THREADS,
    seed: seedHistoricalNamedStream,
  });
  const outcome = await runProductionSmoke(hub);
  await assertExactSendableProbe(hub, outcome);
});

test("scenario 6: empty catalog — standard setup creates and proves its own sendable target", {  }, async (t) => {
  const hub = await startScenarioHub(t, {});
  const outcome = await runProductionSmoke(hub);
  await assertExactSendableProbe(hub, outcome);
});

test("scenario 6: a definite send refusal fails the smoke early with the refusal, without a provider effect", {  }, async (t) => {
  const hub = await startScenarioHub(t, { liveThreads: LIVE_UNNAMED_THREADS });
  const proxy = await startProbeProxy(t, hub, { mode: "refuse" });
  const outcome = await runProductionSmoke(hub, { url: proxy.url });
  const evidence = describe({ outcome, probeRequests: proxy.probeRequests, commands: hub.probeCommands() });
  assert.equal(outcome.ok, false, `smoke passed although its send was refused: ${evidence}`);
  assert.ok(proxy.probeRequests.length >= 1, `smoke never issued the probe send: ${evidence}`);
  const refusedAtMs = proxy.probeRequests[0].atMs;
  assert.ok(outcome.finishedAtMs - refusedAtMs <= EARLY_REFUSAL_LIMIT_MS,
    `smoke reported the refusal ${outcome.finishedAtMs - refusedAtMs} ms after it, not early: ${evidence}`);
  assert.match(outcome.error, new RegExp(INJECTED_REFUSAL, "u"), `smoke error does not carry the refusal: ${evidence}`);
  assert.equal(proxy.probeRequests.length, 1, `smoke resent the probe after a definite refusal: ${evidence}`);
  assert.deepEqual(hub.probeCommands(), [], `refused send reached the durable ledger: ${evidence}`);
  assert.deepEqual(await hub.providerProbeTurns(), [], `refused send reached the provider: ${evidence}`);
});

test("scenario 6: an unknown send outcome is never sent again", {  }, async (t) => {
  const hub = await startScenarioHub(t, { liveThreads: LIVE_UNNAMED_THREADS });
  const proxy = await startProbeProxy(t, hub, { mode: "drop-response" });
  const outcome = await runProductionSmoke(hub, { url: proxy.url });
  const commands = hub.probeCommands();
  const turns = await hub.providerProbeTurns();
  const evidence = describe({ outcome, probeRequests: proxy.probeRequests, commands, turns });
  assert.ok(proxy.probeRequests.length >= 1, `smoke never issued the probe send: ${evidence}`);
  assert.ok(proxy.probeRequests[0].droppedAfterHubReplyMs, `the send reply was not dropped after the Hub accepted it: ${evidence}`);
  // Contract limit (root disposition 2026-09-23): after an unknown outcome a new
  // submission identity or a second effect is forbidden. Reading or reconciling
  // the original durable receipt is allowed, and a second HTTP request is not by
  // itself a violation. A repeated mutation is allowed only when the canonical
  // owner attests idempotent handling; a matching identity string alone does not
  // prove it. The transport count stays in the evidence.
  const identities = new Set(proxy.probeRequests.map((request) => (
    `${request.commandId ?? ""}|${request.clientUserMessageId ?? ""}`
  )));
  assert.equal(identities.size, 1, `the probe was sent again under a new identity after an unknown outcome: ${evidence}`);
  const mutations = proxy.probeRequests.filter((request) => request.action === "send-message");
  if (mutations.length > 1) {
    const durableIds = mutations.map((request) => {
      try { return JSON.parse(request.hubReply ?? "").result?.id ?? null; } catch { return null; }
    });
    assert.ok(durableIds.every((id) => id && id === durableIds[0]),
      `a repeated send mutation was not attested by the Hub as the same durable command: ${evidence}`);
  }
  assert.equal(commands.length, 1, `expected exactly one durable probe command: ${evidence}`);
  assert.equal(turns.length, 1, `expected exactly one provider probe turn: ${evidence}`);
  assert.equal(commands[0].threadId, turns[0].threadId, `durable command and provider turn target different Threads: ${evidence}`);
});

// Narrow deterministic replay case. It fails unless the replay branch is really
// entered, and the replay may only be the owner's existing reconciliation of
// the same durable command: no extra send is produced by this test. Every
// replayed reply must carry the result id of the canonical durable message
// command (MSG-001 ledger, keyed by clientUserMessageId); duplicate:false proves
// nothing. Desktop control receipts are recorded as evidence under both keys and
// must agree when present; their retention is not asserted.
test("scenario 6 replay: an unknown send is reconciled only through the owner's durable receipt", {  }, async (t) => {
  const hub = await startScenarioHub(t, { liveThreads: LIVE_UNNAMED_THREADS });
  const proxy = await startProbeProxy(t, hub, { mode: "drop-response" });
  const outcome = await runProductionSmoke(hub, { url: proxy.url });
  const sends = proxy.probeRequests.filter((request) => request.action === "send-message");
  const firstAtMs = sends[0]?.atMs ?? 0;
  const replies = sends.map((request) => parsedReply(request.hubReply));
  const commandIds = [...new Set(sends.flatMap((request) => [request.commandId, request.clientUserMessageId]).filter(Boolean))];
  const receipts = durableControlReceipts(hub.dataDir, commandIds);
  const commands = hub.probeCommands();
  const turns = await hub.providerProbeTurns();
  const evidence = {
    outcome: { ok: outcome.ok, error: outcome.error ?? null, elapsedMs: outcome.finishedAtMs - outcome.startedAtMs },
    sends: sends.map((request, index) => ({
      atMs: request.atMs - firstAtMs,
      droppedAfterHubReplyMs: request.droppedAfterHubReplyMs ? request.droppedAfterHubReplyMs - firstAtMs : null,
      commandId: request.commandId,
      clientUserMessageId: request.clientUserMessageId,
      hubStatus: request.hubStatus ?? null,
      reply: replies[index],
    })),
    receipts,
    commands,
    turns,
  };
  const file = await saveEvidence("replay", evidence);
  const described = describe({ ...evidence, evidenceFile: file });

  assert.ok(sends.length >= 2, `the replay branch was not entered: ${described}`);
  assert.equal(new Set(sends.map((request) => `${request.commandId}|${request.clientUserMessageId}`)).size, 1,
    `the replay used a new request identity: ${described}`);
  const resultId = replies[0]?.resultId;
  assert.ok(replies.every((reply) => reply.ok && reply.resultId && reply.resultId === resultId),
    `replayed replies do not carry one durable result id: ${described}`);
  assert.ok(receipts.every((receipt) => receipt.action === "send-message" && (!receipt.resultId || receipt.resultId === resultId)),
    `a desktop control receipt disagrees with the replayed reply: ${described}`);
  assert.equal(commands.length, 1, `expected exactly one durable probe command: ${described}`);
  assert.equal(commands[0].id, sends[0].clientUserMessageId, `durable command has another message identity: ${described}`);
  assert.equal(commands[0].itemId, resultId, `reply result id is not the durable command item: ${described}`);
  assert.equal(turns.length, 1, `expected exactly one provider probe turn: ${described}`);
  assert.equal(turns[0].threadId, commands[0].threadId, `provider turn and durable command target different Threads: ${described}`);
  assert.ok(replies.every((reply) => reply.threadId === commands[0].threadId),
    `a replayed reply names another Thread: ${described}`);
});
