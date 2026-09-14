import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { providerThreadKey } from "../../domain/workspace-stream-identity.mjs";
import { WorkspaceCatalogStore } from "./workspace-catalog-store.mjs";

const MANIFEST_VERSION = 1;

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

function manifestHash(manifest) {
  return createHash("sha256").update(JSON.stringify(ordered(manifest))).digest("hex");
}

function normalizedManifest(input) {
  if (Number(input?.version) !== MANIFEST_VERSION) {
    throw new Error(`unsupported workspace layout manifest version: ${input?.version ?? "missing"}`);
  }
  const key = String(input?.key ?? "").trim();
  if (!key || key.length > 160 || key.includes("\0")) throw new Error("invalid migration key");
  const seen = new Set();
  const workspaces = (Array.isArray(input.workspaces) ? input.workspaces : []).map((workspace) => ({
    name: String(workspace?.name ?? "").trim(),
    streams: (Array.isArray(workspace?.streams) ? workspace.streams : []).map((stream) => ({
      name: String(stream?.name ?? "").trim() || null,
      threads: (Array.isArray(stream?.threads) ? stream.threads : []).map((thread) => {
        const provider = String(thread?.provider ?? "").trim().toLowerCase();
        const threadId = String(thread?.threadId ?? "").trim();
        const identity = { provider, threadId };
        const identityKey = providerThreadKey(identity);
        if (seen.has(identityKey)) throw new Error(`duplicate manifest Thread: ${identityKey}`);
        seen.add(identityKey);
        return identity;
      }),
    })),
  }));
  if (!workspaces.length) throw new Error("workspace layout manifest has no workspaces");
  for (const workspace of workspaces) {
    if (!workspace.name) throw new Error("workspace layout contains an unnamed Workspace");
    if (!workspace.streams.length) throw new Error(`workspace has no Streams: ${workspace.name}`);
    if (workspace.streams.some((stream) => stream.threads.length === 0)) {
      throw new Error(`workspace contains an empty Stream: ${workspace.name}`);
    }
  }
  return { version: MANIFEST_VERSION, key, workspaces };
}

