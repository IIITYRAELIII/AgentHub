import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../src/infrastructure/persistence/command-trace-worker-store.mjs";

test("a synchronous post-infrastructure fault persists one terminal startup span", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hub-pre-web-trace-"));
  const databaseFile = path.join(directory, "traces.sqlite");
  const store = new CommandTraceWorkerStore({ databaseFile });
  const original = new Error("synthetic private startup failure");
  const fixture = { directory, original, startupTraceId: null, trace: new CommandTraceService({ store }) };
  globalThis.preWebTraceFixture = fixture;
  const moduleUrl = new URL("../../src/composition/agent-hub-composition.mjs", import.meta.url).href;
  const stubs = {
    "config.mjs": 'export const AGENT_HUB_ROOT = globalThis.preWebTraceFixture.directory; export const loadConfig = () => ({ miniApp: { enabled: false }, provider: "codex" }); export const canonicalizeProjectRoots = () => [];',
    "claude-run-io.mjs": "export const stopProcessTree = () => {};",
    "codex-settings.mjs": "export const CODEX_COLLABORATION_MODE_LABELS = {}, CODEX_COLLABORATION_MODES = [], CODEX_REASONING_EFFORTS = [], CODEX_REASONING_LABELS = {};",
    "send-message.mjs": "export const resolveChatId = () => {};",
    "codex-approvals.mjs": "export const formatPermissionsApproval = () => {}, parseApprovalCallback = () => {};",
    "runtime-layout.mjs": "export const defaultRuntimeRoot = () => globalThis.preWebTraceFixture.directory;",
    "server-page.mjs": "export const agentHubAutostartShortcut = () => null;",
    "hub-static-settings.mjs": "export const createHubStaticSettings = () => ({});",
    "infrastructure-composition.mjs": "export const createHubInfrastructure = ({ startupTraceId }) => { const fixture = globalThis.preWebTraceFixture; fixture.startupTraceId = startupTraceId; return { commandTraceService: fixture.trace }; };",
    "state-composition.mjs": "export const createStateComposition = () => { throw globalThis.preWebTraceFixture.original; };",
    "provider-application-composition.mjs": 'export const createProviderApplicationComposition = () => { throw new Error("Unexpected provider composition"); };',
    "client-runtime-composition.mjs": 'export const createClientRuntimeComposition = () => { throw new Error("Unexpected client composition"); };',
    "interaction-shell-phase-composition.mjs": "export const configureMcpTaskLauncher = () => {}, createInteractionShellPhase = () => {};",
    "execution-bootstrap-phase-composition.mjs": "export const createExecutionBootstrapPhase = () => {};",
  };
  const hooks = registerHooks({
    resolve(specifier, options, resolve) {
      const file = specifier.split("/").at(-1);
      if (options.parentURL !== moduleUrl || !Object.hasOwn(stubs, file)) return resolve(specifier, options);
      return { url: "data:text/javascript;base64," + Buffer.from(stubs[file]).toString("base64"), shortCircuit: true };
    },
  });
  context.after(async () => {
    hooks.deregister();
    delete globalThis.preWebTraceFixture;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  await store.initialize();
  await assert.rejects(import(moduleUrl), error => error === original);
  await store.close();

  const reader = new CommandTraceWorkerStore({ databaseFile });
  try {
    await reader.initialize();
    const rows = await reader.readCommandTimeline(`startup:${fixture.startupTraceId}`);
    const phase = rows.filter(row => row.stage === "startup-pre-web-composition");
    assert.deepEqual(phase.map(row => row.outcome), ["started", "failed"]);
    assert.equal(phase[0].metadata.operationSpanId, phase[1].metadata.operationSpanId);
    assert.ok(Number.isFinite(phase[1].monotonicDurationMs));
    assert.doesNotMatch(JSON.stringify(rows), /synthetic private startup failure/u);
    assert.equal(rows.some(row => row.stage === "startup-pre-web-provider-composition"), false);
  } finally {
    await reader.close();
  }
});
