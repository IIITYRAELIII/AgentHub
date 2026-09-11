import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createDesktopReadSystemWiring } from "../../src/composition/desktop-read-system-wiring-composition.mjs";
import { currentWorkspaceThreadEntries } from "../../src/composition/provider-catalog-composition.mjs";
import { searchWorkLogRecords } from "../../src/application/work-log-usage-projection.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { createContourCommandMapping } from "../../src/infrastructure/filesystem/test-contour-command-mapping.mjs";
import { prepareContourCatalog } from "../../src/runtime/test-contour-catalog-preparation.mjs";
import { contourReadModelOptions } from "../../src/runtime/test-contour-read-model.mjs";
import { prepareContourProjectConfiguration } from "../../src/domain/test-contour-project-configuration.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.resolve(import.meta.dirname, "../../.fixture-read-model-"));
  const prepared = path.join(root, "prepared");
  const recording = path.join(root, "recording");
  await mkdir(prepared); await mkdir(recording);
  const databaseFile = path.join(prepared, "journal.sqlite");
  const owners = [];
  t.after(async () => {
    for (const owner of owners.reverse()) owner.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const catalog = new WorkspaceCatalogStore({ databaseFile });
    const sync = new LocalTaskSyncStore({ filePath: path.join(prepared, "task-sync.json"), databaseFile });
    const journal = new JournalDatabase(databaseFile);
    owners.push(catalog, sync, journal);
    await catalog.load(); await sync.load();
    return { catalog, sync, journal };
  };
  const initial = await open();
  const projects = ["alpha", "beta"].map((name) => ({ name, path: path.join(root, "canonical", name) }));
  const bindings = [];
  for (const [index, project] of projects.entries()) {
    const workspace = initial.catalog.createWorkspace({ name: project.name, settings: { workingDirectory: project.path } });
    const stream = initial.catalog.createStream({ workspaceId: workspace.id, name: project.name });
    initial.catalog.updateStreamSettings(stream.id, { project: project.path });
    for (let position = 1; position <= (index === 0 ? 2 : 1); position++) {
      const binding = { provider: index ? "claude" : "codex", threadId: `${project.name}-${position}`,
        projectRoot: project.path, workspaceId: workspace.id, streamId: stream.id, position };
      initial.catalog.bindThread(binding); bindings.push(binding);
    }
  }
  const turns = [];
  for (const [index, binding] of bindings.entries()) {
    const turn = { id: `turn-${index}`, status: "completed", completed: true,
      startedAt: `2026-09-10T10:0${index}:00.000Z`, completedAt: `2026-09-10T10:0${index}:30.000Z`,
      messages: [{ itemId: `user-${index}`, role: "user", clientUserMessageId: `command-${index}`,
        text: `needle ${index} literal ${projects[0].path}` },
      { itemId: `agent-${index}`, role: "agent", phase: "final", text: `answer ${index}` }] };
    await initial.sync.recordHistory(binding, [turn]);
    const record = { ...binding, turnId: turn.id, taskThreadId: binding.threadId, taskTitle: `Task ${index}`,
      prompt: turn.messages[0].text, body: turn.messages[1].text, completedAt: turn.completedAt };
    await initial.journal.upsertRecords([record]); turns.push(turn);
  }
  const evidence = () => {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try { return db.prepare("SELECT provider, thread_id, turn_id, project_root, record_json FROM journal_records ORDER BY provider, thread_id, turn_id").all(); }
    finally { db.close(); }
  };
  const before = sha256(JSON.stringify(evidence()));
  for (const owner of owners.splice(0)) owner.close();
  await writeFile(path.join(prepared, "contour-preparation.json"), JSON.stringify({
    schemaVersion: 1, kind: "owned-contour-preparation", root: prepared, bootable: false,
  }));
  await writeFile(path.join(recording, "recording-provider.json"), JSON.stringify({
    schemaVersion: 1, kind: "literal-recording-provider", root: recording, externalEffects: "deny",
    sources: [path.join(root, "canonical"), ...projects.map((project) => project.path)].map((source) => ({ source, kind: "project" })),
    threads: bindings.map((binding) => ({ provider: binding.provider, id: binding.threadId,
      streamId: binding.streamId, cwd: binding.projectRoot })),
  }));
  const mapping = createContourCommandMapping({ root: recording });
  prepareContourCatalog({ databaseFile, preparedRoot: prepared, paths: mapping.paths });
  const operationalProjects = projects.map((project) => ({ ...project, path: mapping.paths.map(project.path, "project") }));
  async function wire() {
    const { catalog, sync, journal } = await open();
    const records = await journal.loadLedger();
    const entries = () => currentWorkspaceThreadEntries(catalog);
    const readBindings = [];
    const system = createDesktopReadSystemWiring({
      contourCommandMapping: mapping,
      config: { components: { androidApp: false, telegram: false }, allowedUserIds: new Set() },
      models: {}, projects: operationalProjects, maxSpeechJobs: 1,
      state: { activeProvider: () => "codex", threadId: () => bindings[1].threadId, chatId: () => 1 },
      services: {
        catalogEntries: entries, refreshCatalog: async () => entries(), workspaceHierarchy: () => catalog.hierarchy(),
        threadsForStream: (id) => catalog.threadsForStream(id),
        searchTurns: (query, options) => searchWorkLogRecords(records.turns, query, {
          ...options, workspaceResolver: (binding) => catalog.resolveThread(binding),
        }),
        samePath: (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(),
        findProject: (value) => operationalProjects.find((project) => project.path === value),
        readHistoryPage: (references, options) => { readBindings.push(...references); return sync.readHistoryPage(references, options); },
        readCachedHistory: async () => ({ history: [] }), refreshHistory: async () => ({ history: [] }),
        runForTask: () => null, lastTaskMessage: () => null, receiptForMessage: () => null,
        receiptsForTurn: () => [], readStateStore: { get: () => null, markRead: () => {} }, warn: () => {},
      },
    });
    return { system, catalog, readBindings };
  }
  return { root, projects, operationalProjects, bindings, turns, mapping, wire,
    close: () => { for (const owner of owners.splice(0)) owner.close(); },
    verifyEvidence: () => assert.equal(sha256(JSON.stringify(evidence())), before) };
}

test("prepared catalog and canonical journal agree through real Desktop read owners after reopen", async (t) => {
  const f = await fixture(t);
  for (let iteration = 0; iteration < 2; iteration++) {
    const { system, catalog, readBindings } = await f.wire();
    const search = await system.desktopSearch({ query: "needle" });
    assert.equal(search.results.length, 3, "operational project roots must not hide canonical journal records");
    for (const result of search.results) {
      const binding = f.bindings.find((item) => item.threadId === result.threadId);
      assert.equal(result.streamId, binding.streamId);
      assert.equal(result.projectRoot, binding.projectRoot);
    }
    const request = { provider: "codex", threadId: f.bindings[1].threadId, streamId: f.bindings[1].streamId,
      limit: 1, includeActive: true };
    const latest = await system.desktopTaskHistory(request);
    assert.equal(latest.items[0].id, f.turns[1].id);
    const older = await system.desktopTaskHistory({ ...request, before: latest.nextBefore });
    assert.equal(older.items[0].id, f.turns[0].id);
    assert.equal(older.items[0].messages[0].clientUserMessageId, "command-0");
    assert.equal(older.items[0].messages[0].text, f.turns[0].messages[0].text);
    assert.ok(readBindings.length > 0);
    assert.ok(readBindings.every((binding) => binding.projectRoot === f.projects[0].path));
    assert.equal(catalog.threadsForStream(request.streamId)[0].projectRoot, f.operationalProjects[0].path,
      "read projection must not mutate the prepared catalog");
    f.verifyEvidence(); f.close();
  }
});

test("prepared config retains two projects in the actual loader, with recording boot still blocked", async (t) => {
  const f = await fixture(t);
  const configFile = path.join(f.root, "config.json");
  const source = { components: { telegram: false, miniApp: false, androidApp: false, testContour: true },
    projectRoot: f.projects[0].path, projects: f.projects, dataDir: path.join(f.root, "data"),
    quickReplies: [{ title: "literal", text: f.projects[0].path }] };
  const environment = { SystemRoot: process.env.SystemRoot, AGENT_HUB_CONFIG: configFile,
    AGENT_HUB_RUNTIME_ROOT: f.root, AGENT_HUB_TEST_CONTOUR: "1", CODEX_PROJECT_ROOT: f.operationalProjects[0].path };
  const sourceBefore = JSON.stringify(source);
  const environmentBefore = JSON.stringify(environment);
  const prepared = prepareContourProjectConfiguration({ config: source, environment, mapping: f.mapping });
  const configModule = pathToFileURL(path.resolve(import.meta.dirname, "../../src/infrastructure/filesystem/config.mjs")).href;
  const script = `import { loadConfig } from ${JSON.stringify(configModule)};
    try { const config = await loadConfig(); console.log(JSON.stringify({ projects: config.projects, projectRoot: config.projectRoot })); }
    catch (error) { console.log(JSON.stringify({ code: error.code, error: error.message })); }`;
  function load(env) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env, encoding: "utf8", timeout: 5_000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  await writeFile(configFile, JSON.stringify(prepared.config));
  const oldEnvironment = load(environment);
  assert.equal(oldEnvironment.error, undefined);
  assert.equal(oldEnvironment.projects.length, 1, "negative control: old environment overrides the prepared project list");
  const loaded = load(prepared.environment);
  assert.deepEqual(loaded.projects, f.operationalProjects);
  assert.equal(loaded.projectRoot, f.operationalProjects[0].path);
  assert.equal(JSON.stringify(source), sourceBefore); assert.equal(JSON.stringify(environment), environmentBefore);
  assert.equal(prepared.config.quickReplies[0].text, f.projects[0].path);
  await writeFile(configFile, JSON.stringify({ ...prepared.config,
    testContourRecording: { schemaVersion: 1, root: f.mapping.paths.root } }));
  assert.equal(load(prepared.environment).code, "CONTOUR_RECORDING_BOOT_NOT_READY");
});

test("read projection is opt-in and rejects unseeded identity without changing source views", async (t) => {
  const f = await fixture(t);
  const binding = f.bindings[1];
  const operational = { ...binding, projectRoot: f.operationalProjects[0].path,
    comment: `literal ${f.operationalProjects[0].path}`, annotations: [{ quote: "x".repeat(80_000) }] };
  const services = { catalogEntries: () => [operational], readHistoryPage: (...args) => args };
  const original = { projects: f.operationalProjects, services };
  assert.equal(contourReadModelOptions(original, null), original);
  const view = contourReadModelOptions(original, f.mapping);
  assert.equal(view.services.catalogEntries()[0].projectRoot, binding.projectRoot);
  assert.equal(view.services.catalogEntries()[0].comment, operational.comment);
  assert.deepEqual(view.services.catalogEntries()[0].annotations, operational.annotations);
  assert.equal(operational.projectRoot, f.operationalProjects[0].path);
  const pageOptions = { before: 1, limit: 1 };
  const [references, returnedOptions] = view.services.readHistoryPage([operational], pageOptions);
  assert.equal(returnedOptions, pageOptions);
  assert.equal(references[0].threadId, binding.threadId);
  assert.throws(() => view.services.readHistoryPage([{ ...operational, streamId: "foreign" }], pageOptions), /Stream differs/);
  assert.throws(() => view.services.readHistoryPage([{ ...operational, threadId: "unknown" }], pageOptions), /captured canonical binding/);
  assert.throws(() => prepareContourProjectConfiguration({ mapping: f.mapping, environment: {},
    config: { projectRoot: f.projects[0].path, projects: [{ name: "unknown", path: path.join(f.root, "unmapped") }] } }), /Unmapped/);
});

test("historical containing-project reads do not become nested Thread execution authority", async (t) => {
  const f = await fixture(t);
  const binding = f.bindings[1];
  const parent = path.dirname(binding.projectRoot);
  const stored = { ...binding, projectRoot: parent, sessionCwd: parent, title: "Historical root" };
  const operational = { ...stored, projectRoot: f.mapping.paths.map(parent, "project"), sessionCwd: f.mapping.paths.map(parent, "project") };
  const original = structuredClone(operational);
  const view = contourReadModelOptions({ projects: f.operationalProjects, services: {
    catalogEntries: () => [operational], refreshCatalog: async () => [operational],
    readHistoryPage: (references) => references,
  } }, f.mapping);
  assert.deepEqual(view.services.catalogEntries(), [stored]);
  assert.deepEqual(await view.services.refreshCatalog(), [stored]);
  assert.deepEqual(view.services.readHistoryPage([operational]), [stored]);
  assert.deepEqual(operational, original);
  assert.throws(() => f.mapping.target(operational), /project differs/);
  assert.throws(() => f.mapping.readReference({ ...operational, streamId: "foreign" }), /Stream differs/);
  assert.throws(() => f.mapping.readReference({ ...operational, threadId: "unknown" }), /captured canonical binding/);
  f.verifyEvidence();
});
