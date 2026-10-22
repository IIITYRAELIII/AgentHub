import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createContourOperationalPaths } from "../domain/test-contour-operational-paths.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
function identity(value, name) { if (typeof value !== "string" || !value || value.length > 500) throw new Error(`${name} is required`); return value; }
function noLinks(file, missing = false) {
  let current = file;
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Recording provider paths cannot contain links or junctions"); }
    catch (error) { if (!(missing && current === file && error.code === "ENOENT")) throw error; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}

export class RecordingContourProvider {
  constructor({ root, provider, readOnly = false }) {
    if (!root || !path.isAbsolute(root) || !["codex", "claude"].includes(provider)) throw new Error("Explicit recording root and provider are required");
    this.root = path.resolve(root);
    noLinks(this.root);
    const configFile = path.join(this.root, "recording-provider.json");
    noLinks(configFile);
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    if (config.schemaVersion !== 1 || config.kind !== "literal-recording-provider" || config.root !== this.root || config.externalEffects !== "deny") throw new Error("Invalid recording provider root marker");
    this.paths = createContourOperationalPaths({ root: this.root, sources: config.sources });
    this.provider = provider;
    const databaseFile = path.join(this.root, "recording-provider.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) noLinks(`${databaseFile}${suffix}`, true);
    this.db = new DatabaseSync(databaseFile, { readOnly });
    if (!readOnly) this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS threads(provider TEXT, id TEXT, value_json TEXT NOT NULL, PRIMARY KEY(provider,id));
      CREATE TABLE IF NOT EXISTS thread_names(provider TEXT, thread_id TEXT, name TEXT NOT NULL, PRIMARY KEY(provider,thread_id));
      CREATE TABLE IF NOT EXISTS turns(provider TEXT, thread_id TEXT, id TEXT, value_json TEXT NOT NULL, PRIMARY KEY(provider,thread_id,id));
      CREATE TABLE IF NOT EXISTS commands(provider TEXT, client_id TEXT, fingerprint TEXT NOT NULL, canonical_json TEXT NOT NULL, execution_json TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(provider,client_id));`);
    try {
      for (const thread of config.threads ?? []) {
        if (thread.provider !== provider) continue;
        identity(thread.id, "thread ID");
        this.paths.map(thread.cwd, "project");
        const stored = this.db.prepare("SELECT value_json FROM threads WHERE provider=? AND id=?").get(provider, thread.id);
        if (stored && fingerprint(JSON.parse(stored.value_json)) !== fingerprint(thread)) throw new Error("Seeded Thread identity changed");
        if (readOnly && !stored) throw new Error("Recording Thread seed is unavailable");
        if (!readOnly) this.db.prepare("INSERT OR IGNORE INTO threads VALUES(?,?,?)").run(provider, thread.id, JSON.stringify(thread));
      }
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(operation) { this.db.exec("BEGIN IMMEDIATE"); try { const value = operation(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  thread(id) {
    const row = this.db.prepare("SELECT value_json FROM threads WHERE provider=? AND id=?").get(this.provider, identity(id, "thread ID"));
    if (!row) throw new Error("Unseeded Thread; recording adapter cannot discover production sessions");
    const thread = JSON.parse(row.value_json);
    const metadata = this.db.prepare("SELECT name FROM thread_names WHERE provider=? AND thread_id=?").get(this.provider, id);
    return { ...thread, ...(metadata ? { name: metadata.name } : {}), cwd: this.paths.map(thread.cwd, "project"), turns: this.db.prepare("SELECT value_json FROM turns WHERE provider=? AND thread_id=? ORDER BY rowid").all(this.provider, id).map((row) => JSON.parse(row.value_json)) };
  }
  threads() { return this.db.prepare("SELECT id FROM threads WHERE provider=? ORDER BY rowid").all(this.provider).map(({ id }) => this.thread(id)); }
  setThreadName({ threadId, name }) {
    identity(threadId, "thread ID");
    if (typeof name !== "string" || !name.trim() || name.includes("\0")) throw new Error("A nonempty literal Thread name is required");
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM threads WHERE provider=? AND id=?").get(this.provider, threadId)) throw new Error("Unseeded Thread; recording adapter cannot name production sessions");
      // Mutable display metadata never changes the canonical seed or a command
      // fingerprint. Repeating the same name is a no-op, including after reopen.
      this.db.prepare(`INSERT INTO thread_names(provider,thread_id,name) VALUES(?,?,?)
        ON CONFLICT(provider,thread_id) DO UPDATE SET name=excluded.name
        WHERE thread_names.name<>excluded.name`).run(this.provider, threadId, name);
      return {};
    });
  }
  start({ threadId, clientUserMessageId, input, turnId = null }) {
    identity(clientUserMessageId, "clientUserMessageId");
    const thread = this.thread(threadId);
    const originalThread = JSON.parse(this.db.prepare("SELECT value_json FROM threads WHERE provider=? AND id=?").get(this.provider, threadId).value_json);
    const canonical = { provider: this.provider, streamId: originalThread.streamId, threadId, clientUserMessageId, input, turnId, projectRoot: originalThread.cwd };
    const execution = this.paths.executionView(canonical);
    const requestHash = fingerprint(canonical);
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM commands WHERE provider=? AND client_id=?").get(this.provider, clientUserMessageId);
      if (prior) {
        if (prior.fingerprint !== requestHash) throw new Error("Command identity reused with changed literal input or target");
        return { duplicate: true, turn: this.thread(threadId).turns.find((turn) => turn.id === prior.turn_id) };
      }
      if (this.thread(threadId).turns.some((turn) => turn.status === "inProgress")) throw new Error("Thread already has an active recorded turn");
      const id = turnId === null ? `contour-${fingerprint([this.provider, threadId, clientUserMessageId])}` : identity(turnId, "turn ID");
      const turn = { id, status: "inProgress", clientUserMessageId,
        items: [{ id: `${id}:user:${fingerprint(clientUserMessageId)}`, type: "userMessage", clientUserMessageId, clientId: clientUserMessageId,
          content: typeof input === "string" ? [{ type: "text", text: input }] : structuredClone(input) }] };
      this.db.prepare("INSERT INTO turns VALUES(?,?,?,?)").run(this.provider, threadId, id, JSON.stringify(turn));
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,?,?)").run(this.provider, clientUserMessageId, requestHash, JSON.stringify(canonical), JSON.stringify(execution), threadId, id);
      return { duplicate: false, turn };
    });
  }
  finish({ threadId, turnId, status, answer }) {
    if (!["completed", "failed", "interrupted"].includes(status) || typeof answer !== "string") throw new Error("Explicit scenario terminal status and literal answer are required");
    return this.transaction(() => {
      const turn = this.thread(threadId).turns.find((turn) => turn.id === turnId);
      if (!turn) throw new Error("Unknown recorded turn");
      if (turn.status !== "inProgress") {
        if (turn.status !== status || turn.items.at(-1)?.text !== answer) throw new Error("Recorded terminal is absorbing");
        return turn;
      }
      turn.status = status;
      turn.items.push({ id: `${turnId}:final`, type: "agentMessage", phase: "final_answer", text: answer });
      this.db.prepare("UPDATE turns SET value_json=? WHERE provider=? AND thread_id=? AND id=?").run(JSON.stringify(turn), this.provider, threadId, turnId);
      return turn;
    });
  }
  command(clientUserMessageId) {
    const record = this.db.prepare("SELECT canonical_json,execution_json,turn_id FROM commands WHERE provider=? AND client_id=?").get(this.provider, clientUserMessageId);
    return record ? { canonical: JSON.parse(record.canonical_json), execution: JSON.parse(record.execution_json), turnId: record.turn_id } : null;
  }
  recordedTurn(threadId, turnId) {
    const thread = this.thread(threadId);
    const turn = thread.turns.find((value) => value.id === identity(turnId, "turn ID"));
    if (!turn) return null;
    const records = this.db.prepare("SELECT * FROM commands WHERE provider=? AND thread_id=? AND turn_id=?")
      .all(this.provider, threadId, turnId);
    if (records.length !== 1) throw new Error("Recorded turn lacks one exact command");
    const row = records[0];
    const canonical = JSON.parse(row.canonical_json);
    const seed = JSON.parse(this.db.prepare("SELECT value_json FROM threads WHERE provider=? AND id=?")
      .get(this.provider, threadId).value_json);
    if (fingerprint(canonical) !== row.fingerprint || canonical.provider !== this.provider
      || canonical.threadId !== threadId || canonical.streamId !== thread.streamId
      || canonical.projectRoot !== seed.cwd
      || canonical.clientUserMessageId !== row.client_id || turn.clientUserMessageId !== row.client_id
      || fingerprint(this.paths.executionView(canonical)) !== fingerprint(JSON.parse(row.execution_json))
      || !["inProgress", "completed", "failed", "interrupted"].includes(turn.status)) {
      throw new Error("Recorded turn command identity changed");
    }
    return turn;
  }
}

// Read the isolated adapter's canonical receipt; captured production rollouts
// and an arbitrary App Server status never supply this evidence.
export function readRecordingContourCodexTurn(root, run) {
  const provider = new RecordingContourProvider({ root, provider: "codex", readOnly: true });
  try { return provider.recordedTurn(run.threadId, run.turnId); }
  finally { provider.close(); }
}
