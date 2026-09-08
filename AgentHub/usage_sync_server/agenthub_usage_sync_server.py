#!/usr/bin/env python3
"""Minimal Agent Hub usage-sync ingest service.

The service follows the same deployment shape as the Hysteria monitor: Python,
SQLite/WAL and a localhost HTTP server intended to sit behind nginx/mTLS.
It does not create systemd units, nginx config or VDS state by itself.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from dataclasses import dataclass, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.hazmat.primitives.serialization import load_der_public_key
except ImportError as exc:  # pragma: no cover - exercised only on incomplete VDS installs.
    raise SystemExit(
        "Python package 'cryptography' is required for Ed25519 verification"
    ) from exc


DEFAULT_DB = os.environ.get(
    "AGENTHUB_USAGE_SYNC_DB", "/var/lib/agenthub-usage-sync/usage-sync.db"
)
DEFAULT_HOST = os.environ.get("AGENTHUB_USAGE_SYNC_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("AGENTHUB_USAGE_SYNC_PORT", "9198"))
MAX_ENROLL_BODY_BYTES = 64 * 1024
MAX_USAGE_BODY_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_BODY_BYTES = 64 * 1024
MAX_CHANGES_BODY_BYTES = 64 * 1024
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
EVENT_ID_PATTERN = re.compile(r"^usage:[0-9a-f]{64}$")
OBSERVATION_ID_PATTERN = re.compile(r"^(?:auth|limit):[0-9a-f]{64}$")
PSEUDONYM_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
RUNTIME_HOME_ID_PATTERN = re.compile(r"^[0-9a-f]{64}$")
ACCOUNT_ATTRIBUTIONS = {"exact", "inferred"}
USAGE_FACT_SCHEMA_VERSION = 2
LEGACY_USAGE_EVENT_SCHEMA_VERSION = 1
USAGE_FACT_TYPES = {"turn", "auth_observation", "limit_observation"}
FORBIDDEN_TURN_ACCOUNT_FIELDS = {
    "accountKey",
    "accountLabel",
    "accountType",
    "accountPlan",
    "accountAttribution",
    "accountRecovery",
}
CREDENTIAL_CLASS_ACCOUNT_KEYS = {"api-key", "amazon-bedrock"}


def now_ms() -> int:
    return int(time.time() * 1000)


def utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def text(value: Any, limit: int = 512) -> str:
    return str(value or "").strip()[:limit]


def positive_number(value: Any) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return number if number > 0 else 0.0


def integer(value: Any) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def parse_time_ms(value: str) -> int:
    candidate = text(value, 80)
    if not candidate:
        return 0
    try:
        normalized = candidate.replace("Z", "+00:00")
        from datetime import datetime

        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except ValueError:
        return 0


def timestamp(value: Any) -> str:
    candidate = text(value, 80)
    return candidate if parse_time_ms(candidate) else ""


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def sample_text_sort_key(value: Any) -> bytes:
    return text(value).encode("utf-8")


def sample_number_sort_key(value: Any) -> tuple[int, float]:
    number = finite_number(value)
    return (0, 0.0) if number is None else (1, number)


def limit_sample_identity(sample: dict[str, Any]) -> tuple[Any, ...]:
    return (
        sample["observedAt"],
        sample["limitId"],
        sample["window"],
        sample["windowMinutes"],
        sample["usedPercent"],
        sample["resetsAt"],
        sample["planType"],
    )


def limit_sample_sort_key(sample: dict[str, Any]) -> tuple[Any, ...]:
    return (
        sample_text_sort_key(sample["observedAt"]),
        sample_text_sort_key(sample["limitId"]),
        sample_text_sort_key(sample["window"]),
        sample_number_sort_key(sample["windowMinutes"]),
        sample_number_sort_key(sample["usedPercent"]),
        sample_text_sort_key(sample["resetsAt"]),
        sample_text_sort_key(sample["planType"]),
    )


def normalize_limit_samples(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    by_key: dict[tuple[Any, ...], dict[str, Any]] = {}
    for item in value:
        if not isinstance(item, dict):
            continue
        observed_at = timestamp(item.get("observedAt"))
        limit_id = text(item.get("limitId"), 120)
        window = text(item.get("window"), 80)
        used_percent = finite_number(item.get("usedPercent"))
        if not observed_at or not limit_id or not window or used_percent is None:
            continue
        sample = {
            "observedAt": observed_at,
            "limitId": limit_id,
            "window": window,
            "windowMinutes": finite_number(item.get("windowMinutes")),
            "usedPercent": used_percent,
            "resetsAt": timestamp(item.get("resetsAt")),
            "planType": text(item.get("planType"), 80),
        }
        key = limit_sample_identity(sample)
        if key not in by_key:
            by_key[key] = sample
    return sorted(by_key.values(), key=limit_sample_sort_key)


def b64url_decode(value: str) -> bytes:
    candidate = text(value, 8192)
    padding = "=" * (-len(candidate) % 4)
    return base64.urlsafe_b64decode((candidate + padding).encode("ascii"))


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def canonical_json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def code_hash(code: str) -> str:
    return hashlib.sha256(text(code, 256).encode("utf-8")).hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def auth_observation_id(
    *,
    device_id: str,
    installation_instance_id: str,
    provider: str,
    runtime_home_id: str,
    account_key: str,
    observed_at: str,
) -> str:
    payload = [device_id, installation_instance_id, provider, runtime_home_id, account_key, observed_at]
    digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"auth:{digest}"


def limit_observation_id(
    *,
    device_id: str,
    provider: str,
    account_key: str,
    limit_id: str,
    window: str,
    observed_at: str,
) -> str:
    payload = [device_id, provider, account_key, limit_id, window, observed_at]
    digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"limit:{digest}"


def db_connect(path: str) -> sqlite3.Connection:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init_db(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT PRIMARY KEY,
            label TEXT NOT NULL DEFAULT '',
            platform TEXT NOT NULL DEFAULT '',
            public_key TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revoked_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS enrollment_codes (
            code_hash TEXT PRIMARY KEY,
            created_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL,
            used_at_ms INTEGER NOT NULL DEFAULT 0,
            used_by_device_id TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS usage_events (
            event_id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES devices(device_id),
            provider TEXT NOT NULL,
            thread_key TEXT NOT NULL,
            task_key TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            completed_ms INTEGER NOT NULL,
            started_at TEXT NOT NULL DEFAULT '',
            schema_version INTEGER NOT NULL DEFAULT 1,
            runtime_home_id TEXT NOT NULL DEFAULT '',
            limit_samples_json TEXT NOT NULL DEFAULT '[]',
            account_key TEXT NOT NULL DEFAULT '',
            account_label TEXT NOT NULL DEFAULT '',
            account_type TEXT NOT NULL DEFAULT '',
            account_plan TEXT NOT NULL DEFAULT '',
            account_attribution TEXT NOT NULL DEFAULT 'inferred',
            estimated_credits REAL NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            cached_input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            usage_reported INTEGER NOT NULL DEFAULT 1,
            model TEXT NOT NULL DEFAULT '',
            service_tier TEXT NOT NULL DEFAULT '',
            device_label TEXT NOT NULL DEFAULT '',
            observed_at TEXT NOT NULL DEFAULT '',
            received_at_ms INTEGER NOT NULL,
            server_revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS usage_events_device_completed
            ON usage_events(device_id, completed_ms);
        CREATE INDEX IF NOT EXISTS usage_events_account_completed
            ON usage_events(account_key, completed_ms);
        CREATE TABLE IF NOT EXISTS ingest_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            received_at_ms INTEGER NOT NULL,
            accepted_events INTEGER NOT NULL,
            rejected_events INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_auth_observations (
            observation_id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES devices(device_id),
            installation_instance_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            runtime_home_id TEXT NOT NULL,
            account_key TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            fact_json TEXT NOT NULL,
            received_at_ms INTEGER NOT NULL,
            server_revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS usage_auth_observations_server_revision
            ON usage_auth_observations(server_revision);
        CREATE TABLE IF NOT EXISTS usage_limit_observations (
            observation_id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES devices(device_id),
            provider TEXT NOT NULL,
            account_key TEXT NOT NULL,
            limit_id TEXT NOT NULL,
            window TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            fact_json TEXT NOT NULL,
            received_at_ms INTEGER NOT NULL,
            server_revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS usage_limit_observations_server_revision
            ON usage_limit_observations(server_revision);
        """
    )
    columns = {
        row["name"]
        for row in db.execute("PRAGMA table_info(usage_events)").fetchall()
    }
    for name, definition in (
        ("account_label", "TEXT NOT NULL DEFAULT ''"),
        ("account_type", "TEXT NOT NULL DEFAULT ''"),
        ("account_plan", "TEXT NOT NULL DEFAULT ''"),
        ("device_label", "TEXT NOT NULL DEFAULT ''"),
        ("server_revision", "INTEGER NOT NULL DEFAULT 0"),
        ("schema_version", "INTEGER NOT NULL DEFAULT 1"),
        ("runtime_home_id", "TEXT NOT NULL DEFAULT ''"),
        ("limit_samples_json", "TEXT NOT NULL DEFAULT '[]'"),
    ):
        if name not in columns:
            db.execute(f"ALTER TABLE usage_events ADD COLUMN {name} {definition}")
    db.execute(
        "CREATE INDEX IF NOT EXISTS usage_events_server_revision ON usage_events(server_revision)"
    )
    ensure_dataset_generation(db)
    backfill_server_revisions(db)
    db.commit()


