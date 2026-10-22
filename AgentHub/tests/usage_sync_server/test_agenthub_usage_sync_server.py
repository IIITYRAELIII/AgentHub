import base64
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "usage_sync_server"))

import agenthub_usage_sync_server as server  # noqa: E402


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


class KeyPair:
    def __init__(self):
        self.private = Ed25519PrivateKey.generate()
        self.public_key = b64url(
            self.private.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
        )

    def sign(self, message: bytes) -> str:
        return b64url(self.private.sign(message))


class UsageSyncServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp.name) / "usage-sync.db")
        self.db = sqlite3.connect(self.db_path)
        self.db.row_factory = sqlite3.Row
        server.init_db(self.db)
        self.keys = KeyPair()
        self.device_id = "4d500d12-dd09-46ba-bf49-14bce403bfd8"
        self.identity = {
            "deviceId": self.device_id,
            "label": "Семён (DESKTOP-FNNC1JA)",
            "platform": "win32",
            "publicKey": self.keys.public_key,
            "createdAt": "2026-08-20T03:28:11.201Z",
        }

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_init_db_migrates_legacy_usage_events_before_server_revision_index(self):
        legacy_db = sqlite3.connect(str(Path(self.temp.name) / "legacy-usage-sync.db"))
        legacy_db.row_factory = sqlite3.Row
        try:
            legacy_db.executescript(
                """
                CREATE TABLE devices (
                    device_id TEXT PRIMARY KEY,
                    label TEXT NOT NULL DEFAULT '',
                    platform TEXT NOT NULL DEFAULT '',
                    public_key TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    revoked_at TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE usage_events (
                    event_id TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL REFERENCES devices(device_id),
                    provider TEXT NOT NULL,
                    thread_key TEXT NOT NULL,
                    task_key TEXT NOT NULL,
                    completed_at TEXT NOT NULL,
                    completed_ms INTEGER NOT NULL,
                    account_key TEXT NOT NULL DEFAULT '',
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
                    observed_at TEXT NOT NULL DEFAULT '',
                    received_at_ms INTEGER NOT NULL
                );
                """
            )

            server.init_db(legacy_db)

            columns = {
                row["name"]
                for row in legacy_db.execute("PRAGMA table_info(usage_events)").fetchall()
            }
            self.assertIn("server_revision", columns)
            indexes = {
                row["name"]
                for row in legacy_db.execute("PRAGMA index_list(usage_events)").fetchall()
            }
            self.assertIn("usage_events_server_revision", indexes)
        finally:
            legacy_db.close()

    def enroll(self):
        code = server.create_enrollment_code(self.db, code="test-code")["code"]
        message = server.enrollment_message(code, self.identity)
        return server.enroll_device(
            self.db,
            {"code": code, "identity": self.identity, "signature": self.keys.sign(message)},
        )

    def signed_snapshot(self, events):
        body = json.dumps(
            {"version": 1, "deviceId": self.device_id, "events": events},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return body, self.keys.sign(body)

    def signed_pull_request(self):
        body = json.dumps(
            {"deviceId": self.device_id, "requestedAt": "2026-08-20T04:00:00.000Z"},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return body, self.keys.sign(body)

    def signed_summary_request(self):
        body = json.dumps(
            {
                "deviceId": self.device_id,
                "requestedAt": "2026-08-20T04:00:00.000Z",
                "summaryOnly": True,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return body, self.keys.sign(body)

    def signed_changes_request(self, since_revision=0, summary_only=False):
        payload = {
            "deviceId": self.device_id,
            "requestedAt": "2026-08-20T04:02:00.000Z",
            "sinceRevision": since_revision,
        }
        if summary_only:
            payload["summaryOnly"] = True
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return body, self.keys.sign(body)

    def signed_invite_request(self):
        body = json.dumps(
            {"deviceId": self.device_id, "requestedAt": "2026-08-20T04:05:00.000Z", "ttlSeconds": 120},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return body, self.keys.sign(body)

    def event(self, **extra):
        value = {
            "eventId": "usage:" + "a" * 64,
            "deviceId": self.device_id,
            "provider": "codex",
            "threadKey": "thread_key_123456",
            "taskKey": "task_key_12345678",
            "completedAt": "2026-08-20T03:00:00.000Z",
            "estimatedCredits": 12.5,
            "accountKey": "chatgpt:owner",
            "accountLabel": "owner@example.com",
            "accountType": "chatgpt",
            "accountPlan": "plus",
            "accountAttribution": "exact",
            "usage": {"inputTokens": 10, "outputTokens": 20},
            "model": "gpt-5.6-sol",
            "serviceTier": "fast",
            "deviceLabel": "SidorukSV",
        }
        value.update(extra)
        return value

    def test_enroll_device_with_one_time_code_and_signature(self):
        code = server.create_enrollment_code(self.db, code="test-code")["code"]
        message = server.enrollment_message(code, self.identity)
        payload = {"code": code, "identity": self.identity, "signature": self.keys.sign(message)}
        result = server.enroll_device(self.db, payload)
        self.assertEqual(result["deviceId"], self.device_id)
        row = self.db.execute("SELECT * FROM devices WHERE device_id=?", (self.device_id,)).fetchone()
        self.assertEqual(row["label"], "Семён (DESKTOP-FNNC1JA)")
        with self.assertRaises(PermissionError):
            server.enroll_device(self.db, payload)

    def test_rejects_invalid_enrollment_signature(self):
        code = server.create_enrollment_code(self.db, code="bad-code")["code"]
        with self.assertRaises(PermissionError):
            server.enroll_device(
                self.db,
                {"code": code, "identity": self.identity, "signature": self.keys.sign(b"wrong")},
            )

    def test_ingests_signed_snapshot_for_enrolled_device(self):
        self.enroll()
        body, signature = self.signed_snapshot([self.event()])
        result = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        self.assertEqual(result["added"], 1)
        row = self.db.execute("SELECT * FROM usage_events").fetchone()
        self.assertEqual(row["device_id"], self.device_id)
        self.assertEqual(row["estimated_credits"], 12.5)
        self.assertEqual(row["account_key"], "")
        self.assertEqual(row["account_label"], "")
        self.assertEqual(row["device_label"], "SidorukSV")

    def test_repeated_same_snapshot_is_unchanged(self):
        self.enroll()
        body, signature = self.signed_snapshot([self.event(observedAt="2026-08-20T03:01:00.000Z")])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        result = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["unchanged"], 1)

    def test_newer_observation_updates_usage_without_adding_an_event(self):
        self.enroll()
        first_body, first_signature = self.signed_snapshot([
            self.event(observedAt="2026-08-20T03:01:00.000Z")
        ])
        server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=first_signature,
            body=first_body,
        )
        corrected_body, corrected_signature = self.signed_snapshot([
            self.event(
                observedAt="2026-08-25T01:02:00.000Z",
                usage={"inputTokens": 100, "outputTokens": 25, "totalTokens": 125},
            )
        ])

        result = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=corrected_signature,
            body=corrected_body,
        )

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["unchanged"], 0)
        rows = self.db.execute("SELECT * FROM usage_events").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["total_tokens"], 125)
        self.assertEqual(rows[0]["observed_at"], "2026-08-25T01:02:00.000Z")

    def test_rejects_bad_usage_signature(self):
        self.enroll()
        body, _signature = self.signed_snapshot([self.event()])
        with self.assertRaises(PermissionError):
            server.ingest_snapshot(
                self.db,
                device_id=self.device_id,
                signature=self.keys.sign(b"other-body"),
                body=body,
            )

    def test_rejects_forwarded_events_from_other_devices(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            self.event(),
            self.event(eventId="usage:" + "b" * 64, deviceId="11111111-2222-3333-4444-555555555555"),
        ])
        result = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        self.assertEqual(result["added"], 1)
        self.assertEqual(result["rejected"], 1)
        count = self.db.execute("SELECT COUNT(*) FROM usage_events").fetchone()[0]
        self.assertEqual(count, 1)

    def test_ingests_schema_2_turn_without_account_fields_and_preserves_limit_lanes(self):
        self.enroll()
        event = {
            "schemaVersion": 2,
            "type": "turn",
            "eventId": "usage:" + "c" * 64,
            "deviceId": self.device_id,
            "provider": "codex",
            "runtimeHomeId": "1" * 64,
            "threadKey": "b" * 64,
            "taskKey": "c" * 64,
            "startedAt": "2026-08-20T02:59:00.000Z",
            "completedAt": "2026-08-20T03:00:00.000Z",
            "observedAt": "2026-08-20T03:00:01.000Z",
            "limitSamples": [
                {"observedAt": "2026-08-20T02:59:10.000Z", "limitId": "codex", "window": "primary", "usedPercent": 10},
                {"observedAt": "2026-08-20T02:59:10.000Z", "limitId": "codex", "window": "secondary", "usedPercent": 50},
            ],
        }
        body, signature = self.signed_snapshot([event])

        result = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertEqual(result["usageFactSchemaVersion"], 2)
        self.assertEqual(result["added"], 1)
        row = self.db.execute(
            "SELECT schema_version, runtime_home_id, limit_samples_json, account_key FROM usage_events"
        ).fetchone()
        self.assertEqual(row["schema_version"], 2)
        self.assertEqual(row["runtime_home_id"], "1" * 64)
        self.assertEqual(row["account_key"], "")
        self.assertEqual([sample["window"] for sample in json.loads(row["limit_samples_json"])], ["primary", "secondary"])

        body, signature = self.signed_pull_request()
        snapshot = server.export_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        exported = snapshot["events"][0]
        self.assertEqual(exported["schemaVersion"], 2)
        self.assertEqual(exported["type"], "turn")
        self.assertEqual([sample["window"] for sample in exported["limitSamples"]], ["primary", "secondary"])
        self.assertNotIn("accountKey", exported)

    def test_merges_repeated_schema_2_turn_limit_samples(self):
        self.enroll()
        base = {
            "schemaVersion": 2,
            "type": "turn",
            "eventId": "usage:" + "c" * 64,
            "deviceId": self.device_id,
            "provider": "codex",
            "runtimeHomeId": "1" * 64,
            "threadKey": "b" * 64,
            "taskKey": "c" * 64,
            "startedAt": "2026-08-20T02:59:00.000Z",
            "completedAt": "2026-08-20T03:00:00.000Z",
            "observedAt": "2026-08-20T03:00:01.000Z",
            "usage": {"totalTokens": 100},
            "estimatedCredits": 12,
        }
        body, signature = self.signed_snapshot([
            {
                **base,
                "limitSamples": [
                    {
                        "observedAt": "2026-08-20T02:59:10.000Z",
                        "limitId": "codex",
                        "window": "5h",
                        "usedPercent": 10,
                    },
                ],
            },
        ])
        first = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        body, signature = self.signed_snapshot([
            {
                **base,
                "limitSamples": [
                    {
                        "observedAt": "2026-08-20T02:59:11.000Z",
                        "limitId": "codex",
                        "window": "weekly",
                        "usedPercent": 20,
                    },
                ],
            },
        ])
        second = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertEqual(first["added"], 1)
        self.assertEqual(second["updated"], 1)
        row = self.db.execute("SELECT limit_samples_json FROM usage_events").fetchone()
        self.assertEqual([sample["window"] for sample in json.loads(row["limit_samples_json"])], ["5h", "weekly"])

    def test_richer_schema_2_turn_does_not_drop_persisted_limit_samples(self):
        self.enroll()
        base = {
            "schemaVersion": 2,
            "type": "turn",
            "eventId": "usage:" + "c" * 64,
            "deviceId": self.device_id,
            "provider": "codex",
            "runtimeHomeId": "1" * 64,
            "threadKey": "b" * 64,
            "taskKey": "c" * 64,
            "startedAt": "2026-08-20T02:59:00.000Z",
            "completedAt": "2026-08-20T03:00:00.000Z",
            "observedAt": "2026-08-20T03:00:01.000Z",
            "usage": {"totalTokens": 100},
            "estimatedCredits": 12,
        }
        body, signature = self.signed_snapshot([
            {
                **base,
                "limitSamples": [
                    {
                        "observedAt": "2026-08-20T02:59:10.000Z",
                        "limitId": "codex",
                        "window": "5h",
                        "usedPercent": 10,
                    },
                ],
            },
        ])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        body, signature = self.signed_snapshot([
            {
                **base,
                "limitSamples": [
                    {
                        "observedAt": "2026-08-20T02:59:11.000Z",
                        "limitId": "codex",
                        "window": "weekly",
                        "usedPercent": 20,
                    },
                    {
                        "observedAt": "2026-08-20T02:59:12.000Z",
                        "limitId": "codex",
                        "window": "daily",
                        "usedPercent": 30,
                    },
                ],
            },
        ])
        second = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertEqual(second["updated"], 1)
        row = self.db.execute("SELECT limit_samples_json FROM usage_events").fetchone()
        self.assertEqual(
            [sample["window"] for sample in json.loads(row["limit_samples_json"])],
            ["5h", "weekly", "daily"],
        )

    def test_limit_samples_keep_conflicts_and_use_utf8_byte_order(self):
        samples = server.normalize_limit_samples([
            {"observedAt": "2026-08-20T02:59:10.000Z", "limitId": "z", "window": "primary", "usedPercent": 1},
            {"observedAt": "2026-08-20T02:59:10.000Z", "limitId": "ä", "window": "primary", "usedPercent": 1},
            {"observedAt": "2026-08-20T02:59:10.000Z", "limitId": "pro", "window": "primary", "usedPercent": 1},
            {"observedAt": "2026-08-20T02:59:10.000Z", "limitId": "PRO", "window": "primary", "usedPercent": 1},
            {"observedAt": "2026-08-20T02:59:11.000Z", "limitId": "codex", "window": "primary", "usedPercent": 10},
            {"observedAt": "2026-08-20T02:59:11.000Z", "limitId": "codex", "window": "primary", "usedPercent": 20},
            {"observedAt": "2026-08-20T02:59:11.000Z", "limitId": "codex", "window": "primary", "usedPercent": 20},
        ])

        self.assertEqual([sample["limitId"] for sample in samples[:4]], ["PRO", "pro", "z", "ä"])
        self.assertEqual([sample["usedPercent"] for sample in samples[-2:]], [10.0, 20.0])

    def test_ingests_legacy_turn_without_started_at_as_accountless_history(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            self.event(schemaVersion=1, accountAttribution="exact")
        ])

        result = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertEqual(result["added"], 1)
        row = self.db.execute(
            "SELECT schema_version, started_at, runtime_home_id, account_key, account_attribution FROM usage_events"
        ).fetchone()
        self.assertEqual(row["schema_version"], 1)
        self.assertEqual(row["started_at"], "")
        self.assertEqual(row["runtime_home_id"], "")
        self.assertEqual(row["account_key"], "")
        self.assertEqual(row["account_attribution"], "inferred")

        body, signature = self.signed_pull_request()
        snapshot = server.export_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        exported = snapshot["events"][0]
        self.assertEqual(exported["schemaVersion"], 1)
        self.assertEqual(exported["startedAt"], "")
        self.assertNotIn("runtimeHomeId", exported)
        self.assertNotIn("accountKey", exported)
        self.assertNotIn("accountAttribution", exported)

    def test_rejects_schema_2_turn_account_fields_and_unknown_facts(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            {
                "schemaVersion": 2,
                "type": "turn",
                "eventId": "usage:" + "d" * 64,
                "deviceId": self.device_id,
                "provider": "codex",
                "runtimeHomeId": "1" * 64,
                "threadKey": "b" * 64,
                "taskKey": "c" * 64,
                "startedAt": "2026-08-20T02:59:00.000Z",
                "completedAt": "2026-08-20T03:00:00.000Z",
                "accountKey": "chatgpt:owner",
            },
            {"schemaVersion": 2, "type": "declared_epoch", "deviceId": self.device_id},
            {"schemaVersion": 3, "type": "turn", "deviceId": self.device_id},
        ])
        result = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        self.assertEqual(result["added"], 0)
        self.assertEqual(result["rejected"], 3)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM usage_events").fetchone()[0], 0)

    def test_ingests_auth_and_limit_observations_as_facts(self):
        self.enroll()
        auth = {
            "schemaVersion": 2,
            "type": "auth_observation",
            "observationId": "auth:" + "e" * 64,
            "deviceId": self.device_id,
            "installationInstanceId": "11111111-2222-3333-4444-555555555555",
            "provider": "codex",
            "runtimeHomeId": "1" * 64,
            "accountKey": "chatgpt:owner",
            "accountLabel": "owner@example.test",
            "accountPlan": "pro",
            "observedAt": "2026-08-20T02:58:00.000Z",
            "evidenceSource": "account-read",
            "authFingerprint": "fingerprint",
        }
        limit = {
            "schemaVersion": 2,
            "type": "limit_observation",
            "observationId": "limit:" + "f" * 64,
            "deviceId": self.device_id,
            "provider": "codex",
            "accountKey": "chatgpt:owner",
            "limitId": "codex",
            "window": "primary",
            "usedPercent": 12,
            "observedAt": "2026-08-20T03:05:00.000Z",
        }
        body, signature = self.signed_snapshot([auth, limit])

        result = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertEqual(result["added"], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM usage_auth_observations").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM usage_limit_observations").fetchone()[0], 1)
        body, signature = self.signed_pull_request()
        snapshot = server.export_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        self.assertEqual([event["type"] for event in snapshot["events"]], ["auth_observation", "limit_observation"])

    def test_auth_observation_identity_preserves_installation_collisions(self):
        self.enroll()
        base = {
            "schemaVersion": 2,
            "type": "auth_observation",
            "observationId": "auth:" + "0" * 64,
            "deviceId": self.device_id,
            "provider": "codex",
            "runtimeHomeId": "1" * 64,
            "accountKey": "chatgpt:owner",
            "observedAt": "2026-08-20T01:00:00.000Z",
        }
        first_installation = "11111111-2222-3333-8444-555555555555"
        second_installation = "22222222-3333-4444-9555-666666666666"
        body, signature = self.signed_snapshot([
            {**base, "installationInstanceId": first_installation},
            {**base, "installationInstanceId": second_installation},
        ])

        result = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertEqual(result["added"], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM usage_auth_observations").fetchone()[0], 2)
        body, signature = self.signed_pull_request()
        snapshot = server.export_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        exported_auth = [event for event in snapshot["events"] if event["type"] == "auth_observation"]
        self.assertEqual(len(exported_auth), 2)
        self.assertEqual(
            sorted(event["installationInstanceId"] for event in exported_auth),
            [first_installation, second_installation],
        )
        self.assertEqual(len({event["observationId"] for event in exported_auth}), 2)
        self.assertNotIn("auth:" + "0" * 64, {event["observationId"] for event in exported_auth})

    def test_limit_observation_identity_preserves_lanes(self):
        self.enroll()
        stale_id = "limit:" + "0" * 64
        base = {
            "schemaVersion": 2,
            "type": "limit_observation",
            "observationId": stale_id,
            "deviceId": self.device_id,
            "provider": "codex",
            "accountKey": "chatgpt:owner",
            "limitId": "codex",
            "usedPercent": 10,
            "observedAt": "2026-08-20T01:00:00.000Z",
        }
        body, signature = self.signed_snapshot([
            {**base, "window": "primary"},
            {**base, "window": "secondary"},
        ])

        result = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertEqual(result["added"], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM usage_limit_observations").fetchone()[0], 2)
        body, signature = self.signed_pull_request()
        snapshot = server.export_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        exported_limits = [event for event in snapshot["events"] if event["type"] == "limit_observation"]
        self.assertEqual(len(exported_limits), 2)
        self.assertEqual(sorted(event["window"] for event in exported_limits), ["primary", "secondary"])
        self.assertEqual(len({event["observationId"] for event in exported_limits}), 2)
        self.assertNotIn(stale_id, {event["observationId"] for event in exported_limits})

    def test_stronger_event_updates_existing_usage_row(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            self.event(accountKey="", accountAttribution="inferred", estimatedCredits=0)
        ])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        body, signature = self.signed_snapshot([self.event()])
        result = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        self.assertEqual(result["updated"], 1)
        row = self.db.execute("SELECT estimated_credits, account_key, account_attribution FROM usage_events").fetchone()
        self.assertEqual(row["estimated_credits"], 12.5)
        self.assertEqual(row["account_key"], "")
        self.assertEqual(row["account_attribution"], "inferred")

    def test_inferred_account_fields_are_not_stored_as_trusted_sync_account(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            self.event(accountAttribution="inferred")
        ])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        row = self.db.execute(
            """
            SELECT account_key, account_label, account_type, account_plan, account_attribution
            FROM usage_events
            """
        ).fetchone()
        self.assertEqual(dict(row), {
            "account_key": "",
            "account_label": "",
            "account_type": "",
            "account_plan": "",
            "account_attribution": "inferred",
        })

    def test_exact_without_account_key_is_demoted_to_inferred(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            self.event(accountKey="", accountAttribution="exact")
        ])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        row = self.db.execute(
            """
            SELECT account_key, account_label, account_type, account_plan, account_attribution
            FROM usage_events
            """
        ).fetchone()
        self.assertEqual(dict(row), {
            "account_key": "",
            "account_label": "",
            "account_type": "",
            "account_plan": "",
            "account_attribution": "inferred",
        })

    def test_exports_signed_snapshot_for_enrolled_device(self):
        self.enroll()
        body, signature = self.signed_snapshot([self.event()])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        body, signature = self.signed_pull_request()
        snapshot = server.export_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )

        self.assertEqual(snapshot["version"], 1)
        self.assertEqual(snapshot["usageFactSchemaVersion"], 2)
        self.assertEqual(len(snapshot["events"]), 1)
        event = snapshot["events"][0]
        self.assertEqual(event["deviceId"], self.device_id)
        self.assertEqual(event["deviceLabel"], "SidorukSV")
        self.assertNotIn("accountKey", event)
        self.assertNotIn("accountLabel", event)
        self.assertNotIn("accountType", event)
        self.assertNotIn("accountPlan", event)
        self.assertNotIn("accountAttribution", event)
        self.assertEqual(event["usage"]["inputTokens"], 10)
        self.assertNotIn("receivedAtMs", event)

    def test_snapshot_includes_stable_generation_and_fact_summary(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            self.event(eventId="usage:" + "a" * 64, deviceLabel="Local Name")
        ])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        body, signature = self.signed_pull_request()
        first = server.export_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        body, signature = self.signed_pull_request()
        second = server.export_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertRegex(first["datasetGeneration"], r"^[0-9a-f-]{36}$")
        self.assertEqual(first["datasetGeneration"], second["datasetGeneration"])
        self.assertEqual(first["factSummary"], second["factSummary"])
        self.assertEqual(first["factSummary"]["count"], 1)
        self.assertEqual(first["factSummary"]["byType"]["turn"], 1)
        self.assertRegex(first["factSummary"]["digest"], r"^sha256:[0-9a-f]{64}$")

    def test_summary_only_snapshot_omits_events_but_keeps_dataset_proof(self):
        self.enroll()
        body, signature = self.signed_snapshot([self.event(eventId="usage:" + "a" * 64)])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        body, signature = self.signed_summary_request()
        summary = server.export_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertEqual(summary["events"], [])
        self.assertEqual(summary["serverRevision"], 1)
        self.assertEqual(summary["factSummary"]["count"], 1)

    def test_normal_push_and_changes_do_not_compute_full_fact_summary(self):
        self.enroll()
        body, signature = self.signed_snapshot([self.event(eventId="usage:" + "a" * 64)])
        with patch.object(server, "usage_fact_summary", side_effect=AssertionError("unexpected summary")):
            result = server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        self.assertNotIn("factSummary", result)

        body, signature = self.signed_changes_request(0)
        with patch.object(server, "usage_fact_summary", side_effect=AssertionError("unexpected summary")):
            delta = server.export_changes(self.db, device_id=self.device_id, signature=signature, body=body)

        self.assertNotIn("factSummary", delta)
        self.assertEqual([event["eventId"] for event in delta["events"]], ["usage:" + "a" * 64])

    def test_summary_only_changes_computes_full_fact_summary_without_events(self):
        self.enroll()
        body, signature = self.signed_snapshot([self.event(eventId="usage:" + "a" * 64)])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)

        body, signature = self.signed_changes_request(0, summary_only=True)
        with patch.object(server, "usage_fact_summary", wraps=server.usage_fact_summary) as summary:
            result = server.export_changes(self.db, device_id=self.device_id, signature=signature, body=body)

        summary.assert_called_once()
        self.assertEqual(result["events"], [])
        self.assertEqual(result["factSummary"]["count"], 1)

    def test_export_clears_legacy_inferred_account_fields(self):
        self.enroll()
        body, signature = self.signed_snapshot([self.event()])
        server.ingest_snapshot(self.db, device_id=self.device_id, signature=signature, body=body)
        self.db.execute(
            """
            UPDATE usage_events
            SET account_attribution='inferred',
                account_key='chatgpt:baseus',
                account_label='account-3@example.invalid',
                account_type='chatgpt',
                account_plan='pro'
            """
        )

        body, signature = self.signed_pull_request()
        snapshot = server.export_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )

        event = snapshot["events"][0]
        self.assertNotIn("accountKey", event)
        self.assertNotIn("accountLabel", event)
        self.assertNotIn("accountType", event)
        self.assertNotIn("accountPlan", event)
        self.assertNotIn("accountAttribution", event)

    def test_ingest_returns_server_revision_and_delta_exports_only_new_changes(self):
        self.enroll()
        body, signature = self.signed_snapshot([self.event(eventId="usage:" + "a" * 64)])
        first = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        self.assertEqual(first["serverRevision"], 1)

        body, signature = self.signed_changes_request(0)
        initial_delta = server.export_changes(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        self.assertEqual(initial_delta["serverRevision"], 1)
        self.assertEqual(initial_delta["usageFactSchemaVersion"], 2)
        self.assertEqual([event["eventId"] for event in initial_delta["events"]], ["usage:" + "a" * 64])

        body, signature = self.signed_snapshot([self.event(eventId="usage:" + "b" * 64)])
        second = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        self.assertEqual(second["serverRevision"], 2)

        body, signature = self.signed_changes_request(1)
        delta = server.export_changes(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        self.assertEqual(delta["sinceRevision"], 1)
        self.assertEqual(delta["serverRevision"], 2)
        self.assertEqual([event["eventId"] for event in delta["events"]], ["usage:" + "b" * 64])

    def test_repeated_snapshot_does_not_advance_server_revision(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            self.event(observedAt="2026-08-20T03:01:00.000Z")
        ])
        first = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        repeated = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )

        self.assertEqual(first["serverRevision"], repeated["serverRevision"])
        self.assertEqual(repeated["unchanged"], 1)

    def test_empty_usage_push_updates_device_label_without_events(self):
        self.enroll()
        body, signature = self.signed_snapshot([
            self.event(deviceLabel="OldNick", observedAt="2026-08-20T03:01:00.000Z")
        ])
        first = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        body = json.dumps(
            {
                "version": 1,
                "deviceId": self.device_id,
                "deviceLabel": "NewNick",
                "events": [],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        result = server.ingest_snapshot(
            self.db,
            device_id=self.device_id,
            signature=self.keys.sign(body),
            body=body,
        )

        self.assertEqual(result["added"], 0)
        self.assertEqual(result["updated"], 1)
        self.assertGreater(result["serverRevision"], first["serverRevision"])
        row = self.db.execute("SELECT label FROM devices WHERE device_id=?", (self.device_id,)).fetchone()
        self.assertEqual(row["label"], "NewNick")
        body, signature = self.signed_changes_request(first["serverRevision"])
        delta = server.export_changes(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )
        self.assertEqual(delta["events"][0]["deviceLabel"], "NewNick")

    def test_enrolled_device_can_create_one_time_enrollment_code(self):
        self.enroll()
        body, signature = self.signed_invite_request()

        result = server.create_enrollment_code_for_device(
            self.db,
            device_id=self.device_id,
            signature=signature,
            body=body,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["deviceId"], self.device_id)
        self.assertTrue(result["code"])

    def test_rejects_bad_enrollment_code_signature(self):
        self.enroll()
        body, _signature = self.signed_invite_request()
        with self.assertRaises(PermissionError):
            server.create_enrollment_code_for_device(
                self.db,
                device_id=self.device_id,
                signature=self.keys.sign(b"other-body"),
                body=body,
            )

    def test_rejects_bad_snapshot_signature(self):
        self.enroll()
        body, _signature = self.signed_pull_request()
        with self.assertRaises(PermissionError):
            server.export_snapshot(
                self.db,
                device_id=self.device_id,
                signature=self.keys.sign(b"other-body"),
                body=body,
            )


if __name__ == "__main__":
    unittest.main()
