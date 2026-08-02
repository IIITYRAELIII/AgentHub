import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { openRuntimeDatabase } from "./runtime-state-store.mjs";

const MAX_BINDINGS = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function bindingsPath(dataDir) {
  return path.join(dataDir, "telegram-thread-bindings.json");
}

export function bindingsEventsPath(dataDir) {
  return path.join(dataDir, "telegram-thread-bindings.d");
}

function validBinding(binding) {
  return binding
    && Number.isSafeInteger(binding.chatId)
    && Number.isSafeInteger(binding.messageId)
    && (binding.provider === "codex" || binding.provider === "claude")
    && typeof binding.threadId === "string" && binding.threadId.trim()
    && typeof binding.projectRoot === "string" && binding.projectRoot.trim()
    && (binding.taskTitle == null || typeof binding.taskTitle === "string");
}

function bindingKey(binding) {
  return `${binding.chatId}:${binding.messageId}`;
}

function recentBindings(bindings, now = Date.now()) {
  return bindings
    .filter(validBinding)
    .filter((binding) => {
      if (!binding.createdAt) return true;
      const createdAt = Date.parse(binding.createdAt);
      return Number.isFinite(createdAt) && now - createdAt <= MAX_AGE_MS;
    })
    .slice(-MAX_BINDINGS);
}

async function readLegacyBindings(dataDir) {
  try {
    const value = JSON.parse(await readFile(bindingsPath(dataDir), "utf8"));
    return Array.isArray(value) ? value.filter(validBinding) : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    if (error instanceof SyntaxError) {
      const file = bindingsPath(dataDir);
      await rename(file, `${file}.invalid-${Date.now()}`).catch(() => {});
      return [];
    }
    throw error;
  }
}

