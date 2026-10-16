import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AsyncSqliteMutationQueue, sqliteContention } from "./async-sqlite-mutation-queue.mjs";
import { processIsAlive } from "../process/process-liveness.mjs";
import {
  equalTransferDigest,
  mergeTransferCoverage,
  transferClaimPayload,
  transferError,
  transferHash,
  transferPlanPayload,
  TRANSFER_BLOCK_BYTES,
  TRANSFER_TTLS,
} from "../../domain/file-transfer.mjs";

const TERMINAL = new Set(["completed", "ambiguous_terminal", "revoked", "expired", "failed"]);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transfer_instances (
  id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transfer_artifacts (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_key TEXT NOT NULL, request_id TEXT NOT NULL,
  name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0), sha256 TEXT, identity_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('preparing','publishing','ready','failed','deleting','deleted')),
  prepared_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  pid INTEGER NOT NULL, instance_id TEXT NOT NULL, UNIQUE(owner,request_id)
);
CREATE INDEX IF NOT EXISTS transfer_artifacts_owner ON transfer_artifacts(owner,source_key,created_at);
CREATE INDEX IF NOT EXISTS transfer_artifacts_expiry ON transfer_artifacts(state,expires_at);
CREATE TABLE IF NOT EXISTS transfer_blocks (
  artifact_id TEXT NOT NULL REFERENCES transfer_artifacts(id), block INTEGER NOT NULL,
  hash TEXT NOT NULL, PRIMARY KEY(artifact_id,block)
);
CREATE TABLE IF NOT EXISTS transfer_shares (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES transfer_artifacts(id), owner TEXT NOT NULL,
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL, kid TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('ready','claimed','downloading','completed','ambiguous_terminal','revoking','revoked','expiring','expired','failed')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, claimed_at INTEGER, completed_at INTEGER,
  generation INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,request_id)
);
CREATE INDEX IF NOT EXISTS transfer_shares_artifact ON transfer_shares(artifact_id,created_at);
CREATE INDEX IF NOT EXISTS transfer_shares_expiry ON transfer_shares(state,expires_at);
CREATE TABLE IF NOT EXISTS transfer_sessions (
  id TEXT PRIMARY KEY, share_id TEXT NOT NULL UNIQUE REFERENCES transfer_shares(id),
  kid TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
  jkt TEXT NOT NULL, public_jwk_json TEXT NOT NULL, claim_hash TEXT NOT NULL UNIQUE,
  idle_until INTEGER NOT NULL, coverage_json TEXT NOT NULL DEFAULT '[]', bytes_served INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0, first_byte_at INTEGER
);
CREATE TABLE IF NOT EXISTS transfer_claim_challenges (
  id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES transfer_shares(id), claim_id TEXT NOT NULL,
  jkt TEXT NOT NULL, public_jwk_json TEXT NOT NULL, nonce_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, consumed_at INTEGER, UNIQUE(share_id,claim_id)
);
CREATE INDEX IF NOT EXISTS transfer_claim_challenges_expiry ON transfer_claim_challenges(expires_at);
CREATE TABLE IF NOT EXISTS transfer_plans (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES transfer_sessions(id), client_request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('issued','active','finished','aborted','ambiguous_terminal')),
  payload_hash TEXT NOT NULL UNIQUE, nonce_hash TEXT NOT NULL, proof_hash TEXT, start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL, generation INTEGER NOT NULL, etag TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, activated_at INTEGER,
  request_id TEXT UNIQUE, UNIQUE(session_id,client_request_id)
);
CREATE INDEX IF NOT EXISTS transfer_plans_session ON transfer_plans(session_id,state,created_at);
CREATE TABLE IF NOT EXISTS transfer_requests (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES transfer_sessions(id),
  plan_id TEXT NOT NULL UNIQUE REFERENCES transfer_plans(id),
  state TEXT NOT NULL CHECK(state IN ('active','output_candidate','terminal_candidate','finished','aborted','ambiguous_terminal')),
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
  bytes_authorized INTEGER NOT NULL DEFAULT 0, bytes_enqueued INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL, instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
  ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS transfer_one_active ON transfer_requests(session_id)
  WHERE state IN ('active','output_candidate','terminal_candidate');
CREATE INDEX IF NOT EXISTS transfer_requests_active ON transfer_requests(state,ip_hash);
CREATE TABLE IF NOT EXISTS transfer_audit (
  seq INTEGER PRIMARY KEY, share_id TEXT, artifact_id TEXT, request_id TEXT,
  event TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfer_audit_share ON transfer_audit(share_id,seq);
CREATE TRIGGER IF NOT EXISTS transfer_audit_no_update BEFORE UPDATE ON transfer_audit
  BEGIN SELECT RAISE(ABORT,'transfer audit is append only'); END;
CREATE TRIGGER IF NOT EXISTS transfer_audit_no_delete BEFORE DELETE ON transfer_audit
  BEGIN SELECT RAISE(ABORT,'transfer audit is append only'); END;
CREATE TABLE IF NOT EXISTS transfer_rate (
  key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS transfer_artifact_immutable BEFORE UPDATE ON transfer_artifacts
  WHEN OLD.state='ready' AND (NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner OR NEW.name IS NOT OLD.name
    OR NEW.size IS NOT OLD.size OR NEW.sha256 IS NOT OLD.sha256 OR NEW.identity_json IS NOT OLD.identity_json
    OR NEW.source_key IS NOT OLD.source_key OR NEW.request_id IS NOT OLD.request_id)
  BEGIN SELECT RAISE(ABORT,'transfer artifact immutable'); END;
CREATE TRIGGER IF NOT EXISTS transfer_no_share_reopen BEFORE UPDATE ON transfer_shares
  WHEN (OLD.state!='ready' AND NEW.state='ready')
    OR (OLD.state IN ('completed','ambiguous_terminal','revoked','expired','failed') AND NEW.state!=OLD.state)
    OR NEW.artifact_id IS NOT OLD.artifact_id OR NEW.secret_hash IS NOT OLD.secret_hash
    OR NEW.kid IS NOT OLD.kid OR NEW.owner IS NOT OLD.owner OR NEW.request_hash IS NOT OLD.request_hash
    OR NEW.expires_at IS NOT OLD.expires_at
  BEGIN SELECT RAISE(ABORT,'transfer share cannot reopen or change identity'); END;
`;

function artifactView(row) {
  return row && { id: row.id, name: row.name, size: row.size, sha256: row.sha256,
    state: row.state, preparedBytes: row.prepared_bytes, expiresAt: row.expires_at,
    reserved: row.reserved === 1 };
}
function shareView(row) {
  return { id: row.id, artifactId: row.artifact_id, state: row.state, name: row.name, size: row.size,
    sha256: row.sha256, createdAt: row.created_at, expiresAt: row.expires_at,
    claimedAt: row.claimed_at, completedAt: row.completed_at,
    bytesServed: row.bytes_served ?? 0, firstByteAt: row.first_byte_at ?? null };
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function exactText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only synchronous SQLite work enters these short transactions. */
export class FileTransferStore {
  #dataDir; #database; #initializing; #queue = new AsyncSqliteMutationQueue();
  #now; #policy; #alive; #instanceId;
  constructor({ dataDir, policy, now = Date.now, isAlive = processIsAlive, instanceId = randomUUID() }) {
    this.#dataDir = path.resolve(dataDir); this.#policy = policy; this.#now = now; this.#alive = isAlive;
    this.#instanceId = String(instanceId);
  }
  async initialize() {
    if (this.#database) return;
    this.#initializing ??= (async () => {
      await mkdir(this.#dataDir, { recursive: true });
      const db = new DatabaseSync(path.join(this.#dataDir, "runtime.sqlite"));
      db.exec("PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;");
      try {
        await this.#queue.run(() => {
          db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
          db.exec("BEGIN IMMEDIATE");
          try {
            db.exec(SCHEMA);
            db.prepare("INSERT OR IGNORE INTO transfer_meta VALUES ('health_id',?)").run(randomBytes(32).toString("hex"));
            const now = Math.trunc(this.#now());
            db.prepare("INSERT INTO transfer_instances(id,pid,started_at,heartbeat_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,heartbeat_at=excluded.heartbeat_at")
              .run(this.#instanceId, process.pid, now, now);
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        });
        this.#database = db;
      } catch (error) { db.close(); throw error; }
    })().finally(() => { this.#initializing = null; });
    await this.#initializing;
  }
  async #tx(operation) {
    await this.initialize();
    const result = await this.#queue.run(() => {
      const db = this.#database;
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = Math.trunc(this.#now());
        const prior = Number(db.prepare("SELECT value FROM transfer_meta WHERE key='clock'").get()?.value ?? 0);
        if (!Number.isSafeInteger(now) || now < prior) throw transferError("transfer-clock-regression", 503);
        db.prepare("INSERT INTO transfer_meta VALUES('clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
        db.prepare("UPDATE transfer_instances SET heartbeat_at=? WHERE id=?").run(now, this.#instanceId);
        const value = operation(db, now);
        db.exec("COMMIT");
        return value;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    if (result?.failure) throw transferError(result.failure, result.status ?? 410);
    return result;
  }
  #audit(db, now, event, { shareId = null, artifactId = null, requestId = null, bytes = 0 } = {}) {
    db.prepare("INSERT INTO transfer_audit(share_id,artifact_id,request_id,event,bytes,observed_at) VALUES(?,?,?,?,?,?)")
      .run(shareId, artifactId, requestId, event, bytes, now);
  }
  #recoverPreparations(db, now) {
    for (const row of db.prepare("SELECT * FROM transfer_artifacts WHERE state='preparing'").all()) {
      const instance = db.prepare("SELECT heartbeat_at FROM transfer_instances WHERE id=?").get(row.instance_id);
      if (instance && instance.heartbeat_at >= now - 30_000) continue;
      db.prepare("UPDATE transfer_artifacts SET state='failed' WHERE id=? AND state='preparing'").run(row.id);
      this.#audit(db, now, "preparation-failed", { artifactId: row.id });
    }
  }
  async healthId() {
    await this.initialize();
    return this.#database.prepare("SELECT value FROM transfer_meta WHERE key='health_id'").get().value;
  }
  reserve({ owner, sourceKey, sourceAliases = [sourceKey], sourceKids = [], requestId, name, size, availableBytes }) {
    return this.#tx((db, now) => {
      const aliases = Array.isArray(sourceAliases) ? sourceAliases.map(String) : [];
      const kids = Array.isArray(sourceKids) ? sourceKids.map(String) : [];
      if (!aliases.length || aliases.length > 32 || kids.length > 32
        || !aliases.some((alias) => exactText(alias, sourceKey))) {
        throw transferError("transfer-invalid-source", 400);
      }
      const existing = db.prepare("SELECT * FROM transfer_artifacts WHERE owner=? AND request_id=?").get(owner, requestId);
      if (existing) {
        const sameSource = aliases.some((alias) => exactText(existing.source_key, alias));
        if (!sameSource) {
          const separator = existing.source_key.indexOf(".");
          const persistedKid = separator > 0 ? existing.source_key.slice(0, separator) : null;
          if (persistedKid && kids.length && !kids.some((kid) => exactText(kid, persistedKid))) {
            return { failure: "transfer-unavailable", status: 410 };
          }
          throw transferError("transfer-request-conflict", 409);
        }
        if (existing.name !== name || existing.size !== size) throw transferError("transfer-request-conflict", 409);
        return artifactView(existing);
      }
      this.#recoverPreparations(db, now);
      const total = db.prepare("SELECT coalesce(sum(size),0) bytes,count(*) count FROM transfer_artifacts WHERE state!='deleted'").get();
      const mine = db.prepare("SELECT coalesce(sum(size),0) bytes,count(*) count FROM transfer_artifacts WHERE owner=? AND state!='deleted'").get(owner);
      const preparing = db.prepare("SELECT count(*) n FROM transfer_artifacts WHERE state IN ('preparing','publishing')").get().n;
      // Keep the whole managed size reserved until deletion. statfs already reflects materialized bytes,
      // so this deliberately double-counts them: no preparation/READY transition can make a stale
      // pre-transaction statfs snapshot admit more AgentHub-managed bytes.
      const physicallyReserved = db.prepare("SELECT coalesce(sum(size),0) bytes FROM transfer_artifacts WHERE state!='deleted'").get().bytes;
      if (size > this.#policy.maxBytes || mine.bytes + size > this.#policy.ownerBytes || total.bytes + size > this.#policy.storageBytes
        || mine.count >= this.#policy.maxArtifacts || preparing >= this.#policy.maxPreparations
        || !Number.isSafeInteger(availableBytes) || availableBytes - physicallyReserved - size < this.#policy.freeBytes) {
        throw transferError("transfer-storage-quota", 429);
      }
      const id = randomUUID();
      db.prepare("INSERT INTO transfer_artifacts(id,owner,source_key,request_id,name,size,state,created_at,expires_at,pid,instance_id) VALUES(?,?,?,?,?,?,'preparing',?,?,?,?)")
        .run(id, owner, sourceKey, requestId, name, size, now, now + this.#policy.preparationTtlMs, process.pid, this.#instanceId);
      this.#audit(db, now, "preparing", { artifactId: id });
      return artifactView({ ...db.prepare("SELECT * FROM transfer_artifacts WHERE id=?").get(id), reserved: 1 });
    });
  }
  addBlocks(id, blocks, progress) {
    return this.#tx((db) => {
      const row = db.prepare("SELECT state,instance_id FROM transfer_artifacts WHERE id=?").get(id);
      if (row?.state !== "preparing" || row.instance_id !== this.#instanceId) throw transferError("transfer-preparation-cancelled", 409);
      const insert = db.prepare("INSERT INTO transfer_blocks VALUES(?,?,?)");
      for (const [block, hash] of blocks) insert.run(id, block, hash);
      db.prepare("UPDATE transfer_artifacts SET prepared_bytes=? WHERE id=?").run(progress, id);
    });
  }
  heartbeatPreparation(id) {
    return this.#tx((db) => {
      const row = db.prepare("SELECT state,instance_id FROM transfer_artifacts WHERE id=?").get(id);
      if (!row || row.state !== "preparing" || row.instance_id !== this.#instanceId) {
        throw transferError("transfer-preparation-lost", 409);
      }
    });
  }
  publishing(id, sha256) {
    return this.#tx((db, now) => {
      const changed = db.prepare("UPDATE transfer_artifacts SET state='publishing',sha256=? WHERE id=? AND state='preparing' AND instance_id=? AND expires_at>?")
        .run(sha256, id, this.#instanceId, now).changes;
      if (!changed) throw transferError("transfer-preparation-unavailable", 409);
      this.#audit(db, now, "publishing", { artifactId: id });
    });
  }
  ready(id, sha256, identity) {
    return this.#tx((db, now) => {
      const retention = Math.max(...TRANSFER_TTLS) + this.#policy.sessionTtlMs + 86_400_000;
      const changed = db.prepare("UPDATE transfer_artifacts SET state='ready',identity_json=?,expires_at=? WHERE id=? AND state='publishing' AND sha256=? AND expires_at>?")
        .run(JSON.stringify(identity), now + retention, id, sha256, now).changes;
      if (!changed) throw transferError("transfer-preparation-unavailable", 409);
      this.#audit(db, now, "ready", { artifactId: id });
    });
  }
  failPreparation(owner, id) {
    return this.#tx((db, now) => {
      const result = db.prepare("UPDATE transfer_artifacts SET state='failed' WHERE id=? AND owner=? AND state IN ('preparing','publishing')").run(id, owner);
      if (result.changes) this.#audit(db, now, "preparation-failed", { artifactId: id });
    });
  }
  publishingArtifacts() {
    return this.#tx((db) => db.prepare("SELECT id,owner,name,size,sha256 FROM transfer_artifacts WHERE state='publishing' ORDER BY created_at LIMIT 16").all());
  }
  artifact(owner, id) {
    return this.#tx((db, now) => {
      this.#recoverPreparations(db, now);
      const row = db.prepare("SELECT * FROM transfer_artifacts WHERE id=? AND owner=?").get(id, owner);
      if (!row) throw transferError("transfer-artifact-not-found", 404);
      if (row.state === "preparing" && row.expires_at <= now) {
        db.prepare("UPDATE transfer_artifacts SET state='failed' WHERE id=?").run(id);
        this.#audit(db, now, "preparation-failed", { artifactId: id }); row.state = "failed";
      }
      return artifactView(row);
    });
  }
  ownerFile(owner, sourceKeys) {
    return this.#tx((db, now) => {
      const keys = Array.isArray(sourceKeys) ? sourceKeys.map(String) : [];
      if (!keys.length || keys.length > 32) throw transferError("transfer-invalid-source", 400);
      this.#recoverPreparations(db, now);
      const placeholders = keys.map(() => "?").join(",");
      const artifact = db.prepare(`SELECT * FROM transfer_artifacts WHERE owner=? AND source_key IN (${placeholders}) AND state!='deleted' ORDER BY created_at DESC LIMIT 1`)
        .get(owner, ...keys);
      if (!artifact) return null;
      let share = db.prepare("SELECT t.*,s.bytes_served,s.first_byte_at FROM transfer_shares t LEFT JOIN transfer_sessions s ON s.share_id=t.id WHERE t.artifact_id=? ORDER BY t.created_at DESC LIMIT 1")
        .get(artifact.id);
      if (share) {
        this.#expire(db, now, share);
        share = db.prepare("SELECT t.*,s.bytes_served,s.first_byte_at FROM transfer_shares t LEFT JOIN transfer_sessions s ON s.share_id=t.id WHERE t.id=?")
          .get(share.id);
      }
      return {
        artifact: artifactView(db.prepare("SELECT * FROM transfer_artifacts WHERE id=?").get(artifact.id)),
        share: share ? {
          ...shareView({ ...share, name: artifact.name, size: artifact.size, sha256: artifact.sha256 }),
          kid: share.kid,
          requestId: share.request_id,
          secretHash: share.secret_hash,
        } : null,
      };
    });
  }
  create({ owner, artifactId, requestId, kid, secretHash, ttlMs }) {
    return this.#tx((db, now) => {
      if (!TRANSFER_TTLS.includes(ttlMs)) throw transferError("transfer-invalid-expiry", 400);
      const requestHash = transferHash(JSON.stringify(["agenthub-transfer-create-v1", owner, artifactId,
        requestId, ttlMs]));
      const persistedView = (shareId) => {
        const row = db.prepare(`SELECT t.*,a.name,a.size,a.sha256,s.bytes_served,s.first_byte_at
          FROM transfer_shares t JOIN transfer_artifacts a ON a.id=t.artifact_id
          LEFT JOIN transfer_sessions s ON s.share_id=t.id WHERE t.id=?`).get(shareId);
        return {
          ...shareView(row),
          kid: row.kid,
          requestId: row.request_id,
          secretHash: row.secret_hash,
        };
      };
      const old = db.prepare("SELECT * FROM transfer_shares WHERE owner=? AND request_id=?").get(owner, requestId);
      if (old) {
        if (old.request_hash !== requestHash) throw transferError("transfer-request-conflict", 409);
        this.#expire(db, now, old);
        return persistedView(old.id);
      }
      const artifact = db.prepare("SELECT * FROM transfer_artifacts WHERE id=? AND owner=? AND state='ready' AND expires_at>?").get(artifactId, owner, now);
      if (!artifact) throw transferError("transfer-artifact-unavailable", 409);
      const shares = db.prepare("SELECT count(*) n FROM transfer_shares WHERE owner=? AND created_at>?").get(owner, now - 86_400_000).n;
      if (shares >= 64) throw transferError("transfer-share-quota", 429);
      const id = randomUUID();
      db.prepare("INSERT INTO transfer_shares(id,artifact_id,owner,request_id,request_hash,kid,secret_hash,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'ready',?,?)")
        .run(id, artifactId, owner, requestId, requestHash, kid, secretHash, now, now + ttlMs);
      this.#audit(db, now, "created", { shareId: id, artifactId });
      return persistedView(id);
    });
  }
  #expire(db, now, row) {
    if (!row || TERMINAL.has(row.state)) return;
    const session = db.prepare("SELECT * FROM transfer_sessions WHERE share_id=?").get(row.id);
    if (row.expires_at <= now || (session && (session.expires_at <= now || session.idle_until <= now))) {
      if (!["revoking", "expiring"].includes(row.state)) {
        db.prepare("UPDATE transfer_shares SET state='expiring',generation=generation+1 WHERE id=?").run(row.id);
        this.#audit(db, now, "expiring", { shareId: row.id }); row.state = "expiring";
      }
    }
    this.#recoverRequests(db, now, row);
    if (["revoking", "expiring"].includes(row.state)) {
      const active = db.prepare("SELECT 1 FROM transfer_requests r JOIN transfer_sessions s ON s.id=r.session_id WHERE s.share_id=? AND r.state IN ('active','output_candidate','terminal_candidate')").get(row.id);
      if (!active) {
        row.state = row.state === "revoking" ? "revoked" : "expired";
        db.prepare("UPDATE transfer_shares SET state=? WHERE id=?").run(row.state, row.id);
        this.#audit(db, now, row.state, { shareId: row.id });
      }
    }
  }
  #recoverRequests(db, now, share) {
    const active = db.prepare("SELECT r.* FROM transfer_requests r JOIN transfer_sessions s ON s.id=r.session_id WHERE s.share_id=? AND r.state IN ('active','output_candidate','terminal_candidate')").get(share.id);
    if (!active) return;
    const inFlightOutput = active.bytes_authorized !== active.bytes_enqueued;
    const owner = db.prepare("SELECT pid,heartbeat_at FROM transfer_instances WHERE id=?").get(active.instance_id);
    if (!inFlightOutput && owner && owner.pid === active.pid && this.#alive(owner.pid) && owner.heartbeat_at >= now - 30_000) return;
    const ambiguous = inFlightOutput || ["output_candidate", "terminal_candidate"].includes(active.state);
    db.prepare("UPDATE transfer_requests SET state=?,finished_at=? WHERE id=?").run(ambiguous ? "ambiguous_terminal" : "aborted", now, active.id);
    db.prepare("UPDATE transfer_plans SET state=? WHERE id=? AND state='active'")
      .run(ambiguous ? "ambiguous_terminal" : "aborted", active.plan_id);
    if (ambiguous && !["revoking", "expiring"].includes(share.state)) {
      share.state = "ambiguous_terminal";
      db.prepare("UPDATE transfer_shares SET state='ambiguous_terminal',generation=generation+1 WHERE id=?").run(share.id);
    } else if (!ambiguous && share.state === "downloading") {
      share.state = "claimed";
      db.prepare("UPDATE transfer_shares SET state='claimed' WHERE id=?").run(share.id);
    }
    this.#audit(db, now, ambiguous ? "ambiguous_terminal" : "aborted", { shareId: share.id, requestId: active.id, bytes: active.bytes_enqueued });
  }
  inspect(secretHash, kid, shareId = null) {
    return this.#tx((db, now) => {
      const row = shareId
        ? db.prepare("SELECT t.*,a.name,a.size,a.sha256 FROM transfer_shares t JOIN transfer_artifacts a ON a.id=t.artifact_id WHERE t.id=? AND t.secret_hash=? AND t.kid=?").get(shareId, secretHash, kid)
        : db.prepare("SELECT t.*,a.name,a.size,a.sha256 FROM transfer_shares t JOIN transfer_artifacts a ON a.id=t.artifact_id WHERE t.secret_hash=? AND t.kid=?").get(secretHash, kid);
      this.#expire(db, now, row);
      if (!row || row.state !== "ready") return { failure: "transfer-unavailable" };
      return { name: row.name, size: row.size, sha256: row.sha256, expiresAt: row.expires_at };
    });
  }
  issueClaimChallenge({ secretHash, kid, shareId, claimId, jkt, publicJwk, nonce }) {
    return this.#tx((db, now) => {
      const row = db.prepare("SELECT * FROM transfer_shares WHERE id=? AND secret_hash=? AND kid=?").get(shareId, secretHash, kid);
      this.#expire(db, now, row);
      if (!row || !equalTransferDigest(row.secret_hash, secretHash) || row.state !== "ready") return { failure: "transfer-unavailable" };
      const old = db.prepare("SELECT * FROM transfer_claim_challenges WHERE share_id=? AND claim_id=?").get(row.id, claimId);
      if (old) {
        if (old.jkt !== jkt || old.public_jwk_json !== publicJwk || old.nonce_hash !== transferHash(nonce)
          || old.expires_at <= now || old.consumed_at) {
          return { failure: "transfer-unavailable" };
        }
        return { challengeId: old.id, shareId: row.id, claimId, jkt, nonce, expiresAt: old.expires_at, replay: true };
      }
      const outstanding = db.prepare("SELECT count(*) n FROM transfer_claim_challenges WHERE share_id=? AND consumed_at IS NULL AND expires_at>?").get(row.id, now).n;
      if (outstanding >= 128) return { failure: "transfer-rate-limit", status: 429 };
      const id = randomUUID();
      const expiresAt = Math.min(row.expires_at, now + 60_000);
      db.prepare("INSERT INTO transfer_claim_challenges(id,share_id,claim_id,jkt,public_jwk_json,nonce_hash,expires_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, row.id, claimId, jkt, publicJwk, transferHash(nonce), expiresAt);
      return { challengeId: id, shareId: row.id, claimId, jkt, nonce, expiresAt };
    });
  }
  claim({ secretHash, kid, challenge, claimHash, sessionId, sessionKid, sessionHash }) {
    return this.#tx((db, now) => {
      const replay = db.prepare("SELECT * FROM transfer_sessions WHERE claim_hash=?").get(claimHash);
      if (replay) {
        const share = db.prepare("SELECT kid,secret_hash FROM transfer_shares WHERE id=?").get(replay.share_id);
        if (!share || share.kid !== kid || !equalTransferDigest(share.secret_hash, secretHash)) {
          return { failure: "transfer-unavailable" };
        }
        return { id: replay.id, expiresAt: replay.expires_at, kid: replay.kid, replay: true };
      }
      const nonceHash = transferHash(String(challenge.nonce));
      const pending = db.prepare("SELECT * FROM transfer_claim_challenges WHERE id=? AND share_id=? AND claim_id=? AND jkt=? AND nonce_hash=?")
        .get(challenge.challengeId, challenge.shareId, challenge.claimId, challenge.jkt, nonceHash);
      if (!pending || pending.consumed_at || pending.expires_at !== challenge.expiresAt || pending.expires_at <= now) {
        return { failure: "transfer-unavailable" };
      }
      const row = db.prepare("SELECT * FROM transfer_shares WHERE id=? AND secret_hash=? AND kid=?").get(challenge.shareId, secretHash, kid);
      this.#expire(db, now, row);
      if (!row || !equalTransferDigest(row.secret_hash, secretHash) || row.state !== "ready") return { failure: "transfer-unavailable" };
      const change = db.prepare("UPDATE transfer_shares SET state='claimed',claimed_at=? WHERE id=? AND state='ready' AND expires_at>?").run(now, row.id, now);
      if (change.changes !== 1) return { failure: "transfer-unavailable" };
      const expiresAt = Math.min(row.expires_at, now + this.#policy.sessionTtlMs);
      db.prepare("UPDATE transfer_claim_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(now, pending.id);
      db.prepare("INSERT INTO transfer_sessions(id,share_id,kid,secret_hash,expires_at,jkt,public_jwk_json,claim_hash,idle_until) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(sessionId, row.id, sessionKid, sessionHash, expiresAt, pending.jkt, pending.public_jwk_json,
          claimHash, Math.min(expiresAt, now + this.#policy.idleTtlMs));
      this.#audit(db, now, "claimed", { shareId: row.id });
      return { id: sessionId, expiresAt, kid: sessionKid };
    });
  }
  #session(db, now, id, secretHash, kid) {
    const session = db.prepare("SELECT * FROM transfer_sessions WHERE id=? AND secret_hash=? AND kid=?").get(id, secretHash, kid);
    if (!session) return null;
    const share = db.prepare("SELECT t.*,a.name,a.size,a.sha256,a.identity_json FROM transfer_shares t JOIN transfer_artifacts a ON a.id=t.artifact_id WHERE t.id=? AND a.state='ready'").get(session.share_id);
    this.#expire(db, now, share);
    if (!share || !["claimed", "downloading"].includes(share.state)) return null;
    return { session, share };
  }
  session(id, secretHash, kid) {
    return this.#tx((db, now) => {
      const value = this.#session(db, now, id, secretHash, kid);
      return value ? { id, expiresAt: value.session.expires_at, ...shareView(value.share) } : { failure: "transfer-unavailable" };
    });
  }
  issuePlan({ sessionId, secretHash, kid, sessionSelector, clientRequestId, planId, nonce, start, end }) {
    return this.#tx((db, now) => {
      const value = this.#session(db, now, sessionId, secretHash, kid);
      if (!value) return { failure: "transfer-unavailable" };
      const { share, session } = value;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= share.size) throw transferError("transfer-invalid-range", 416);
      const old = db.prepare("SELECT * FROM transfer_plans WHERE session_id=? AND client_request_id=?").get(sessionId, clientRequestId);
      const expiresAt = old?.expires_at ?? Math.min(session.expires_at, session.idle_until, now + 60_000);
      const etag = `\"sha256-${share.sha256}-g${share.generation}\"`;
      const payload = transferPlanPayload({ planId, sessionId, sessionSelector, artifactId: share.artifact_id,
        generation: share.generation, start, end, etag, nonce, expiresAt });
      if (old) {
        if (old.state !== "issued" || old.expires_at <= now || old.id !== planId
          || old.payload_hash !== transferHash(payload) || old.nonce_hash !== transferHash(nonce)) {
          throw transferError("transfer-request-conflict", 409);
        }
        return { payload, planId, expiresAt: old.expires_at, replay: true };
      }
      db.prepare("UPDATE transfer_plans SET state='aborted' WHERE session_id=? AND state='issued' AND expires_at<=?")
        .run(sessionId, now);
      if (db.prepare("SELECT count(*) n FROM transfer_plans WHERE session_id=? AND state='issued'").get(sessionId).n >= 8) {
        return { failure: "transfer-rate-limit", status: 429 };
      }
      db.prepare("INSERT INTO transfer_plans(id,session_id,client_request_id,state,payload_hash,nonce_hash,start_byte,end_byte,generation,etag,expires_at,created_at) VALUES(?,?,?,'issued',?,?,?,?,?,?,?,?)")
        .run(planId, sessionId, clientRequestId, transferHash(payload), transferHash(nonce), start, end,
          share.generation, etag, expiresAt, now);
      return { payload, planId, expiresAt };
    });
  }
  planForVerification({ sessionId, secretHash, kid, planId }) {
    return this.#tx((db, now) => {
      const value = this.#session(db, now, sessionId, secretHash, kid);
      if (!value) return { failure: "transfer-unavailable" };
      const plan = db.prepare("SELECT * FROM transfer_plans WHERE id=? AND session_id=?").get(planId, sessionId);
      if (!plan || plan.state !== "issued" || plan.expires_at <= now) return { failure: "transfer-unavailable" };
      return { payloadHash: plan.payload_hash, jkt: value.session.jkt,
        publicJwk: value.session.public_jwk_json, expiresAt: plan.expires_at };
    });
  }
  activatePlan({ sessionId, secretHash, kid, planId, payload, proofHash, ipHash }) {
    return this.#tx((db, now) => {
      const value = this.#session(db, now, sessionId, secretHash, kid);
      if (!value) return { failure: "transfer-unavailable" };
      const { share, session } = value;
      const plan = db.prepare("SELECT * FROM transfer_plans WHERE id=? AND session_id=?").get(planId, sessionId);
      if (!plan || plan.state !== "issued" || plan.expires_at <= now || plan.generation !== share.generation
        || plan.payload_hash !== transferHash(payload)) return { failure: "transfer-unavailable" };
      let parsed;
      try { parsed = JSON.parse(payload); } catch { return { failure: "transfer-unavailable" }; }
      if (transferHash(String(parsed.nonce)) !== plan.nonce_hash) return { failure: "transfer-unavailable" };
      if (db.prepare("SELECT 1 FROM transfer_requests WHERE session_id=? AND state IN ('active','output_candidate','terminal_candidate')").get(sessionId)) throw transferError("transfer-stream-busy", 409);
      const global = db.prepare("SELECT count(*) n FROM transfer_requests WHERE state IN ('active','output_candidate','terminal_candidate')").get().n;
      const ip = db.prepare("SELECT count(*) n FROM transfer_requests WHERE ip_hash=? AND state IN ('active','output_candidate','terminal_candidate')").get(ipHash).n;
      if (global >= this.#policy.maxStreams || ip >= 2 || session.requests >= this.#policy.maxRequests) throw transferError("transfer-stream-quota", 429);
      const requestId = randomUUID();
      const activated = db.prepare("UPDATE transfer_plans SET state='active',activated_at=?,request_id=?,proof_hash=? WHERE id=? AND state='issued'")
        .run(now, requestId, proofHash, plan.id).changes;
      if (activated !== 1) return { failure: "transfer-unavailable" };
      db.prepare("INSERT INTO transfer_requests(id,session_id,plan_id,state,start_byte,end_byte,pid,instance_id,generation,ip_hash,created_at) VALUES(?,?,?,'active',?,?,?,?,?,?,?)")
        .run(requestId, sessionId, plan.id, plan.start_byte, plan.end_byte, process.pid, this.#instanceId,
          share.generation, ipHash, now);
      db.prepare("UPDATE transfer_sessions SET requests=requests+1,idle_until=? WHERE id=?")
        .run(Math.min(session.expires_at, now + this.#policy.idleTtlMs), sessionId);
      db.prepare("UPDATE transfer_shares SET state='downloading' WHERE id=?").run(share.id);
      this.#audit(db, now, "request-start", { shareId: share.id, requestId });
      return { id: requestId, instanceId: this.#instanceId, planId: plan.id, proofHash,
        artifactId: share.artifact_id, name: share.name, size: share.size, sha256: share.sha256,
        etag: plan.etag, identity: JSON.parse(share.identity_json), start: plan.start_byte,
        end: plan.end_byte, generation: share.generation };
    });
  }
  blockHash(artifactId, block) {
    return this.#database.prepare("SELECT hash FROM transfer_blocks WHERE artifact_id=? AND block=?").get(artifactId, block)?.hash;
  }
  async blockHashes(artifactId, firstBlock, lastBlock) {
    await this.initialize();
    if (!Number.isSafeInteger(firstBlock) || !Number.isSafeInteger(lastBlock)
      || firstBlock < 0 || lastBlock < firstBlock) throw transferError("transfer-invalid-block-range", 500);
    return new Map(this.#database.prepare("SELECT block,hash FROM transfer_blocks WHERE artifact_id=? AND block BETWEEN ? AND ? ORDER BY block")
      .all(artifactId, firstBlock, lastBlock).map((row) => [row.block, row.hash]));
  }
  // The transfer store owns the exact emitted chunk. Validation/accounting is
  // committed and the synchronous socket write is invoked before this owner's
  // mutation lane is released, so revoke/expiry cannot overtake the permit.
  async authorizeBlockOutput(requestId, blockStart, block, write, { signal } = {}) {
    if (!Buffer.isBuffer(block) || block.length < 1 || block.length > TRANSFER_BLOCK_BYTES
      || !Number.isSafeInteger(blockStart) || blockStart < 0 || blockStart % TRANSFER_BLOCK_BYTES !== 0) {
      throw transferError("transfer-invalid-output-block", 500);
    }
    if (typeof write !== "function") throw new TypeError("Transfer output writer is required");
    if (signal !== undefined && typeof signal?.aborted !== "boolean") {
      throw new TypeError("Transfer output abort signal is invalid");
    }
    const throwIfAborted = () => {
      if (signal?.aborted) throw transferError("transfer-output-aborted", 410);
    };
    throwIfAborted();
    await this.initialize();
    const ownedBlock = Buffer.from(block);
    const observedBlockHash = createHash("sha256").update(ownedBlock).digest("hex");
    return this.#queue.run(async () => {
      const { row, chunk } = await this.#retryOutputPhase(() => {
        const db = this.#database;
        db.exec("BEGIN IMMEDIATE");
        try {
          const now = Math.trunc(this.#now());
          const prior = Number(db.prepare("SELECT value FROM transfer_meta WHERE key='clock'").get()?.value ?? 0);
          if (!Number.isSafeInteger(now) || now < prior) throw transferError("transfer-clock-regression", 503);
          db.prepare("INSERT INTO transfer_meta VALUES('clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
          db.prepare("UPDATE transfer_instances SET heartbeat_at=? WHERE id=?").run(now, this.#instanceId);
          const row = db.prepare("SELECT r.*,s.share_id,s.expires_at,s.idle_until,t.state share_state,t.generation share_generation,t.expires_at share_expiry,t.artifact_id,a.size artifact_size FROM transfer_requests r JOIN transfer_sessions s ON s.id=r.session_id JOIN transfer_shares t ON t.id=s.share_id JOIN transfer_artifacts a ON a.id=t.artifact_id WHERE r.id=?").get(requestId);
          if (!row || row.instance_id !== this.#instanceId || row.state !== "active" || row.share_state !== "downloading"
            || row.generation !== row.share_generation || row.expires_at <= now || row.idle_until <= now || row.share_expiry <= now) {
            throw transferError("transfer-unavailable", 410);
          }
          if (row.bytes_authorized !== row.bytes_enqueued) throw transferError("transfer-output-ambiguous", 409);
          const cursor = row.start_byte + row.bytes_enqueued;
          const expectedBlockStart = Math.floor(cursor / TRANSFER_BLOCK_BYTES) * TRANSFER_BLOCK_BYTES;
          const expectedBlockBytes = Math.min(TRANSFER_BLOCK_BYTES, row.artifact_size - expectedBlockStart);
          const expectedBlockHash = db.prepare("SELECT hash FROM transfer_blocks WHERE artifact_id=? AND block=?")
            .get(row.artifact_id, expectedBlockStart / TRANSFER_BLOCK_BYTES)?.hash;
          if (blockStart !== expectedBlockStart || ownedBlock.length !== expectedBlockBytes
            || observedBlockHash !== expectedBlockHash) throw transferError("transfer-output-block-mismatch", 500);
          const chunkStart = cursor - blockStart;
          const chunkEnd = Math.min(ownedBlock.length, row.end_byte - blockStart + 1);
          const chunk = Buffer.from(ownedBlock.subarray(chunkStart, chunkEnd));
          if (!chunk.length) throw transferError("transfer-output-cursor-mismatch", 500);
          const requestBytes = row.end_byte - row.start_byte + 1;
          const nextAuthorized = row.bytes_authorized + chunk.length;
          if (nextAuthorized > requestBytes) throw transferError("transfer-output-overflow", 500);
          throwIfAborted();
          db.prepare("UPDATE transfer_requests SET state=?,bytes_authorized=? WHERE id=?")
            .run(nextAuthorized === requestBytes ? "terminal_candidate" : "output_candidate", nextAuthorized, requestId);
          db.exec("COMMIT");
          return { row, chunk };
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
      try {
        const written = write(chunk);
        if (written && typeof written.then === "function") {
          throw new TypeError("Transfer output writer must be synchronous");
        }
      } catch (error) {
        await this.#markAmbiguousAfterOutputFailure(row, requestId);
        throw error;
      }
      try {
        await this.#retryOutputPhase(() => {
          const db = this.#database;
          db.exec("BEGIN IMMEDIATE");
          try {
            const request = db.prepare("SELECT bytes_authorized,bytes_enqueued,state FROM transfer_requests WHERE id=?").get(requestId);
            if (!request || request.bytes_authorized !== row.bytes_enqueued + chunk.length
              || request.bytes_enqueued !== row.bytes_enqueued
              || !["output_candidate", "terminal_candidate"].includes(request.state)) {
              throw transferError("transfer-output-accounting-conflict", 500);
            }
            db.prepare("UPDATE transfer_requests SET bytes_enqueued=bytes_enqueued+? WHERE id=?").run(chunk.length, requestId);
            const recordedAt = Math.trunc(this.#now());
            if (!row.bytes_enqueued) {
              db.prepare("UPDATE transfer_sessions SET first_byte_at=coalesce(first_byte_at,?) WHERE id=?")
                .run(recordedAt, row.session_id);
              this.#audit(db, recordedAt, "first-byte", { shareId: row.share_id, requestId });
            }
            db.prepare("UPDATE transfer_sessions SET bytes_served=bytes_served+?,idle_until=min(expires_at,?) WHERE id=?")
              .run(chunk.length, recordedAt + this.#policy.idleTtlMs, row.session_id);
            if (request.state === "output_candidate") {
              const share = db.prepare("SELECT state,generation FROM transfer_shares WHERE id=?").get(row.share_id);
              db.prepare("UPDATE transfer_requests SET state=?,finished_at=? WHERE id=?")
                .run(share?.state === "downloading" && share.generation === row.share_generation ? "active" : "aborted",
                  share?.state === "downloading" && share.generation === row.share_generation ? null : recordedAt, requestId);
            }
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        });
      } catch (error) {
        await this.#markAmbiguousAfterOutputFailure(row, requestId).catch(() => {});
        throw error;
      }
      return { enqueuedBytes: chunk.length };
    }, { retryContention: false });
  }
  async #retryOutputPhase(operation) {
    const deadline = Date.now() + 2_000;
    let delayMs = 10;
    for (;;) {
      try { return operation(); } catch (error) {
        if (!sqliteContention(error) || Date.now() >= deadline) throw error;
        await wait(delayMs);
        delayMs = Math.min(200, delayMs * 2);
      }
    }
  }
  #markAmbiguousAfterOutputFailure(row, requestId) {
    return this.#retryOutputPhase(() => {
      const db = this.#database;
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = Math.trunc(this.#now());
        db.prepare("UPDATE transfer_requests SET state='ambiguous_terminal',finished_at=? WHERE id=? AND state IN ('active','output_candidate','terminal_candidate')")
          .run(now, requestId);
        db.prepare("UPDATE transfer_plans SET state='ambiguous_terminal' WHERE id=? AND state='active'")
          .run(row.plan_id);
        db.prepare("UPDATE transfer_shares SET state='ambiguous_terminal',generation=generation+1 WHERE id=? AND state IN ('claimed','downloading')")
          .run(row.share_id);
        this.#audit(db, now, "ambiguous_terminal", { shareId: row.share_id, requestId, bytes: row.bytes_enqueued });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  finishRequest(id, instanceId, finished) {
    return this.#tx((db, now) => {
      const row = db.prepare("SELECT r.*,s.coverage_json,s.share_id,t.state share_state,a.size FROM transfer_requests r JOIN transfer_sessions s ON s.id=r.session_id JOIN transfer_shares t ON t.id=s.share_id JOIN transfer_artifacts a ON a.id=t.artifact_id WHERE r.id=?").get(id);
      if (!row || row.instance_id !== instanceId || !["active", "output_candidate", "terminal_candidate"].includes(row.state)) return;
      if (!finished && ["output_candidate", "terminal_candidate"].includes(row.state)) {
        db.prepare("UPDATE transfer_requests SET state='ambiguous_terminal',finished_at=? WHERE id=?").run(now, id);
        db.prepare("UPDATE transfer_plans SET state='ambiguous_terminal' WHERE id=? AND state='active'").run(row.plan_id);
        db.prepare("UPDATE transfer_shares SET state='ambiguous_terminal',generation=generation+1 WHERE id=? AND state IN ('claimed','downloading')")
          .run(row.share_id);
        this.#audit(db, now, "ambiguous_terminal", { shareId: row.share_id, requestId: id, bytes: row.bytes_enqueued });
        return;
      }
      const successful = finished && row.bytes_authorized === row.bytes_enqueued
        && row.bytes_enqueued === row.end_byte - row.start_byte + 1;
      const coverage = successful ? mergeTransferCoverage(JSON.parse(row.coverage_json), row.start_byte, row.end_byte) : JSON.parse(row.coverage_json);
      const complete = successful && coverage.length === 1 && coverage[0][0] === 0 && coverage[0][1] === row.size - 1;
      db.prepare("UPDATE transfer_requests SET state=?,finished_at=? WHERE id=?").run(successful ? "finished" : "aborted", now, id);
      db.prepare("UPDATE transfer_plans SET state=? WHERE id=? AND state='active'")
        .run(successful ? "finished" : "aborted", row.plan_id);
      if (successful) db.prepare("UPDATE transfer_sessions SET coverage_json=? WHERE id=?").run(JSON.stringify(coverage), row.session_id);
      this.#audit(db, now, successful ? "range-finished" : "aborted", { shareId: row.share_id, requestId: id, bytes: row.bytes_enqueued });
      if (complete && row.share_state === "downloading") {
        db.prepare("UPDATE transfer_shares SET state='completed',completed_at=?,generation=generation+1 WHERE id=?").run(now, row.share_id);
        this.#audit(db, now, "completed", { shareId: row.share_id });
      } else {
        const share = db.prepare("SELECT * FROM transfer_shares WHERE id=?").get(row.share_id);
        this.#expire(db, now, share);
        if (share.state === "downloading") db.prepare("UPDATE transfer_shares SET state='claimed' WHERE id=?").run(share.id);
      }
    });
  }
  revoke(owner, id) {
    return this.#tx((db, now) => {
      const row = db.prepare("SELECT * FROM transfer_shares WHERE id=? AND owner=?").get(id, owner);
      if (!row) throw transferError("transfer-share-not-found", 404);
      if (!TERMINAL.has(row.state) && row.state !== "revoking") {
        db.prepare("UPDATE transfer_shares SET state='revoking',generation=generation+1 WHERE id=?").run(id);
        this.#audit(db, now, "revoking", { shareId: id }); row.state = "revoking";
      }
      this.#expire(db, now, row);
      return { id, state: row.state };
    });
  }
  list(owner, sourceKeys) {
    return this.#tx((db, now) => {
      const keys = Array.isArray(sourceKeys) ? sourceKeys.map(String) : [String(sourceKeys)];
      if (!keys.length || keys.length > 32) throw transferError("transfer-invalid-source", 400);
      const placeholders = keys.map(() => "?").join(",");
      const rows = db.prepare(`SELECT t.*,a.name,a.size,a.sha256,s.bytes_served,s.first_byte_at FROM transfer_shares t JOIN transfer_artifacts a ON a.id=t.artifact_id LEFT JOIN transfer_sessions s ON s.share_id=t.id WHERE t.owner=? AND a.source_key IN (${placeholders}) ORDER BY t.created_at DESC LIMIT 64`).all(owner, ...keys);
      for (const row of rows) this.#expire(db, now, row);
      return rows.map(shareView);
    });
  }
  audit(owner, id) {
    return this.#tx((db) => {
      if (!db.prepare("SELECT 1 FROM transfer_shares WHERE id=? AND owner=?").get(id, owner)) throw transferError("transfer-share-not-found", 404);
      return db.prepare("SELECT event,bytes,observed_at observedAt,request_id requestId FROM transfer_audit WHERE share_id=? ORDER BY seq DESC LIMIT 256").all(id);
    });
  }
  rate(ipHash, action) {
    return this.#tx((db, now) => {
      const window = Math.floor(now / 60_000);
      db.prepare("DELETE FROM transfer_rate WHERE key IN (SELECT key FROM transfer_rate WHERE window<? LIMIT 100)").run(window);
      const count = db.prepare("SELECT count(*) n FROM transfer_rate").get().n;
      const key = `${action}:${ipHash}`;
      if (count >= 2048 && !db.prepare("SELECT 1 FROM transfer_rate WHERE key=?").get(key)) return { failure: "transfer-rate-limit", status: 429 };
      const increment = (name) => {
        db.prepare("INSERT INTO transfer_rate VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN transfer_rate.window=excluded.window THEN transfer_rate.count+1 ELSE 1 END")
          .run(name, window);
        return db.prepare("SELECT count FROM transfer_rate WHERE key=?").get(name).count;
      };
      const local = increment(key), global = increment("global");
      const limit = action === "claim" ? 10 : action === "invalid" ? 20 : this.#policy.requestsPerMinute;
      return local > limit || global > 1200 ? { failure: "transfer-rate-limit", status: 429 } : { allowed: true };
    });
  }
  failArtifact(id) {
    return this.#tx((db, now) => {
      db.prepare("UPDATE transfer_artifacts SET state='failed' WHERE id=? AND state IN ('preparing','publishing','ready')").run(id);
      for (const share of db.prepare("SELECT * FROM transfer_shares WHERE artifact_id=?").all(id)) {
        if (!TERMINAL.has(share.state)) {
          db.prepare("UPDATE transfer_shares SET state='failed',generation=generation+1 WHERE id=?").run(share.id);
          this.#audit(db, now, "artifact-mismatch", { shareId: share.id, artifactId: id });
        }
      }
    });
  }
  gcCandidates() {
    return this.#tx((db, now) => {
      this.#recoverPreparations(db, now);
      for (const row of db.prepare("SELECT * FROM transfer_shares WHERE state NOT IN ('completed','ambiguous_terminal','revoked','expired','failed') LIMIT 128").all()) this.#expire(db, now, row);
      const artifacts = db.prepare("SELECT * FROM transfer_artifacts WHERE state!='deleted' AND (expires_at<? OR state IN ('deleting','failed')) ORDER BY created_at LIMIT 16").all(now - 86_400_000);
      const result = [];
      for (const row of artifacts) {
        if (row.state === "preparing") {
          const instance = db.prepare("SELECT heartbeat_at FROM transfer_instances WHERE id=?").get(row.instance_id);
          if (instance?.heartbeat_at >= now - 30_000) continue;
        }
        if (db.prepare("SELECT 1 FROM transfer_shares WHERE artifact_id=? AND state NOT IN ('completed','ambiguous_terminal','revoked','expired','failed')").get(row.id)) continue;
        if (db.prepare("SELECT 1 FROM transfer_requests r JOIN transfer_sessions s ON s.id=r.session_id JOIN transfer_shares t ON t.id=s.share_id WHERE t.artifact_id=? AND r.state IN ('active','output_candidate','terminal_candidate')").get(row.id)) continue;
        if (row.state !== "deleting") {
          db.prepare("UPDATE transfer_artifacts SET state='deleting' WHERE id=?").run(row.id);
          this.#audit(db, now, "gc-deleting", { artifactId: row.id });
        }
        result.push(row.id);
      }
      return result;
    });
  }
  gcDeleted(id) {
    return this.#tx((db, now) => {
      if (db.prepare("UPDATE transfer_artifacts SET state='deleted' WHERE id=? AND state='deleting'").run(id).changes) {
        db.prepare("DELETE FROM transfer_blocks WHERE artifact_id=?").run(id);
        this.#audit(db, now, "gc-deleted", { artifactId: id });
      }
    });
  }
  async close() { await this.#queue.idle(); this.#database?.close(); this.#database = null; }
}
