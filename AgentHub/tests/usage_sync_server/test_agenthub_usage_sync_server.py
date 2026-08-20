import base64
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

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
            "accountAttribution": "exact",
            "usage": {"inputTokens": 10, "outputTokens": 20},
            "model": "gpt-5.6-sol",
            "serviceTier": "fast",
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

    def test_stronger_event_updates_existing_row(self):
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
        row = self.db.execute("SELECT account_key, account_attribution FROM usage_events").fetchone()
        self.assertEqual(dict(row), {"account_key": "chatgpt:owner", "account_attribution": "exact"})

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
        self.assertEqual(len(snapshot["events"]), 1)
        event = snapshot["events"][0]
        self.assertEqual(event["deviceId"], self.device_id)
        self.assertEqual(event["usage"]["inputTokens"], 10)
        self.assertNotIn("receivedAtMs", event)

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
