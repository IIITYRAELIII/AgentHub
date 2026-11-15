import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../src/infrastructure/persistence/command-trace-worker-store.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { MiniAppPublisher } from "../../src/interfaces/web/mini-app-publisher.mjs";
import { importCompositionWithPorts } from "../helpers/composition-ports.fixture.mjs";

// Execute the unchanged composition root to its client-runtime handoff. Only
// direct startup/business ports are inert; no source parsing or Hub startup.
async function runtimeRecorder(trace) {
  const noop = () => {};
  const reached = new Error("client runtime captured");
  let options;
  await assert.rejects(importCompositionWithPorts(
    new URL("../../src/composition/agent-hub-composition.mjs", import.meta.url), {
      "../infrastructure/filesystem/config.mjs": { canonicalizeProjectRoots: noop, AGENT_HUB_ROOT: "fixture", loadConfig: () => ({ provider: "codex", miniApp: { enabled: false }, codexRpcTimeoutSeconds: 1 }) },
      "../providers/claude/claude-run-io.mjs": { stopProcessTree: noop },
      "../providers/codex/codex-settings.mjs": { CODEX_COLLABORATION_MODE_LABELS: {}, CODEX_COLLABORATION_MODES: [], CODEX_REASONING_EFFORTS: [], CODEX_REASONING_LABELS: {} },
      "../../send-message.mjs": { resolveChatId: noop },
      "../providers/codex/codex-approvals.mjs": { formatPermissionsApproval: noop, parseApprovalCallback: noop },
      "../infrastructure/filesystem/runtime-layout.mjs": { defaultRuntimeRoot: () => "fixture" },
      "../interfaces/web/local-web-auth.mjs": { ensureLocalWebSecret: noop },
      "../interfaces/web/server-page.mjs": { agentHubAutostartShortcut: noop },
      "./hub-static-settings.mjs": { createHubStaticSettings: () => ({}) },
      "./infrastructure-composition.mjs": { createHubInfrastructure: () => ({ commandTraceService: trace }) },
      "./command-trace-composition.mjs": { measureStartupBeforeTrace: async (_stage, action) => ({ value: await action(), record: noop }) },
      "./state-composition.mjs": { createStateComposition: () => ({ selectionStore: {}, agentPreferences: {} }) },
      "../application/provider-model-catalog-service.mjs": { ProviderModelCatalogService: class {} },
      "./agent-hub-deferred-ports.mjs": { createAgentHubDeferredPorts: () => ({ ports: {}, api: {} }) },
      "./provider-application-composition.mjs": { createProviderApplicationComposition: () => ({}) },
      "./client-runtime-composition.mjs": { createClientRuntimeComposition: value => { options = value; throw reached; } },
      "./interaction-shell-phase-composition.mjs": { configureMcpTaskLauncher: noop, createInteractionShellPhase: noop },
      "./execution-bootstrap-phase-composition.mjs": { createExecutionBootstrapPhase: noop },
      "../runtime/hub-session-state.mjs": { HubSessionState: class {} },
    }), error => error === reached);
  assert.equal(options.infrastructure.commandTraceService, trace, "root must forward the existing sink to client runtime");
  let recorder;
  const { createClientRuntimeComposition } = await importCompositionWithPorts(
    new URL("../../src/composition/client-runtime-composition.mjs", import.meta.url), {
      "./client-interface-composition.mjs": { createClientInterfaceComposition: value => {
        recorder = value.recordCommandTrace; throw reached;
      } },
    });
  await assert.rejects(createClientRuntimeComposition(options), error => error === reached);
  assert.equal(typeof recorder, "function");
  return recorder;
}

