import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { callDesktopControl } from "../../desktop-control.mjs";
import { RuntimeStateStore, readRuntimeState } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { messageRequestFingerprint } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { E2eChildProcessOwner, waitFor } from "../../e2e/telegram-harness.mjs";

const source = path.resolve(import.meta.dirname, "../..");
const threadId = "10000000-0000-4000-8000-000000000476";
const oldTurnId = "20000000-0000-4000-8000-000000000470";
const clientUserMessageId = "new-original-queued-476";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const { mode, streamCount } of [
  ...["notLoaded", "error", "never"].map(mode => ({ mode, streamCount: 1 })),
  { mode: "two streams and next input", streamCount: 2 },
]) {
  test(`two actual cold Hub starts retire local custody without old-turn RPC (${mode})`, { timeout: 45_000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hub-no-old-turn-"));
    const dataDir = path.join(root, "data");
    const projectRoot = path.join(root, "project");
    const fakeState = path.join(root, "provider.json");
    const configFile = path.join(root, "config.json");
    const attachment = path.join(root, "retained-attachment.png");
    const attachmentBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=", "base64");
    const newInputReadyFile = path.join(root, "new-input-ready");
    await Promise.all([dataDir, projectRoot, "home", "appdata", "localappdata"].map(n => mkdir(path.isAbsolute(n) ? n : path.join(root, n), { recursive: true })));
    await writeFile(attachment, attachmentBytes);
    const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(dataDir, "journal.sqlite") });
    const history = new LocalTaskSyncStore({ filePath: path.join(dataDir, "task-sync.json"), databaseFile: path.join(dataDir, "journal.sqlite") });
    const runtime = new RuntimeStateStore({ dataDir });
    const targets = [];
    const queues = [];
    const receipts = [];
    const oldRuns = [];
    const queuedId = "10000000-0000-4000-8000-000000000477";
    const input = [{ type: "text", text: "new explicit input with retained attachment" }, { type: "localImage", path: attachment }];
    try {
      await catalog.load(); await history.load(); await runtime.load();
      const workspace = catalog.createWorkspace({ name: "No old execution" });
      for (let index = 0; index < streamCount; index++) {
        const stream = catalog.createStream({ workspaceId: workspace.id, name: `Exact stream ${index}` });
        catalog.updateStreamSettings(stream.id, { project: projectRoot });
        const target = { workspaceId: workspace.id, streamId: stream.id, provider: "codex",
          threadId: index === 0 ? threadId : "10000000-0000-4000-8000-000000000478", projectRoot };
        targets.push(target);
        catalog.bindThread(target);
        await history.recordHistory(target, [{ id: "retained-final", status: "completed", completed: true,
          messages: [{ role: "agent", itemId: "prior-answer", text: "Retained history" }] }]);
        const createdAt = new Date().toISOString();
        const queued = { ...target, id: queuedId, clientUserMessageId, clientSource: "desktop-control", input,
          temporaryFiles: [attachment], persistentFiles: true, paused: true, manualPaused: true,
          createdAt, conflictKind: "message-intake", telegramDeliveryRequested: false };
        if (index) { queued.id += `-${index}`; queued.clientUserMessageId += `-${index}`; }
        const fingerprint = await messageRequestFingerprint({ text: input[0].text, attachmentIdentities: [] });
        const receipt = { provider: "codex", threadId: target.threadId,
          clientUserMessageId: queued.clientUserMessageId, fingerprint, createdAt,
          result: { accepted: true, queued: true, id: queued.id } };
        queues.push(queued); receipts.push(receipt);
        await runtime.saveDeferredIntake({ item: queued, destination: "queued", receipt });
        const startedAt = new Date(Date.now() - 60_000).toISOString();
        const old = { ...target, id: "old-local-run", turnId: oldTurnId, clientUserMessageId: "old-client",
          status: "running", activityUnknown: true, executionOwner: "hub", observer: false,
          startedAt, responseText: "Retained partial", providerStart: {
            state: "observed", turnId: oldTurnId, clientUserMessageId: "old-client",
            requestedAt: startedAt, acceptedAt: startedAt }, telegramDeliveryRequested: false };
        if (index) { old.id += `-${index}`; old.turnId += `-${index}`;
          old.clientUserMessageId += `-${index}`; old.providerStart.turnId = old.turnId;
          old.providerStart.clientUserMessageId = old.clientUserMessageId; }
        oldRuns.push(old);
      }
      await runtime.save({ activeProvider: "codex", activeProjectRoot: projectRoot, streamId: targets[0].streamId,
        threadIds: { codex: threadId }, activeRuns: oldRuns, queuedInputs: queues, pendingInputs: [],
        desktopMessageReceipts: receipts });
    } finally { await runtime.close(); await history.close(); await catalog.close(); }
    await writeFile(fakeState, JSON.stringify({ nextThread: 477, nextTurn: 477, nextMessage: 1,
      requestCounts: {}, oldTurnProbe: { threadId, threadIds: targets.map(row => row.threadId), mode,
        modes: streamCount === 2 ? Object.fromEntries(targets.map((row, i) => [row.threadId, i ? "never" : "notLoaded"])) : {},
        requests: [], newInputReadyFile }, threads: targets.map(row => ({ id: row.threadId,
        cwd: projectRoot, name: "Exact stream", preview: "", turns: [], updatedAt: 0, model: "fake-codex", reasoningEffort: "medium" })) }));
    await writeFile(configFile, JSON.stringify({ components: { telegram: false, miniApp: false, androidApp: false, codexContextCleanup: false },
      provider: "codex", projectRoot, projects: [{ name: "Owned fixture", path: projectRoot }], dataDir,
      codexExecutable: process.execPath, codexExecutableArgs: [path.join(source, "e2e/fake-codex-app-server.mjs"), "--state", fakeState],
      codexExecutableAutoUpdate: false, createInitialThreadOnStartup: false,
      codexRolloutContext: { enabled: false }, codexRateLimitPolling: false, claudeRateLimitPolling: false,
      guardConcurrentRepositoryWrites: false, taskBoard: { triageEnabled: false }, diagnostics: { sentry: { enabled: false, dsn: "" } } }));
    const owner = new E2eChildProcessOwner({ label: `no old recovery ${mode}`, timeoutMs: 1500 });
    const observations = [];
    try {
      for (let generation = 0; generation < (streamCount === 2 ? 3 : 2); generation++) {
        let stdout = "", stderr = "";
        const started = performance.now();
        const env = { ...process.env, AGENT_HUB_CONFIG: configFile, AGENT_HUB_RUNTIME_ROOT: root,
          AGENT_HUB_LAUNCHER: "", AGENT_HUB_DISABLE_SECRET_ACL: "1",
          HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
          APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"), CODEX_HOME: path.join(root, "home/codex") };
        for (const key of Object.keys(env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SENTRY_DSN)$/iu.test(key)) delete env[key];
        if (process.env.HUB476_PARENT_LOADER) env.NODE_OPTIONS = `--loader=${process.env.HUB476_PARENT_LOADER}`;
        else delete env.NODE_OPTIONS;
        const child = owner.start(() => spawn(process.execPath, [path.join(source, "agent-hub-main.mjs")],
          { cwd: source, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        const startup = await waitFor(async () => {
          assert.equal(child.exitCode, null, stderr);
          const provider = JSON.parse(await readFile(fakeState, "utf8"));
          const probes = provider.oldTurnProbe.requests.filter(row => ["thread/read", "thread/turns/list", "thread/resume", "turn/interrupt", "turn/start"].includes(row.method));
          if (probes.length) return { probes, ready: /Agent Hub ready;/u.test(stdout) };
          return /Agent Hub ready;/u.test(stdout) ? { probes: [], ready: true } : null;
        }, "Ready without old provider recovery", 20_000);
        t.diagnostic(JSON.stringify({ mode, generation, startup, startupObservedMs: performance.now() - started }));
        assert.deepEqual(startup.probes, [], "startup must never query, recover or execute the retained old turn");
        await sleep(750);
        const provider = JSON.parse(await readFile(fakeState, "utf8"));
        assert.deepEqual(provider.oldTurnProbe.requests, [], "post-Ready automatic watchers cannot recover the old turn");
        assert.doesNotMatch(stdout + stderr, /Не удалось проверить завершение хода/u);
        const snapshot = await callDesktopControl("snapshot", { compactSnapshot: true, snapshotProtocol: 4 }, { runtimeRoot: root });
        for (const target of targets) {
          const conversation = snapshot.collectionDeltas.conversations.reset.find(row => row.threadId === target.threadId);
          assert.equal(conversation?.running, false);
          assert.notEqual(conversation?.activityUnknown, true);
          if (generation < 2) assert.ok(snapshot.deferredInputs.some(row => row.clientUserMessageId === queues[targets.indexOf(target)].clientUserMessageId));
        }
        assert.deepEqual(await readFile(attachment), attachmentBytes);
        observations.push({ generation, readyMs: performance.now() - started, oldTurnRpcCount: provider.oldTurnProbe.requests.length });
        if (generation === 1) {
          // The old-provider failure is a cold-recovery probe, not a failure of
          // the later explicit NEW launch. Both phases have separate witnesses.
          await writeFile(newInputReadyFile, "new explicit input phase");
          for (const queued of queues) {
            const result = await callDesktopControl("deferred-input", { id: queued.id, action: "resume" }, { runtimeRoot: root });
            assert.equal(result.accepted, true);
            await waitFor(async () => {
              const state = JSON.parse(await readFile(fakeState, "utf8"));
              return state.threads.flatMap(thread => thread.turns).find(turn => turn.items?.some(item => item.type === "userMessage" && item.clientId === queued.clientUserMessageId));
            }, "same original queued input provider acceptance", 8_000);
            const accepted = JSON.parse(await readFile(fakeState, "utf8"));
            const launch = accepted.oldTurnProbe.newInputs.find(row => row.clientUserMessageId === queued.clientUserMessageId && row.threadId === queued.threadId);
            assert.ok(launch);
            assert.ok(launch.attachmentTypes.includes("localImage"));
          }
          if (streamCount === 2) {
            await waitFor(async () => {
              const state = JSON.parse(await readFile(fakeState, "utf8"));
              const after = await callDesktopControl("snapshot", { compactSnapshot: true, snapshotProtocol: 4 }, { runtimeRoot: root });
              return targets.every(target => state.threads.find(row => row.id === target.threadId).turns.every(turn => turn.status !== "inProgress")
                && !after.collectionDeltas.conversations.reset.find(row => row.threadId === target.threadId)?.running);
            }, "both original queued turns finish before the next NEW launch", 8_000);
            const ownedAttachment = path.join(root, "attachments/next-input.png");
            await mkdir(path.dirname(ownedAttachment), { recursive: true });
            await writeFile(ownedAttachment, attachmentBytes);
            for (const target of targets) {
              const nextId = `next-explicit-${target.streamId}`;
              const sent = await callDesktopControl("send-message", { text: "next explicit message",
                provider: "codex", threadId: target.threadId, clientUserMessageId: nextId,
                attachments: [ownedAttachment] }, { runtimeRoot: root });
              assert.equal(sent.accepted, true);
              await waitFor(async () => {
                const state = JSON.parse(await readFile(fakeState, "utf8"));
                const turns = state.threads.find(row => row.id === target.threadId).turns;
                const matches = turns.filter(turn => turn.items?.some(item => item.type === "userMessage" && item.clientId === nextId));
                if (!matches.length) return null;
                assert.equal(matches.length, 1);
                const launch = state.oldTurnProbe.newInputs.find(row => row.clientUserMessageId === nextId && row.threadId === target.threadId);
                assert.ok(launch);
                assert.ok(launch.attachmentTypes.includes("localImage"));
                return true;
              }, "next exact explicit input with attachment", 8_000);
            }
            await waitFor(async () => {
              const after = await callDesktopControl("snapshot", { compactSnapshot: true, snapshotProtocol: 4 }, { runtimeRoot: root });
              return targets.every(target => !after.collectionDeltas.conversations.reset.find(row => row.threadId === target.threadId)?.running);
            }, "both new turns genuinely finish before third cold start", 8_000);
          }
        }
        await owner.stop();
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        if (streamCount === 2 && generation === 1) {
          const provider = JSON.parse(await readFile(fakeState, "utf8"));
          t.diagnostic(JSON.stringify({ generation, explicitInputRpcCount: provider.oldTurnProbe.requests.length }));
          provider.oldTurnProbe.requests = [];
          await writeFile(fakeState, JSON.stringify(provider));
        }
        const saved = await readRuntimeState(dataDir);
        for (const old of oldRuns) assert.ok(saved.activeRuns.some(run => run.id === old.id && run.responseText === "Retained partial"));
        if (streamCount === 2 && generation === 2) {
          const retainedHistory = new LocalTaskSyncStore({ filePath: path.join(dataDir, "task-sync.json"),
            databaseFile: path.join(dataDir, "journal.sqlite") });
          try {
            await retainedHistory.load();
            const provider = JSON.parse(await readFile(fakeState, "utf8"));
            for (const [index, target] of targets.entries()) {
              assert.ok(retainedHistory.history(target).some(turn => turn.messages?.some(message => message.itemId === "prior-answer")));
              const turns = provider.threads.find(row => row.id === target.threadId).turns;
              for (const id of [queues[index].clientUserMessageId, `next-explicit-${target.streamId}`]) {
                assert.equal(turns.filter(turn => turn.items?.some(item => item.type === "userMessage" && item.clientId === id)).length, 1);
              }
            }
          } finally { await retainedHistory.close(); }
        }
        const trace = new DatabaseSync(path.join(dataDir, "command-traces.sqlite"), { readOnly: true });
        try {
          const commandIds = [...oldRuns.map(row => row.clientUserMessageId), ...queues.map(row => row.clientUserMessageId)];
          const rows = trace.prepare(`SELECT command_id, stage, outcome, observed_at_ms, monotonic_duration_ms
            FROM command_trace_spans WHERE command_id IN (${commandIds.map(() => "?").join(",")}) OR stage = 'startup-readiness'
            ORDER BY sequence LIMIT 200`).all(...commandIds);
          for (const old of oldRuns) assert.ok(rows.some(row => row.command_id === old.clientUserMessageId && row.stage === "startup-local-execution-retirement" && row.outcome === "succeeded"));
          assert.equal(rows.some(row => row.stage === "startup-runs" || row.stage.startsWith("recovery-")), false);
          if (generation === 1) for (const queued of queues) assert.ok(rows.some(row => row.command_id === queued.clientUserMessageId));
          t.diagnostic(JSON.stringify({ mode, generation, trace: rows }));
        } finally { trace.close(); }
      }
      t.diagnostic(JSON.stringify({ mode, observations }));
    } catch (error) {
      t.diagnostic(JSON.stringify(owner.diagnostics({ mode, observations })));
      throw error;
    } finally {
      await owner.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
