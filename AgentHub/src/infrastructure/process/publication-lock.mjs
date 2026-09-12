import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";

import { withInterprocessLocks } from "./interprocess-lock.mjs";

const PUBLICATION_SESSION_ENV = "AGENT_HUB_PUBLICATION_SESSION";
const publicationSessionStorage = new AsyncLocalStorage();

export function publicationLockTarget(environment = process.env) {
  const root = environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
  return path.join(root, "AgentHub", "publication");
}

export async function withPublicationLock(operation, {
  environment = process.env,
  lockTarget = publicationLockTarget(environment),
  lock = withInterprocessLocks,
  timeoutMs = 4 * 60 * 60_000,
  sessionFactory = randomUUID,
} = {}) {
  const activeSession = publicationSessionStorage.getStore();
  if (activeSession && String(environment[PUBLICATION_SESSION_ENV] ?? "") === activeSession) return operation();
  return lock([lockTarget], async () => {
    const previous = environment[PUBLICATION_SESSION_ENV];
    const session = sessionFactory();
    environment[PUBLICATION_SESSION_ENV] = session;
    try {
      return await publicationSessionStorage.run(session, operation);
    } finally {
      if (previous === undefined) delete environment[PUBLICATION_SESSION_ENV];
      else environment[PUBLICATION_SESSION_ENV] = previous;
    }
  }, { timeoutMs, retryDelayMs: 250 });
}