test("actual root routes journal preparation originals through the existing trace worker and SQLite reader", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "journal-trace-"));
  const databaseFile = path.join(root, "journal.sqlite"), traceFile = path.join(root, "trace.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const traceStore = new CommandTraceWorkerStore({ databaseFile: traceFile });
  const trace = new CommandTraceService({ store: traceStore, metadata: { instanceId: "fixture-instance", releaseId: "fixture-release" } });
  let publisher;
  t.after(async () => { await publisher?.close(); await journal.close(); await traceStore.close(); await rm(root, { recursive: true, force: true }); });
  await traceStore.initialize();
  const recorder = await runtimeRecorder(trace);
  await journal.replaceProjection({ html: "index", days: { day: "private journal body" }, turns: { exact: "final answer" } });
  const expected = await journal.snapshot(), uploads = [], emitted = [];
  const secret = path.join(root, "secret"); await writeFile(secret, "synthetic-test-secret".repeat(4));
  const originals = new Set();
  publisher = new MiniAppPublisher({ journalDatabase: journal, journalDatabaseFile: databaseFile,
    dataDirectory: root, publicUrl: "https://fixture.invalid", syncSecretFile: secret,
    recordCommandTrace: span => { emitted.push(span); originals.add(span.commandId); return recorder(span); },
    fetchImpl: async (_url, request) => { uploads.push(Buffer.from(request.body)); return new Response(null, { status: 200 }); },
  });
  assert.equal(await publisher.sync(), true);
  assert.equal(originals.size, 1);
  const [original] = originals;
  assert.match(original, /^journal-publication:[a-f0-9]{64}$/u);
  const rows = await trace.readCommandTimeline(original);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.outcome), ["started", "succeeded"]);
  assert.ok(rows.every(row => row.stage === "journal-publication-prepare"));
  assert.equal(rows[0].metadata.operationSpanId, rows[1].metadata.operationSpanId);
  assert.ok(rows.every(row => row.metadata.instanceId === "fixture-instance" && row.metadata.releaseId === "fixture-release"));
  const end = rows[1].metadata;
  assert.equal(end.encodedInputBytes, Buffer.byteLength(JSON.stringify(expected), "utf8"));
  assert.equal(end.encodingBufferCount, 1);
  assert.equal(end.maxEncodingBufferBytes, end.encodedInputBytes);
  assert.equal(end.compressedBytes, uploads.reduce((total, chunk) => total + chunk.length, 0));
  const diagnostic = JSON.stringify(rows);
  for (const privateValue of ["private journal body", "final answer", "synthetic-test-secret", "fixture.invalid", root]) assert.equal(diagnostic.includes(privateValue), false);
  assert.equal(await publisher.sync(), true);
  assert.equal(emitted.length, 2, "unchanged publication does not invent another preparation");
  await traceStore.close();
  const reopened = new CommandTraceWorkerStore({ databaseFile: traceFile });
  try { assert.deepEqual(await reopened.readCommandTimeline(original), rows); }
  finally { await reopened.close(); }
});

test("journal trace sink loss and preparation failure preserve owning outcomes without extra publication", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "journal-trace-failure-"));
  const journal = new JournalDatabase(path.join(root, "journal.sqlite"));
  const secret = path.join(root, "secret"); await writeFile(secret, "synthetic-test-secret".repeat(4));
  const publishers = [];
  t.after(async () => { for (const publisher of publishers) await publisher.close(); await journal.close(); await rm(root, { recursive: true, force: true }); });
  await journal.replaceProjection({ html: "unchanged", days: {}, turns: {} });
  for (const sink of [() => { throw new Error("synthetic sink failure"); }, () => Promise.reject(new Error("synthetic async sink failure")), () => false]) {
    let uploads = 0;
    const recorder = await runtimeRecorder({ recordBestEffort: sink });
    const publisher = new MiniAppPublisher({ journalDatabase: journal, journalDatabaseFile: journal.file ?? path.join(root, "journal.sqlite"),
      dataDirectory: root, publicUrl: "https://fixture.invalid", syncSecretFile: secret, recordCommandTrace: recorder,
      fetchImpl: async () => { uploads += 1; return new Response(null, { status: 200 }); } });
    publishers.push(publisher); assert.equal(await publisher.sync(), true); assert.equal(uploads, 1);
    await publisher.close();
  }
  const rows = [], original = await runtimeRecorder({ recordBestEffort: span => { rows.push(span); return true; } });
  const publisher = new MiniAppPublisher({ journalDatabase: journal, journalDatabaseFile: path.join(root, "missing.sqlite"),
    dataDirectory: root, publicUrl: "https://fixture.invalid", syncSecretFile: secret, recordCommandTrace: original,
    fetchImpl: async () => assert.fail("a failed preparation cannot upload") });
  publishers.push(publisher);
  await assert.rejects(publisher.sync(), /preparation failed/u);
  assert.deepEqual(rows.map(row => row.outcome), ["started", "failed"]);
  assert.equal(rows[0].commandId, rows[1].commandId);
  assert.equal(rows[0].metadata.operationSpanId, rows[1].metadata.operationSpanId);
  assert.equal(Object.hasOwn(rows[1].metadata, "encodedInputBytes"), false, "unknown failed-input volume is omitted");
});