async function bindingEventNames(dataDir) {
  try {
    return (await readdir(bindingsEventsPath(dataDir)))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readBindingEvents(dataDir) {
  const directory = bindingsEventsPath(dataDir);
  const events = [];
  for (const name of await bindingEventNames(dataDir)) {
    try {
      const event = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      if (event?.type === "append" && Array.isArray(event.bindings)) {
        events.push({ type: "append", bindings: event.bindings.filter(validBinding) });
      } else if (event?.type === "remove" && Array.isArray(event.keys)) {
        events.push({ type: "remove", keys: event.keys.filter((key) => typeof key === "string") });
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      await rename(
        path.join(directory, name),
        path.join(directory, `${name}.invalid-${Date.now()}`),
      ).catch(() => {});
    }
  }
  return events;
}

function insertBinding(database, binding, updatedMs = Date.now()) {
  const createdMs = Date.parse(binding.createdAt ?? "");
  database.prepare(`
    INSERT INTO telegram_message_bindings (
      chat_id, message_id, provider, thread_id, project_root, task_title,
      created_at, created_ms, updated_ms, binding_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      provider = excluded.provider,
      thread_id = excluded.thread_id,
      project_root = excluded.project_root,
      task_title = excluded.task_title,
      created_at = excluded.created_at,
      created_ms = excluded.created_ms,
      updated_ms = excluded.updated_ms,
      binding_json = excluded.binding_json
  `).run(
    binding.chatId,
    binding.messageId,
    binding.provider,
    binding.threadId,
    binding.projectRoot,
    binding.taskTitle ?? null,
    binding.createdAt ?? null,
    Number.isFinite(createdMs) ? createdMs : null,
    updatedMs,
    JSON.stringify(binding),
  );
}

function pruneBindings(database, now = Date.now()) {
  database.prepare(`
    DELETE FROM telegram_message_bindings
    WHERE created_ms IS NOT NULL AND created_ms < ?
  `).run(now - MAX_AGE_MS);
  database.prepare(`
    DELETE FROM telegram_message_bindings
    WHERE (chat_id, message_id) NOT IN (
      SELECT chat_id, message_id FROM telegram_message_bindings
      ORDER BY updated_ms DESC, chat_id DESC, message_id DESC LIMIT ?
    )
  `).run(MAX_BINDINGS);
}

async function ensureLegacyImported(dataDir, database) {
  if (database.prepare(
    "SELECT value FROM runtime_store_meta WHERE key = 'telegram_bindings_imported'",
  ).get()) return { imported: false, count: 0 };

  const [legacy, events] = await Promise.all([
    readLegacyBindings(dataDir),
    readBindingEvents(dataDir),
  ]);
  const byKey = new Map(legacy.map((binding) => [bindingKey(binding), binding]));
  for (const event of events) {
    if (event.type === "remove") {
      for (const key of event.keys) byKey.delete(key);
    } else {
      for (const binding of event.bindings) byKey.set(bindingKey(binding), binding);
    }
  }
  const bindings = recentBindings([...byKey.values()]);

  database.exec("BEGIN IMMEDIATE");
  try {
    const alreadyImported = database.prepare(
      "SELECT value FROM runtime_store_meta WHERE key = 'telegram_bindings_imported'",
    ).get();
    if (!alreadyImported) {
      const base = Date.now() - bindings.length;
      bindings.forEach((binding, index) => insertBinding(database, binding, base + index));
      pruneBindings(database);
      database.prepare(`
        INSERT INTO runtime_store_meta (key, value)
        VALUES ('telegram_bindings_imported', ?)
      `).run(new Date().toISOString());
    }
    database.exec("COMMIT");
    return { imported: !alreadyImported, count: alreadyImported ? 0 : bindings.length };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function archiveLegacyBindings(dataDir) {
  const sources = [bindingsPath(dataDir), bindingsEventsPath(dataDir)];
  const archive = path.join(path.resolve(dataDir), "migrations", "runtime-sqlite", "bindings");
  const moved = [];
  for (const source of sources) {
    const exists = await stat(source).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) continue;
    await mkdir(archive, { recursive: true });
    let target = path.join(archive, path.basename(source));
    if (await stat(target).then(() => true, () => false)) {
      target = path.join(archive, `${Date.now()}-${path.basename(source)}`);
    }
    await rename(source, target).catch(async (error) => {
      if (error?.code === "ENOENT") return;
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
        await rm(target, { recursive: true, force: true });
        await rename(source, target);
        return;
      }
      throw error;
    });
    moved.push(target);
  }
  return moved;
}

async function withDatabase(dataDir, operation) {
  const database = openRuntimeDatabase(dataDir);
  try {
    await ensureLegacyImported(dataDir, database);
    return await operation(database);
  } finally {
    database.close();
  }
}

export async function migrateMessageBindings(dataDir, { retireLegacy = true } = {}) {
  const database = openRuntimeDatabase(dataDir);
  try {
    const result = await ensureLegacyImported(dataDir, database);
    const archived = retireLegacy ? await archiveLegacyBindings(dataDir) : [];
    return { ...result, archived };
  } finally {
    database.close();
  }
}

export async function readMessageBindings(dataDir) {
  return withDatabase(dataDir, (database) => database.prepare(`
    SELECT binding_json FROM telegram_message_bindings
    ORDER BY updated_ms, chat_id, message_id
  `).all().map((row) => JSON.parse(row.binding_json)));
}

export async function appendMessageBindings(dataDir, additions) {
  const bindings = recentBindings(Array.isArray(additions) ? additions : []);
  if (!bindings.length) return;
  await withDatabase(dataDir, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const base = Date.now();
      bindings.forEach((binding, index) => insertBinding(database, binding, base + index));
      pruneBindings(database, base);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
}

export async function removeMessageBindings(dataDir, predicate) {
  return withDatabase(dataDir, (database) => {
    const current = database.prepare(`
      SELECT chat_id, message_id, binding_json FROM telegram_message_bindings
      ORDER BY updated_ms, chat_id, message_id
    `).all();
    const removed = current.filter((row) => predicate(JSON.parse(row.binding_json)));
    if (!removed.length) return 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      const remove = database.prepare(`
        DELETE FROM telegram_message_bindings WHERE chat_id = ? AND message_id = ?
      `);
      for (const row of removed) remove.run(row.chat_id, row.message_id);
      database.exec("COMMIT");
      return removed.length;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
}

export async function findMessageBinding(dataDir, chatId, messageId) {
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return null;
  return withDatabase(dataDir, (database) => {
    const row = database.prepare(`
      SELECT binding_json FROM telegram_message_bindings
      WHERE chat_id = ? AND message_id = ?
    `).get(chatId, messageId);
    return row ? JSON.parse(row.binding_json) : null;
  });
}

export async function compactMessageBindings(dataDir, options = {}) {
  return withDatabase(dataDir, (database) => {
    const before = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM telegram_message_bindings",
    ).get().count);
    if (typeof options.canonicalizeProjectRoot === "function") {
      const rows = database.prepare("SELECT binding_json FROM telegram_message_bindings").all();
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const binding = JSON.parse(row.binding_json);
          const projectRoot = options.canonicalizeProjectRoot(binding.projectRoot);
          if (projectRoot !== binding.projectRoot) insertBinding(database, { ...binding, projectRoot });
        }
        pruneBindings(database);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } else {
      pruneBindings(database);
    }
    const after = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM telegram_message_bindings",
    ).get().count);
    return before - after;
  });
}
