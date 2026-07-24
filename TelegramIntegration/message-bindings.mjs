import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { writeTextAtomic } from "./state-store.mjs";

const MAX_BINDINGS = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const COMPACT_AFTER_EVENTS = 500;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;

export function bindingsPath(dataDir) {
  return path.join(dataDir, "telegram-thread-bindings.json");
}

export function bindingsEventsPath(dataDir) {
  return path.join(dataDir, "telegram-thread-bindings.d");
}

function bindingsLockPath(dataDir) {
  return path.join(dataDir, "telegram-thread-bindings.lock");
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
  const directory = bindingsEventsPath(dataDir);
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readBindingEvents(dataDir, names = null) {
  const directory = bindingsEventsPath(dataDir);
  const selectedNames = names ?? await bindingEventNames(dataDir);
  const events = [];
  for (const name of selectedNames) {
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

async function acquireBindingsLock(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const lockPath = bindingsLockPath(dataDir);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      // Windows may report EPERM/EACCES, rather than EEXIST, when concurrent
      // mkdir calls race on the same directory. Treat those as contention only
      // while the lock directory can actually be observed.
      if (!["EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (!lockStat) {
        if (Date.now() >= deadline) throw error;
        await delay(10);
        continue;
      }
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Telegram bindings lock");
      await delay(10);
    }
  }
}

async function withBindingsLock(dataDir, operation) {
  const release = await acquireBindingsLock(dataDir);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function appendBindingEvent(dataDir, event) {
  const directory = bindingsEventsPath(dataDir);
  await mkdir(directory, { recursive: true });
  const timestamp = String(Date.now()).padStart(13, "0");
  const monotonic = process.hrtime.bigint().toString().padStart(20, "0");
  const target = path.join(directory, `${timestamp}-${monotonic}-${randomUUID()}.json`);
  await writeTextAtomic(target, `${JSON.stringify(event)}\n`);
}

async function compactMessageBindingsUnlocked(
  dataDir,
  names = null,
  canonicalizeProjectRoot = (projectRoot) => projectRoot,
) {
  const eventNames = names ?? await bindingEventNames(dataDir);
  if (!eventNames.length) return 0;
  const [legacy, events] = await Promise.all([
    readLegacyBindings(dataDir),
    readBindingEvents(dataDir, eventNames),
  ]);
  const byKey = new Map(legacy.map((binding) => [bindingKey(binding), binding]));
  for (const event of events) {
    if (event.type === "remove") {
      for (const key of event.keys) byKey.delete(key);
    } else {
      for (const binding of event.bindings) byKey.set(bindingKey(binding), binding);
    }
  }
  const compacted = recentBindings([...byKey.values()]).map((binding) => ({
    ...binding,
    projectRoot: canonicalizeProjectRoot(binding.projectRoot),
  }));
  await writeTextAtomic(bindingsPath(dataDir), `${JSON.stringify(compacted, null, 2)}\n`);
  await Promise.all(eventNames.map((name) => unlink(path.join(bindingsEventsPath(dataDir), name)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  })));
  return eventNames.length;
}

export async function compactMessageBindings(dataDir, {
  canonicalizeProjectRoot = (projectRoot) => projectRoot,
} = {}) {
  return withBindingsLock(
    dataDir,
    () => compactMessageBindingsUnlocked(dataDir, null, canonicalizeProjectRoot),
  );
}

export async function readMessageBindings(dataDir) {
  const [legacy, events] = await Promise.all([
    readLegacyBindings(dataDir),
    readBindingEvents(dataDir),
  ]);
  const byKey = new Map(legacy.map((binding) => [bindingKey(binding), binding]));
  for (const event of events) {
    if (event.type === "remove") {
      for (const key of event.keys) byKey.delete(key);
      continue;
    }
    for (const binding of event.bindings) byKey.set(bindingKey(binding), binding);
  }
  return recentBindings([...byKey.values()]);
}

export async function appendMessageBindings(dataDir, additions) {
  const bindings = recentBindings(Array.isArray(additions) ? additions : []);
  if (!bindings.length) return;
  await withBindingsLock(dataDir, async () => {
    await appendBindingEvent(dataDir, { type: "append", bindings });
    const names = await bindingEventNames(dataDir);
    if (names.length >= COMPACT_AFTER_EVENTS) await compactMessageBindingsUnlocked(dataDir, names);
  });
}

export async function removeMessageBindings(dataDir, predicate) {
  return withBindingsLock(dataDir, async () => {
    const current = await readMessageBindings(dataDir);
    const removed = current.filter(predicate);
    if (!removed.length) return 0;
    await appendBindingEvent(dataDir, {
      type: "remove",
      keys: removed.map(bindingKey),
    });
    const names = await bindingEventNames(dataDir);
    if (names.length >= COMPACT_AFTER_EVENTS) await compactMessageBindingsUnlocked(dataDir, names);
    return removed.length;
  });
}

export async function findMessageBinding(dataDir, chatId, messageId) {
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return null;
  const bindings = await readMessageBindings(dataDir);
  return bindings.findLast((item) => item.chatId === chatId && item.messageId === messageId) ?? null;
}