def ensure_dataset_generation(db: sqlite3.Connection) -> str:
    row = db.execute("SELECT value FROM usage_sync_meta WHERE key='dataset_generation'").fetchone()
    value = text(row["value"], 120) if row else ""
    if value:
        return value
    value = str(uuid.uuid4())
    db.execute(
        """
        INSERT INTO usage_sync_meta(key, value) VALUES('dataset_generation', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        (value,),
    )
    return value


def current_server_revision(db: sqlite3.Connection) -> int:
    row = db.execute("SELECT value FROM usage_sync_meta WHERE key='server_revision'").fetchone()
    meta_revision = integer(row["value"]) if row else 0
    revisions = [meta_revision]
    for table in ("usage_events", "usage_auth_observations", "usage_limit_observations"):
        row = db.execute(f"SELECT COALESCE(MAX(server_revision), 0) AS revision FROM {table}").fetchone()
        revisions.append(integer(row["revision"]) if row else 0)
    return max(revisions)


def current_dataset_generation(db: sqlite3.Connection) -> str:
    return ensure_dataset_generation(db)


def set_server_revision(db: sqlite3.Connection, revision: int) -> None:
    db.execute(
        """
        INSERT INTO usage_sync_meta(key, value) VALUES('server_revision', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        (str(max(0, int(revision))),),
    )


def next_server_revision(db: sqlite3.Connection) -> int:
    row = db.execute("SELECT value FROM usage_sync_meta WHERE key='server_revision'").fetchone()
    revision = (integer(row["value"]) if row else current_server_revision(db)) + 1
    set_server_revision(db, revision)
    return revision


def backfill_server_revisions(db: sqlite3.Connection) -> None:
    revision = current_server_revision(db)
    rows = db.execute(
        """
        SELECT event_id
        FROM usage_events
        WHERE server_revision=0
        ORDER BY received_at_ms, completed_ms, device_id, event_id
        """
    ).fetchall()
    for row in rows:
        revision += 1
        db.execute(
            "UPDATE usage_events SET server_revision=? WHERE event_id=?",
            (revision, row["event_id"]),
        )
    for table in ("usage_auth_observations", "usage_limit_observations"):
        rows = db.execute(
            f"""
            SELECT observation_id
            FROM {table}
            WHERE server_revision=0
            ORDER BY received_at_ms, observed_at, device_id, observation_id
            """
        ).fetchall()
        for row in rows:
            revision += 1
            db.execute(
                f"UPDATE {table} SET server_revision=? WHERE observation_id=?",
                (revision, row["observation_id"]),
            )
    set_server_revision(db, revision)


def public_key_from_b64(public_key: str) -> Ed25519PublicKey:
    key = load_der_public_key(b64url_decode(public_key))
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("public key is not Ed25519")
    return key


def verify_signature(public_key: str, signature: str, message: bytes) -> bool:
    try:
        public_key_from_b64(public_key).verify(b64url_decode(signature), message)
        return True
    except (ValueError, InvalidSignature):
        return False


def normalize_identity(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("identity must be an object")
    device_id = text(value.get("deviceId"), 80).lower()
    if not UUID_PATTERN.fullmatch(device_id):
        raise ValueError("invalid deviceId")
    public_key = text(value.get("publicKey"), 8192)
    public_key_from_b64(public_key)
    return {
        "deviceId": device_id,
        "label": text(value.get("label"), 80),
        "platform": text(value.get("platform"), 40),
        "publicKey": public_key,
        "createdAt": text(value.get("createdAt"), 80) or utc_now_iso(),
    }


def enrollment_message(code: str, identity: dict[str, str]) -> bytes:
    return canonical_json_bytes({"code": text(code, 256), "identity": identity})


def create_enrollment_code(
    db: sqlite3.Connection, ttl_seconds: int = 10800, code: str | None = None
) -> dict[str, Any]:
    init_db(db)
    code = code or secrets.token_urlsafe(18)
    created = now_ms()
    expires = created + max(60, int(ttl_seconds)) * 1000
    db.execute(
        """
        INSERT INTO enrollment_codes(code_hash, created_at_ms, expires_at_ms)
        VALUES(?,?,?)
        """,
        (code_hash(code), created, expires),
    )
    db.commit()
    return {"code": code, "expiresAtMs": expires}


def enroll_device(db: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    init_db(db)
    code = text(payload.get("code"), 256)
    identity = normalize_identity(payload.get("identity"))
    signature = text(payload.get("signature"), 8192)
    if not code or not signature:
        raise ValueError("code and signature are required")
    if not verify_signature(identity["publicKey"], signature, enrollment_message(code, identity)):
        raise PermissionError("invalid enrollment signature")
    row = db.execute(
        "SELECT * FROM enrollment_codes WHERE code_hash=?",
        (code_hash(code),),
    ).fetchone()
    current_ms = now_ms()
    if not row or int(row["used_at_ms"]) or int(row["expires_at_ms"]) < current_ms:
        raise PermissionError("enrollment code is invalid")
    existing = db.execute(
        "SELECT public_key FROM devices WHERE device_id=?",
        (identity["deviceId"],),
    ).fetchone()
    if existing and existing["public_key"] != identity["publicKey"]:
        raise PermissionError("device id is already enrolled with another key")
    timestamp = utc_now_iso()
    db.execute(
        """
        INSERT INTO devices(device_id, label, platform, public_key, created_at, updated_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET
            label=excluded.label,
            platform=excluded.platform,
            public_key=excluded.public_key,
            updated_at=excluded.updated_at,
            revoked_at=''
        """,
        (
            identity["deviceId"],
            identity["label"],
            identity["platform"],
            identity["publicKey"],
            identity["createdAt"] or timestamp,
            timestamp,
        ),
    )
    db.execute(
        """
        UPDATE enrollment_codes SET used_at_ms=?, used_by_device_id=?
        WHERE code_hash=?
        """,
        (current_ms, identity["deviceId"], code_hash(code)),
    )
    db.commit()
    return {"ok": True, "deviceId": identity["deviceId"]}


def verified_device_payload(
    db: sqlite3.Connection, *, device_id: str, signature: str, body: bytes, kind: str
) -> tuple[str, dict[str, Any]]:
    init_db(db)
    device_id = text(device_id, 80).lower()
    device = db.execute(
        "SELECT * FROM devices WHERE device_id=? AND revoked_at=''",
        (device_id,),
    ).fetchone()
    if not device:
        raise PermissionError("unknown or revoked device")
    if not verify_signature(device["public_key"], signature, body):
        raise PermissionError(f"invalid {kind} signature")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid JSON body") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{kind} request must be an object")
    if text(payload.get("deviceId"), 80).lower() not in ("", device_id):
        raise PermissionError(f"{kind} request device does not match signer")
    return device_id, payload


def create_enrollment_code_for_device(
    db: sqlite3.Connection, *, device_id: str, signature: str, body: bytes
) -> dict[str, Any]:
    device_id, payload = verified_device_payload(
        db,
        device_id=device_id,
        signature=signature,
        body=body,
        kind="enrollment-code",
    )
    result = create_enrollment_code(db, ttl_seconds=integer(payload.get("ttlSeconds")) or 10800)
    return {"ok": True, "deviceId": device_id, **result}


@dataclass(frozen=True)
class UsageEvent:
    event_id: str
    device_id: str
    provider: str
    thread_key: str
    task_key: str
    completed_at: str
    completed_ms: int
    started_at: str
    schema_version: int
    runtime_home_id: str
    limit_samples_json: str
    account_key: str
    account_label: str
    account_type: str
    account_plan: str
    account_attribution: str
    estimated_credits: float
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    reasoning_output_tokens: int
    total_tokens: int
    usage_reported: int
    model: str
    service_tier: str
    device_label: str
    observed_at: str
    received_at_ms: int
    server_revision: int = 0


def normalize_event(value: Any, received_at_ms: int) -> UsageEvent:
    if not isinstance(value, dict):
        raise ValueError("event must be an object")
    schema_version = integer(value.get("schemaVersion") or value.get("version")) or LEGACY_USAGE_EVENT_SCHEMA_VERSION
    if schema_version not in (LEGACY_USAGE_EVENT_SCHEMA_VERSION, USAGE_FACT_SCHEMA_VERSION):
        raise ValueError("unsupported usage schemaVersion")
    if schema_version == USAGE_FACT_SCHEMA_VERSION:
        if text(value.get("type"), 40) != "turn":
            raise ValueError("invalid usage fact type")
        if any(text(value.get(field), 512) for field in FORBIDDEN_TURN_ACCOUNT_FIELDS):
            raise ValueError("turn fact must not contain account fields")
    event_id = text(value.get("eventId"), 80)
    device_id = text(value.get("deviceId"), 80).lower()
    thread_key = text(value.get("threadKey"), 160)
    task_key = text(value.get("taskKey"), 160) or thread_key
    completed_at = text(value.get("completedAt"), 80)
    completed_ms = parse_time_ms(completed_at)
    started_at = text(value.get("startedAt"), 80)
    runtime_home_id = text(value.get("runtimeHomeId"), 80)
    if not EVENT_ID_PATTERN.fullmatch(event_id):
        raise ValueError("invalid eventId")
    if not UUID_PATTERN.fullmatch(device_id):
        raise ValueError("invalid event deviceId")
    if not PSEUDONYM_PATTERN.fullmatch(thread_key) or not PSEUDONYM_PATTERN.fullmatch(task_key):
        raise ValueError("invalid thread/task key")
    if not completed_ms:
        raise ValueError("invalid completedAt")
    if schema_version == USAGE_FACT_SCHEMA_VERSION:
        if not started_at or not parse_time_ms(started_at):
            raise ValueError("invalid startedAt")
        if not RUNTIME_HOME_ID_PATTERN.fullmatch(runtime_home_id):
            raise ValueError("invalid runtimeHomeId")
    usage = value.get("usage") if isinstance(value.get("usage"), dict) else {}
    limit_samples_json_value = limit_samples_json(value.get("limitSamples"))
    account_key = ""
    attribution = "inferred"
    return UsageEvent(
        event_id=event_id,
        device_id=device_id,
        provider=text(value.get("provider"), 32).lower() or "unknown",
        thread_key=thread_key,
        task_key=task_key,
        completed_at=completed_at,
        completed_ms=completed_ms,
        started_at=started_at,
        schema_version=schema_version,
        runtime_home_id=runtime_home_id,
        limit_samples_json=limit_samples_json_value,
        account_key=account_key,
        account_label="",
        account_type="",
        account_plan="",
        account_attribution=attribution,
        estimated_credits=positive_number(value.get("estimatedCredits") or value.get("credits")),
        input_tokens=integer(usage.get("inputTokens")),
        cached_input_tokens=integer(usage.get("cachedInputTokens")),
        output_tokens=integer(usage.get("outputTokens")),
        reasoning_output_tokens=integer(usage.get("reasoningOutputTokens")),
        total_tokens=integer(usage.get("totalTokens")),
        usage_reported=0 if value.get("usageReported") is False else 1,
        model=text(value.get("model"), 120).lower(),
        service_tier=text(value.get("serviceTier"), 60).lower(),
        device_label=text(value.get("deviceLabel"), 80),
        observed_at=text(value.get("observedAt"), 80),
        received_at_ms=received_at_ms,
    )


def event_rank(row_or_event: sqlite3.Row | UsageEvent) -> tuple[int, int, int, int, int, int, int]:
    def value(name: str) -> Any:
        if isinstance(row_or_event, sqlite3.Row):
            return row_or_event[name]
        return getattr(row_or_event, name)

    schema_version = value("schema_version")
    runtime_home_id = value("runtime_home_id")
    started_at = value("started_at")
    limit_samples = normalize_limit_samples(json.loads(value("limit_samples_json") or "[]"))
    credits = value("estimated_credits")
    return (
        1 if int(schema_version or 0) == USAGE_FACT_SCHEMA_VERSION else 0,
        1 if runtime_home_id else 0,
        1 if started_at else 0,
        len(limit_samples),
        1 if int(value("usage_reported") or 0) else 0,
        int(value("total_tokens") or 0),
        1 if float(credits or 0) > 0 else 0,
    )


def should_replace(existing: sqlite3.Row | None, incoming: UsageEvent) -> bool:
    if existing is None:
        return True
    return event_rank(incoming) > event_rank(existing)


def limit_samples_json(samples: Any) -> str:
    return json.dumps(
        normalize_limit_samples(samples),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def merged_event_limit_samples_json(existing: sqlite3.Row | None, incoming: UsageEvent) -> str:
    incoming_samples = json.loads(incoming.limit_samples_json or "[]")
    if existing is None:
        return limit_samples_json(incoming_samples)
    existing_samples = json.loads(existing["limit_samples_json"] or "[]")
    return limit_samples_json(existing_samples + incoming_samples)


def normalize_auth_observation(value: Any, received_at_ms: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("auth observation must be an object")
    if integer(value.get("schemaVersion") or value.get("version")) != USAGE_FACT_SCHEMA_VERSION:
        raise ValueError("invalid auth observation schemaVersion")
    if text(value.get("type"), 40) != "auth_observation":
        raise ValueError("invalid auth observation type")
    device_id = text(value.get("deviceId"), 80).lower()
    installation_instance_id = text(value.get("installationInstanceId"), 80).lower()
    provider = text(value.get("provider"), 32).lower() or "unknown"
    runtime_home_id = text(value.get("runtimeHomeId"), 80)
    account_key = text(value.get("accountKey"), 256)
    observed_at = timestamp(value.get("observedAt"))
    if not UUID_PATTERN.fullmatch(device_id):
        raise ValueError("invalid auth deviceId")
    if not UUID_PATTERN.fullmatch(installation_instance_id):
        raise ValueError("invalid installationInstanceId")
    if not RUNTIME_HOME_ID_PATTERN.fullmatch(runtime_home_id):
        raise ValueError("invalid auth runtimeHomeId")
    if not account_key or account_key in CREDENTIAL_CLASS_ACCOUNT_KEYS:
        raise ValueError("invalid auth accountKey")
    if not observed_at:
        raise ValueError("invalid auth observedAt")
    observation_id = auth_observation_id(
        device_id=device_id,
        installation_instance_id=installation_instance_id,
        provider=provider,
        runtime_home_id=runtime_home_id,
        account_key=account_key,
        observed_at=observed_at,
    )
    if not OBSERVATION_ID_PATTERN.fullmatch(observation_id):
        raise ValueError("invalid auth observationId")
    fact = {
        "schemaVersion": USAGE_FACT_SCHEMA_VERSION,
        "type": "auth_observation",
        "observationId": observation_id,
        "deviceId": device_id,
        "installationInstanceId": installation_instance_id,
        "provider": provider,
        "runtimeHomeId": runtime_home_id,
        "accountKey": account_key,
        "accountLabel": text(value.get("accountLabel"), 256),
        "accountType": text(value.get("accountType"), 80),
        "accountPlan": text(value.get("accountPlan"), 80),
        "observedAt": observed_at,
        "evidenceSource": text(value.get("evidenceSource"), 80),
        "authFingerprint": text(value.get("authFingerprint"), 256),
    }
    return {"fact": fact, "received_at_ms": received_at_ms}


def normalize_limit_observation(value: Any, received_at_ms: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("limit observation must be an object")
    if integer(value.get("schemaVersion") or value.get("version")) != USAGE_FACT_SCHEMA_VERSION:
        raise ValueError("invalid limit observation schemaVersion")
    if text(value.get("type"), 40) != "limit_observation":
        raise ValueError("invalid limit observation type")
    device_id = text(value.get("deviceId"), 80).lower()
    provider = text(value.get("provider"), 32).lower() or "unknown"
    account_key = text(value.get("accountKey"), 256)
    limit_id = text(value.get("limitId"), 120)
    window = text(value.get("window"), 80)
    observed_at = timestamp(value.get("observedAt"))
    used_percent = finite_number(value.get("usedPercent"))
    if not UUID_PATTERN.fullmatch(device_id):
        raise ValueError("invalid limit deviceId")
    if not account_key or account_key in CREDENTIAL_CLASS_ACCOUNT_KEYS:
        raise ValueError("invalid limit accountKey")
    if not limit_id or not window or not observed_at or used_percent is None:
        raise ValueError("invalid limit observation")
    observation_id = limit_observation_id(
        device_id=device_id,
        provider=provider,
        account_key=account_key,
        limit_id=limit_id,
        window=window,
        observed_at=observed_at,
    )
    fact = {
        "schemaVersion": USAGE_FACT_SCHEMA_VERSION,
        "type": "limit_observation",
        "observationId": observation_id,
        "deviceId": device_id,
        "provider": provider,
        "accountKey": account_key,
        "limitId": limit_id,
        "window": window,
        "windowMinutes": finite_number(value.get("windowMinutes")),
        "usedPercent": used_percent,
        "resetsAt": timestamp(value.get("resetsAt")),
        "observedAt": observed_at,
        "reachedType": text(value.get("reachedType"), 80),
    }
    return {"fact": fact, "received_at_ms": received_at_ms}


def normalize_fact(value: Any, received_at_ms: int) -> tuple[str, Any]:
    schema_version = integer(value.get("schemaVersion") or value.get("version")) if isinstance(value, dict) else 0
    if schema_version > USAGE_FACT_SCHEMA_VERSION:
        raise ValueError("unsupported usage schemaVersion")
    if schema_version == USAGE_FACT_SCHEMA_VERSION:
        kind = text(value.get("type"), 40)
        if kind not in USAGE_FACT_TYPES:
            raise ValueError("unknown usage fact type")
        if kind == "auth_observation":
            return kind, normalize_auth_observation(value, received_at_ms)
        if kind == "limit_observation":
            return kind, normalize_limit_observation(value, received_at_ms)
    return "turn", normalize_event(value, received_at_ms)


EVENT_COLUMNS = (
    "event_id, device_id, provider, thread_key, task_key, completed_at, completed_ms, "
    "started_at, schema_version, runtime_home_id, limit_samples_json, "
    "account_key, account_label, account_type, account_plan, "
    "account_attribution, estimated_credits, input_tokens, "
    "cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens, "
    "usage_reported, model, service_tier, device_label, observed_at, received_at_ms, "
    "server_revision"
)


def update_device_label(db: sqlite3.Connection, device_id: str, label: str) -> int:
    candidate = text(label, 80)
    if not candidate:
        return 0
    db.execute(
        "UPDATE devices SET label=?, updated_at=? WHERE device_id=?",
        (candidate, utc_now_iso(), device_id),
    )
    rows = db.execute(
        """
        SELECT event_id
        FROM usage_events
        WHERE device_id=? AND device_label<>?
        ORDER BY completed_ms, event_id
        """,
        (device_id, candidate),
    ).fetchall()
    for row in rows:
        db.execute(
            "UPDATE usage_events SET device_label=?, server_revision=? WHERE event_id=?",
            (candidate, next_server_revision(db), row["event_id"]),
        )
    return len(rows)


def insert_or_update_event(db: sqlite3.Connection, event: UsageEvent) -> str:
    existing = db.execute(
        "SELECT * FROM usage_events WHERE event_id=?",
        (event.event_id,),
    ).fetchone()
    merged_samples_json = merged_event_limit_samples_json(existing, event)
    if not should_replace(existing, event):
        if existing is not None and existing["limit_samples_json"] != merged_samples_json:
            db.execute(
                "UPDATE usage_events SET limit_samples_json=?, server_revision=? WHERE event_id=?",
                (merged_samples_json, next_server_revision(db), event.event_id),
            )
            return "updated"
        return "unchanged"
    event = replace(event, limit_samples_json=merged_samples_json)
    values = tuple(
        event.__dict__[name] if name != "server_revision" else next_server_revision(db)
        for name in EVENT_COLUMNS.replace(" ", "").split(",")
    )
    db.execute(
        f"""
        INSERT INTO usage_events({EVENT_COLUMNS})
        VALUES({",".join("?" for _ in values)})
        ON CONFLICT(event_id) DO UPDATE SET
            device_id=excluded.device_id,
            provider=excluded.provider,
            thread_key=excluded.thread_key,
            task_key=excluded.task_key,
            completed_at=excluded.completed_at,
            completed_ms=excluded.completed_ms,
            started_at=excluded.started_at,
            schema_version=excluded.schema_version,
            runtime_home_id=excluded.runtime_home_id,
            limit_samples_json=excluded.limit_samples_json,
            account_key=excluded.account_key,
            account_label=excluded.account_label,
            account_type=excluded.account_type,
            account_plan=excluded.account_plan,
            account_attribution=excluded.account_attribution,
            estimated_credits=excluded.estimated_credits,
            input_tokens=excluded.input_tokens,
            cached_input_tokens=excluded.cached_input_tokens,
            output_tokens=excluded.output_tokens,
            reasoning_output_tokens=excluded.reasoning_output_tokens,
            total_tokens=excluded.total_tokens,
            usage_reported=excluded.usage_reported,
            model=excluded.model,
            service_tier=excluded.service_tier,
            device_label=excluded.device_label,
            observed_at=excluded.observed_at,
            received_at_ms=excluded.received_at_ms,
            server_revision=excluded.server_revision
        """,
        values,
    )
    return "added" if existing is None else "updated"


def insert_or_update_auth_observation(db: sqlite3.Connection, record: dict[str, Any]) -> str:
    fact = record["fact"]
    existing = db.execute(
        "SELECT fact_json FROM usage_auth_observations WHERE observation_id=?",
        (fact["observationId"],),
    ).fetchone()
    fact_json = json.dumps(fact, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if existing and existing["fact_json"] == fact_json:
        return "unchanged"
    db.execute(
        """
        INSERT INTO usage_auth_observations(
            observation_id, device_id, installation_instance_id, provider,
            runtime_home_id, account_key, observed_at, fact_json,
            received_at_ms, server_revision
        )
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(observation_id) DO UPDATE SET
            device_id=excluded.device_id,
            installation_instance_id=excluded.installation_instance_id,
            provider=excluded.provider,
            runtime_home_id=excluded.runtime_home_id,
            account_key=excluded.account_key,
            observed_at=excluded.observed_at,
            fact_json=excluded.fact_json,
            received_at_ms=excluded.received_at_ms,
            server_revision=excluded.server_revision
        """,
        (
            fact["observationId"],
            fact["deviceId"],
            fact["installationInstanceId"],
            fact["provider"],
            fact["runtimeHomeId"],
            fact["accountKey"],
            fact["observedAt"],
            fact_json,
            record["received_at_ms"],
            next_server_revision(db),
        ),
    )
    return "added" if existing is None else "updated"


def insert_or_update_limit_observation(db: sqlite3.Connection, record: dict[str, Any]) -> str:
    fact = record["fact"]
    existing = db.execute(
        "SELECT fact_json FROM usage_limit_observations WHERE observation_id=?",
        (fact["observationId"],),
    ).fetchone()
    fact_json = json.dumps(fact, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if existing and existing["fact_json"] == fact_json:
        return "unchanged"
    db.execute(
        """
        INSERT INTO usage_limit_observations(
            observation_id, device_id, provider, account_key,
            limit_id, window, observed_at, fact_json,
            received_at_ms, server_revision
        )
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(observation_id) DO UPDATE SET
            device_id=excluded.device_id,
            provider=excluded.provider,
            account_key=excluded.account_key,
            limit_id=excluded.limit_id,
            window=excluded.window,
            observed_at=excluded.observed_at,
            fact_json=excluded.fact_json,
            received_at_ms=excluded.received_at_ms,
            server_revision=excluded.server_revision
        """,
        (
            fact["observationId"],
            fact["deviceId"],
            fact["provider"],
            fact["accountKey"],
            fact["limitId"],
            fact["window"],
            fact["observedAt"],
            fact_json,
            record["received_at_ms"],
            next_server_revision(db),
        ),
    )
    return "added" if existing is None else "updated"


def event_row_to_api(row: sqlite3.Row) -> dict[str, Any]:
    schema_version = integer(row["schema_version"]) or LEGACY_USAGE_EVENT_SCHEMA_VERSION
    event = {
        "version": 1,
        "schemaVersion": schema_version,
        "eventId": row["event_id"],
        "deviceId": row["device_id"],
        "source": "sync",
        "provider": row["provider"],
        "threadKey": row["thread_key"],
        "taskKey": row["task_key"],
        "completedAt": row["completed_at"],
        "startedAt": row["started_at"],
        "estimatedCredits": row["estimated_credits"],
        "usage": {
            "inputTokens": row["input_tokens"],
            "cachedInputTokens": row["cached_input_tokens"],
            "outputTokens": row["output_tokens"],
            "reasoningOutputTokens": row["reasoning_output_tokens"],
            "totalTokens": row["total_tokens"],
        },
        "usageReported": row["usage_reported"] != 0,
        "model": row["model"],
        "serviceTier": row["service_tier"],
        "deviceLabel": row["device_label"] or row["device_device_label"],
        "observedAt": row["observed_at"],
    }
    if schema_version == USAGE_FACT_SCHEMA_VERSION:
        event["type"] = "turn"
        event["runtimeHomeId"] = row["runtime_home_id"]
        event["limitSamples"] = normalize_limit_samples(json.loads(row["limit_samples_json"] or "[]"))
    return event


def observation_row_to_api(row: sqlite3.Row) -> dict[str, Any]:
    return json.loads(row["fact_json"])


def fact_identity(fact: dict[str, Any]) -> str:
    kind = text(fact.get("type"), 40) or "turn"
    if kind in {"auth_observation", "limit_observation"}:
        return text(fact.get("observationId"), 120)
    return text(fact.get("eventId"), 120)


def fact_summary_payload(fact: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in fact.items()
        if key not in {"deviceLabel", "legacy", "source", "version"}
    }


def usage_fact_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    by_type = {"turn": 0, "auth_observation": 0, "limit_observation": 0}
    lines = []
    for fact in events:
        kind = text(fact.get("type"), 40) or "turn"
        identity = fact_identity(fact)
        if not identity:
            continue
        by_type[kind] = by_type.get(kind, 0) + 1
        lines.append(canonical_json_text([kind, identity, fact_summary_payload(fact)]))
    lines.sort(key=lambda value: value.encode("utf-8"))
    return {
        "version": 1,
        "count": len(lines),
        "byType": by_type,
        "digest": "sha256:" + sha256_text("\n".join(lines)),
    }


def snapshot_events(db: sqlite3.Connection, where_sql: str = "", params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    usage_rows = db.execute(
        f"""
        SELECT usage_events.*, devices.label AS device_device_label, usage_events.server_revision AS fact_revision
        FROM usage_events
        LEFT JOIN devices ON devices.device_id = usage_events.device_id
        {where_sql}
        """
        + (" AND" if where_sql.strip().upper().startswith("WHERE") else " WHERE")
        + " 1=1",
        params,
    ).fetchall()
    auth_rows = db.execute(
        f"""
        SELECT *, server_revision AS fact_revision
        FROM usage_auth_observations
        {where_sql}
        """,
        params,
    ).fetchall()
    limit_rows = db.execute(
        f"""
        SELECT *, server_revision AS fact_revision
        FROM usage_limit_observations
        {where_sql}
        """,
        params,
    ).fetchall()
    records = [
        *[(row["fact_revision"], row["device_id"], row["event_id"], event_row_to_api(row)) for row in usage_rows],
        *[(row["fact_revision"], row["device_id"], row["observation_id"], observation_row_to_api(row)) for row in auth_rows],
        *[(row["fact_revision"], row["device_id"], row["observation_id"], observation_row_to_api(row)) for row in limit_rows],
    ]
    records.sort(key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in records]


def snapshot_envelope(
    db: sqlite3.Connection,
    *,
    device_id: str = "",
    since_revision: int | None = None,
    events: list[dict[str, Any]] | None = None,
    summary_only: bool = False,
) -> dict[str, Any]:
    current_revision = current_server_revision(db)
    envelope = {
        "version": 1,
        "usageFactSchemaVersion": USAGE_FACT_SCHEMA_VERSION,
        "datasetGeneration": current_dataset_generation(db),
        "exportedAt": utc_now_iso(),
        "serverRevision": current_revision,
    }
    if device_id:
        envelope["deviceId"] = device_id
    if since_revision is not None:
        envelope["sinceRevision"] = since_revision
    if summary_only:
        all_events = snapshot_events(db)
        envelope["factSummary"] = usage_fact_summary(all_events)
        envelope["events"] = []
    else:
        response_events = snapshot_events(db) if events is None else events
        if events is None:
            envelope["factSummary"] = usage_fact_summary(response_events)
        envelope["events"] = response_events
    return envelope


def ingest_snapshot(
    db: sqlite3.Connection, *, device_id: str, signature: str, body: bytes
) -> dict[str, Any]:
    device_id, payload = verified_device_payload(
        db,
        device_id=device_id,
        signature=signature,
        body=body,
        kind="usage",
    )
    events = payload.get("events")
    if not isinstance(events, list):
        raise ValueError("snapshot events must be an array")
    received = now_ms()
    added = updated = unchanged = rejected = 0
    db.execute("BEGIN IMMEDIATE")
    try:
        label_updates = update_device_label(db, device_id, payload.get("deviceLabel"))
        for item in events:
            try:
                kind, fact = normalize_fact(item, received)
                fact_device_id = fact.device_id if kind == "turn" else fact["fact"]["deviceId"]
                if fact_device_id != device_id:
                    rejected += 1
                    continue
                if kind == "auth_observation":
                    result = insert_or_update_auth_observation(db, fact)
                elif kind == "limit_observation":
                    result = insert_or_update_limit_observation(db, fact)
                else:
                    result = insert_or_update_event(db, fact)
                added += 1 if result == "added" else 0
                updated += 1 if result == "updated" else 0
                unchanged += 1 if result == "unchanged" else 0
            except ValueError:
                rejected += 1
        db.execute(
            """
            INSERT INTO ingest_audit(device_id, received_at_ms, accepted_events, rejected_events)
            VALUES(?,?,?,?)
            """,
            (device_id, received, added + updated + unchanged, rejected),
        )
        revision = current_server_revision(db)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {
        "ok": True,
        "deviceId": device_id,
        "usageFactSchemaVersion": USAGE_FACT_SCHEMA_VERSION,
        "datasetGeneration": current_dataset_generation(db),
        "serverRevision": revision,
        "added": added,
        "updated": updated + label_updates,
        "unchanged": unchanged,
        "rejected": rejected,
    }


def export_snapshot(
    db: sqlite3.Connection, *, device_id: str, signature: str, body: bytes
) -> dict[str, Any]:
    device_id, payload = verified_device_payload(
        db,
        device_id=device_id,
        signature=signature,
        body=body,
        kind="snapshot",
    )
    return snapshot_envelope(db, device_id=device_id, summary_only=bool(payload.get("summaryOnly")))


def export_changes(
    db: sqlite3.Connection, *, device_id: str, signature: str, body: bytes
) -> dict[str, Any]:
    device_id, payload = verified_device_payload(
        db,
        device_id=device_id,
        signature=signature,
        body=body,
        kind="changes",
    )
    since_revision = max(0, integer(payload.get("sinceRevision")))
    summary_only = bool(payload.get("summaryOnly"))
    return snapshot_envelope(
        db,
        device_id=device_id,
        since_revision=since_revision,
        events=None if summary_only else snapshot_events(db, "WHERE server_revision > ?", (since_revision,)),
        summary_only=summary_only,
    )


class UsageSyncHandler(BaseHTTPRequestHandler):
    db_path = DEFAULT_DB

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > limit:
            raise ValueError("invalid content length")
        return self.rfile.read(length)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True})
            return
        self.send_json(404, {"ok": False, "error": "not-found"})

    def do_POST(self) -> None:
        try:
            with db_connect(self.db_path) as db:
                if self.path == "/api/enroll":
                    payload = json.loads(self.read_body(MAX_ENROLL_BODY_BYTES).decode("utf-8"))
                    self.send_json(200, enroll_device(db, payload))
                    return
                if self.path == "/api/usage":
                    body = self.read_body(MAX_USAGE_BODY_BYTES)
                    result = ingest_snapshot(
                        db,
                        device_id=self.headers.get("X-AgentHub-Device-Id", ""),
                        signature=self.headers.get("X-AgentHub-Signature", ""),
                        body=body,
                    )
                    self.send_json(200, result)
                    return
                if self.path == "/api/enrollment-code":
                    body = self.read_body(MAX_ENROLL_BODY_BYTES)
                    self.send_json(
                        200,
                        create_enrollment_code_for_device(
                            db,
                            device_id=self.headers.get("X-AgentHub-Device-Id", ""),
                            signature=self.headers.get("X-AgentHub-Signature", ""),
                            body=body,
                        ),
                    )
                    return
                if self.path == "/api/snapshot":
                    body = self.read_body(MAX_SNAPSHOT_BODY_BYTES)
                    self.send_json(
                        200,
                        export_snapshot(
                            db,
                            device_id=self.headers.get("X-AgentHub-Device-Id", ""),
                            signature=self.headers.get("X-AgentHub-Signature", ""),
                            body=body,
                        ),
                    )
                    return
                if self.path == "/api/changes":
                    body = self.read_body(MAX_CHANGES_BODY_BYTES)
                    self.send_json(
                        200,
                        export_changes(
                            db,
                            device_id=self.headers.get("X-AgentHub-Device-Id", ""),
                            signature=self.headers.get("X-AgentHub-Signature", ""),
                            body=body,
                        ),
                    )
                    return
        except PermissionError as exc:
            self.send_json(403, {"ok": False, "error": str(exc)})
            return
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
            return
        self.send_json(404, {"ok": False, "error": "not-found"})

    def log_message(self, fmt: str, *args: Any) -> None:
        return


def serve(db_path: str, host: str, port: int) -> None:
    with db_connect(db_path) as db:
        init_db(db)
    handler = type("BoundUsageSyncHandler", (UsageSyncHandler,), {"db_path": db_path})
    ThreadingHTTPServer((host, port), handler).serve_forever()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init-db")
    code_parser = sub.add_parser("create-code")
    code_parser.add_argument("--ttl-seconds", type=int, default=10800)
    serve_parser = sub.add_parser("serve")
    serve_parser.add_argument("--host", default=DEFAULT_HOST)
    serve_parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)
    with db_connect(args.db) as db:
        if args.command == "init-db":
            init_db(db)
            return 0
        if args.command == "create-code":
            print(json.dumps(create_enrollment_code(db, args.ttl_seconds), separators=(",", ":")))
            return 0
    if args.command == "serve":
        serve(args.db, args.host, args.port)
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