function existingTable(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function knownRootThreads(database) {
  const roots = new Map();
  if (existingTable(database, "task_read_model_tasks")) {
    for (const row of database.prepare(`
      SELECT provider, thread_id, project_root, title FROM task_read_model_tasks
    `).all()) {
      const value = {
        provider: String(row.provider).toLowerCase(),
        threadId: String(row.thread_id),
        projectRoot: String(row.project_root ?? ""),
        title: String(row.title ?? ""),
        sources: ["catalog"],
      };
      roots.set(providerThreadKey(value), value);
    }
  }
  if (existingTable(database, "journal_records")) {
    for (const row of database.prepare(`
      SELECT provider, task_thread_id, project_root, MAX(completed_at_ms) AS completed_at_ms
      FROM journal_records
      WHERE trim(task_thread_id) <> ''
      GROUP BY provider, task_thread_id, project_root
    `).all()) {
      const identity = {
        provider: String(row.provider).toLowerCase(),
        threadId: String(row.task_thread_id),
      };
      const key = providerThreadKey(identity);
      const previous = roots.get(key);
      roots.set(key, {
        ...identity,
        projectRoot: previous?.projectRoot || String(row.project_root ?? ""),
        title: previous?.title ?? "",
        sources: [...new Set([...(previous?.sources ?? []), "journal"])],
        completedAtMs: Number(row.completed_at_ms) || 0,
      });
    }
  }
  return roots;
}

function executingThreadCount(database) {
  if (!existingTable(database, "journal_records")) return 0;
  return Number(database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT provider, thread_id FROM journal_records GROUP BY provider, thread_id
    )
  `).get()?.count ?? 0);
}

function currentAssignment(database, identity) {
  if (!existingTable(database, "hub_threads")) return null;
  return database.prepare(`
    SELECT t.stream_id, s.workspace_id, w.name AS workspace_name, s.ordinal, s.name AS stream_name
    FROM hub_threads t
    JOIN hub_streams s ON s.id = t.stream_id
    JOIN hub_workspaces w ON w.id = s.workspace_id
    WHERE t.provider = ? AND t.provider_thread_id = ?
  `).get(identity.provider, identity.threadId) ?? null;
}

export async function readWorkspaceLayoutManifest(filePath) {
  const content = await readFile(path.resolve(filePath), "utf8");
  return normalizedManifest(JSON.parse(content));
}

export function planWorkspaceLayout({ databaseFile, manifest }) {
  const normalized = normalizedManifest(manifest);
  const database = new DatabaseSync(path.resolve(databaseFile), { readOnly: true });
  try {
    const roots = knownRootThreads(database);
    const explicit = [];
    const missing = [];
    for (const workspace of normalized.workspaces) {
      workspace.streams.forEach((stream, streamIndex) => {
        for (const identity of stream.threads) {
          const key = providerThreadKey(identity);
          const root = roots.get(key);
          const item = {
            ...identity,
            workspaceName: workspace.name,
            streamOrdinal: streamIndex + 1,
            streamName: stream.name,
            found: Boolean(root),
            projectRoot: root?.projectRoot ?? "",
            title: root?.title ?? "",
            current: currentAssignment(database, identity),
          };
          explicit.push(item);
          if (!root) missing.push(item);
        }
      });
    }
    const explicitKeys = new Set(explicit.map(providerThreadKey));
    const automatic = [...roots.values()]
      .filter((root) => !explicitKeys.has(providerThreadKey(root)))
      .sort((left, right) => (
        left.provider.localeCompare(right.provider)
        || left.threadId.localeCompare(right.threadId)
      ));
    const markerKey = `layout_migration:${normalized.key}`;
    const previous = existingTable(database, "hub_workspace_catalog_meta")
      ? database.prepare(
          "SELECT value FROM hub_workspace_catalog_meta WHERE key = ?",
        ).get(markerKey)?.value ?? null
      : null;
    return {
      manifest: normalized,
      manifestHash: manifestHash(normalized),
      markerKey,
      previous: previous ? JSON.parse(String(previous)) : null,
      rootThreadCount: roots.size,
      executingThreadCount: executingThreadCount(database),
      explicit,
      missing,
      automatic,
      valid: missing.length === 0,
    };
  } finally {
    database.close();
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function consistentBackup(databaseFile, backupRoot) {
  await mkdir(backupRoot, { recursive: true });
  const target = path.join(backupRoot, "journal.sqlite");
  const database = new DatabaseSync(path.resolve(databaseFile));
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all()
      .map((row) => String(Object.values(row)[0] ?? ""));
    if (integrity.length !== 1 || integrity[0] !== "ok") {
      throw new Error(`journal.sqlite integrity check failed: ${integrity.join(", ")}`);
    }
    database.exec(`VACUUM INTO ${sqlString(target)}`);
  } finally {
    database.close();
  }
  const bytes = await readFile(target);
  return {
    file: target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

export async function applyWorkspaceLayout({ databaseFile, manifest, backupDirectory = null }) {
  const plan = planWorkspaceLayout({ databaseFile, manifest });
  if (!plan.valid) {
    throw new Error(`workspace layout refers to ${plan.missing.length} unknown Thread(s)`);
  }
  if (plan.previous) {
    if (plan.previous.manifestHash !== plan.manifestHash) {
      throw new Error(`workspace layout migration ${plan.manifest.key} was already applied with another manifest`);
    }
    return { applied: false, reason: "unchanged", plan, audit: plan.previous };
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const backupRoot = backupDirectory
    ? path.resolve(backupDirectory)
    : path.join(path.dirname(path.resolve(databaseFile)), "migrations", `workspace-${timestamp}`);
  const backup = await consistentBackup(databaseFile, backupRoot);
  const store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  try {
    const audit = await store.runMutation(() => store.transaction(() => {
      const workspaceIds = new Map();
      let explicitCount = 0;
      for (const workspaceSpec of plan.manifest.workspaces) {
        const workspace = store.createWorkspace({ name: workspaceSpec.name });
        workspaceIds.set(workspaceSpec.name, workspace.id);
        for (const streamSpec of workspaceSpec.streams) {
          const stream = store.createStream({
            workspaceId: workspace.id,
            name: streamSpec.name,
          });
          for (const identity of streamSpec.threads) {
            const root = plan.explicit.find((item) => providerThreadKey(item) === providerThreadKey(identity));
            store.rebindThread(identity, {
              streamId: stream.id,
              projectRoot: root?.projectRoot,
              source: "migration",
            });
            explicitCount += 1;
          }
        }
      }
      const experiments = store.ensureExperiments();
      for (const root of plan.automatic) {
        const stream = store.createStream({ workspaceId: experiments.id });
        store.rebindThread(root, {
          streamId: stream.id,
          projectRoot: root.projectRoot,
          source: "migration",
        });
      }
      const hierarchy = store.hierarchy();
      const boundCount = hierarchy.reduce((total, workspace) => total
        + workspace.streams.reduce((streamTotal, stream) => streamTotal + stream.threads.length, 0), 0);
      if (boundCount !== plan.rootThreadCount) {
        throw new Error(`workspace migration validation failed: expected ${plan.rootThreadCount} bindings, found ${boundCount}`);
      }
      const value = {
        manifestHash: plan.manifestHash,
        appliedAt: new Date().toISOString(),
        backup,
        rootThreadCount: plan.rootThreadCount,
        executingThreadCount: plan.executingThreadCount,
        explicitCount,
        automaticExperimentsCount: plan.automatic.length,
        workspaceCount: hierarchy.length,
        streamCount: hierarchy.reduce((total, workspace) => total + workspace.streams.length, 0),
      };
      store.setMeta(plan.markerKey, JSON.stringify(value));
      return value;
    }), { requestId: `workspace-layout:${plan.manifestHash}` });
    await writeFile(path.join(backupRoot, "migration-report.json"), `${JSON.stringify({
      manifest: plan.manifest,
      audit,
    }, null, 2)}\n`, "utf8");
    return { applied: true, plan, audit };
  } finally {
    store.close();
  }
}
