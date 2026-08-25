import { DatabaseSync } from "node:sqlite";

import { runtimeDatabasePath } from "../../src/infrastructure/persistence/runtime-state-store.mjs";

export function messageCommandFixture(overrides = {}) {
  const clientUserMessageId = overrides.clientUserMessageId ?? "client-message-1";
  const item = {
    id: overrides.itemId ?? "deferred-1",
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId,
    conflictKind: "message-intake",
    createdAt: "2026-08-24T06:00:00.000Z",
    ...overrides.item,
  };
  const receipt = {
    provider: item.provider,
    threadId: item.threadId,
    clientUserMessageId,
    fingerprint: overrides.fingerprint ?? "fingerprint-1",
    result: { accepted: false, pending: true },
    createdAt: item.createdAt,
    ...overrides.receipt,
  };
  return { item, receipt };
}

export function holdRuntimeWriteLock(dataDir) {
  const database = new DatabaseSync(runtimeDatabasePath(dataDir));
  database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  return () => {
    database.exec("COMMIT;");
    database.close();
  };
}
