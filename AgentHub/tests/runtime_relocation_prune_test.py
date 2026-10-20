"""Real Windows original-cohort custody; never opens a production SQLite file."""
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import runtime_relocation as relocation


@unittest.skipUnless(os.name == "nt", "Windows sharing/deletion custody")
class DerivedShmPruneTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="hub143-derived-shm-", dir=os.environ.get("AGENT_HUB_TEST_TMP")))
        self.source, self.target = self.temp / "source", self.temp / "target"
        data = self.source / "data"
        data.mkdir(parents=True)
        file = data / "runtime.sqlite"
        with closing(sqlite3.connect(file)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA wal_autocheckpoint=0")
            db.execute("CREATE TABLE retained(value)")
            db.execute("INSERT INTO retained VALUES('durable identity')")
            db.commit()
            # Tiny deterministic fixture producer. Restore the recorded raw
            # cohort after closing this fixture connection, before planning.
            raw = {p.name: p.read_bytes() for p in data.iterdir()}
        for name, payload in raw.items():
            (data / name).write_bytes(payload)
        # Reproduce the observed two-region offline index -> one-region rebuild.
        index = data / "runtime.sqlite-shm"
        self.assertEqual(index.stat().st_size, 32768)
        index.write_bytes(index.read_bytes() + bytes(32768))
        (self.source / "untracked-WIP.txt").write_bytes(b"retain useful work")
        self.plan_file = self.temp / "plan.json"
        relocation.create_plan(self.plan_file, [(self.source, self.target)])
        self.plan = relocation.load_plan(self.plan_file, relocation.digest(self.plan_file))
        relocation.copy_roots(self.plan, offline=True)
        relocation.validate_databases(self.plan)
        relocation.switch_roots(self.plan)
        relocation.admit_start(self.plan)
        proof = self.temp / "accepted-runtime.json"
        relocation.write_json(proof, {
            "operation": self.plan["operation"], "runtime_verified": True,
            "physical_runtime_root": self.plan["roots"][0]["target"],
            "logical_runtime_root": self.plan["roots"][0]["source"],
            **{k: "fixture" for k in ("release", "node_pid", "host_pid", "history", "attachments",
                                      "mcp", "queue_recovery", "readonly_legacy_ipc", "physical_file_handles")},
        })
        relocation.accept_started(self.plan, proof)
        self.original = Path(self.plan["roots"][0]["original"])
        self.shm = self.original / "data/runtime.sqlite-shm"
        self.kept = self.temp / "preserved-current-shm.bin"
        self.preview = self.temp / "derived-shm.json"
        self.original_row = self.row()

    def tearDown(self):
        if os.path.lexists(relocation.long_path(self.source)) and relocation.reparse(self.source):
            os.rmdir(self.source)
        assert self.temp.parent.resolve() == Path(os.environ.get("AGENT_HUB_TEST_TMP", tempfile.gettempdir())).resolve()
        assert self.temp.name.startswith("hub143-derived-shm-")
        shutil.rmtree(relocation.long_path(self.temp))

    def row(self):
        with closing(relocation.connect(self.plan["manifest"])) as db:
            return dict(db.execute("SELECT * FROM files WHERE root=0 AND rel=?",
                                  (str(Path("data/runtime.sqlite-shm")),)).fetchone())

    def change_and_preview(self):
        payload = bytearray(self.shm.read_bytes())
        payload[128] ^= 0x5A
        # Same native file and creation time: old64KiB -> current32KiB.
        self.shm.write_bytes(bytes(payload[:32768]))
        relocation.copy_file(self.shm, self.kept, self.plan["operation"])
        relocation.preview_derived_shm(self.plan, self.kept, self.preview)
        return relocation.digest(self.preview)

    def prune(self, sha=None):
        return relocation.prune_originals(self.plan, self.preview, sha or relocation.digest(self.preview))

    def assert_no_source_deleted(self):
        self.assertTrue((self.original / "data/runtime.sqlite").exists())
        self.assertTrue((self.original / "data/runtime.sqlite-wal").exists())
        self.assertTrue(self.shm.exists())
        self.assertTrue((self.original / "untracked-WIP.txt").exists())

    def test_before_refuses_drift_after_typed_proof_prunes_preserving_old_rows_and_live_target(self):
        sha = self.change_and_preview()
        current = self.shm.read_bytes()
        old = self.original_row
        self.assertEqual(json.loads(old["identity"])["size"], 65536)
        self.assertEqual(len(current), 32768)
        with self.assertRaisesRegex(ValueError, "Source file changed"):
            relocation.prune_originals(self.plan)
        self.assert_no_source_deleted()
        with (self.target / "new-live-writes.txt").open("wb") as writer:
            writer.write(b"live D state")
            writer.flush()
            self.assertEqual(self.prune(sha)["phase"], "completed")
        self.assertFalse(self.original.exists())
        self.assertEqual(self.kept.read_bytes(), current)
        self.assertEqual((self.target / "new-live-writes.txt").read_bytes(), b"live D state")
        self.assertEqual((self.target / "untracked-WIP.txt").read_bytes(), b"retain useful work")
        row = self.row()
        self.assertEqual((row["identity"], row["sha256"]), (old["identity"], old["sha256"]))
        self.assertEqual(row["deleted"], 1)

    def test_base_or_wal_drift_refuses_before_any_source_delete(self):
        self.change_and_preview()
        for name in ("runtime.sqlite", "runtime.sqlite-wal"):
            file = self.original / "data" / name
            before = file.read_bytes()
            native = relocation.info(file)
            file.write_bytes(before + b"unexpected write")
            with self.assertRaises(ValueError):
                self.prune()
            self.assert_no_source_deleted()
            file.write_bytes(before)
            os.utime(file, ns=(file.stat().st_atime_ns, native["mtime"]))

    def test_current_index_drift_or_missing_preservation_refuses(self):
        self.change_and_preview()
        self.shm.write_bytes(self.shm.read_bytes() + bytes(32768))
        with self.assertRaises(ValueError):
            self.prune()
        self.assert_no_source_deleted()
        self.kept.unlink()
        with self.assertRaises(OSError):
            self.prune()
        self.assert_no_source_deleted()

    def test_foreign_preservation_junction_refuses(self):
        self.change_and_preview()
        foreign = self.temp / "foreign"
        foreign.mkdir()
        kept_dir = self.temp / "kept-dir"
        kept_dir.mkdir()
        self.kept.rename(foreign / self.kept.name)
        kept_dir.rmdir()
        relocation.make_link(str(foreign), kept_dir, 0xA0000003, True)
        value = json.loads(self.preview.read_text(encoding="utf-8"))
        value["preserved_shm"]["path"] = str(kept_dir / self.kept.name)
        relocation.write_json(self.preview, value)
        try:
            with self.assertRaisesRegex(ValueError, "reparse"):
                self.prune()
            self.assert_no_source_deleted()
            self.assertTrue((foreign / self.kept.name).exists())
        finally:
            os.rmdir(kept_dir)

    def test_actual_write_handle_refuses_and_release_allows_same_proof(self):
        self.change_and_preview()
        file = self.original / "data/runtime.sqlite-wal"
        with file.open("r+b"):
            with self.assertRaises(OSError):
                self.prune()
            self.assert_no_source_deleted()
        self.assertEqual(self.prune()["phase"], "completed")

    def test_active_original_process_refuses_without_selecting_live_logical_alias(self):
        self.change_and_preview()
        argv = [sys.executable, "-X", "utf8", "-B", str(Path(relocation.__file__)),
                "prune-originals", "--plan", str(self.plan_file),
                "--expected-plan-sha256", relocation.digest(self.plan_file),
                "--derived-shm-proof", str(self.preview),
                "--expected-derived-shm-proof-sha256", relocation.digest(self.preview)]
        reader_code = "import sys; f=open(sys.argv[1],'rb'); print('ready',flush=True); sys.stdin.buffer.read()"
        for source, expected_exit in ((self.original, 1), (self.source, 0)):
            child = subprocess.Popen([sys.executable, "-B", "-c", reader_code,
                                      str(source / "data/runtime.sqlite")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertEqual(child.stdout.readline(), b"ready\r\n")
                result = subprocess.run(argv, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, expected_exit, result.stderr.decode("utf-8"))
                self.assertIsNone(child.poll())
                if expected_exit:
                    self.assertIn(b"Original holding-path process", result.stderr)
                    self.assert_no_source_deleted()
            finally:
                child.stdin.close()
                child.wait(timeout=5)
                child.stdout.close()
                child.stderr.close()

    def test_delete_intent_and_after_effect_crash_resume_same_proof_only(self):
        sha = self.change_and_preview()
        original_delete = relocation.delete_verified_file
        observed = []

        def crash(file, *args, **kwargs):
            if Path(file) == self.shm:
                self.assertEqual(self.row()["deleted"], 2)
                self.assertTrue((self.original / "data/runtime.sqlite-wal").exists())
                original_delete(file, *args, **kwargs)
                observed.append("effect")
                raise OSError("crash after SHM effect")
            return original_delete(file, *args, **kwargs)

        with patch.object(relocation, "delete_verified_file", side_effect=crash):
            with self.assertRaisesRegex(OSError, "after SHM effect"):
                self.prune(sha)
        self.assertEqual(observed, ["effect"])
        self.assertEqual(self.row()["deleted"], 2)
        self.assertFalse(self.shm.exists())
        with self.assertRaisesRegex(ValueError, "proof"):
            relocation.prune_originals(self.plan)
        with self.assertRaisesRegex(ValueError, "proof"):
            self.prune("0" * 64)
        self.assertEqual(self.prune(sha)["phase"], "completed")

    def test_missing_proof_or_unclassified_stream_never_adopts_drift(self):
        self.change_and_preview()
        with open(str(self.kept) + ":valuable", "wb") as stream:
            stream.write(b"unclassified user evidence")
        with self.assertRaises(ValueError):
            self.prune()
        self.assert_no_source_deleted()
        with open(str(self.kept) + ":valuable", "rb") as stream:
            self.assertEqual(stream.read(), b"unclassified user evidence")

    def test_before_effect_failure_reuses_bound_intent_without_expected_row_rewrite(self):
        sha = self.change_and_preview()
        with patch.object(relocation, "delete_verified_file", side_effect=OSError("before effect")):
            with self.assertRaisesRegex(OSError, "before effect"):
                self.prune(sha)
        self.assertEqual(self.row()["deleted"], 2)
        self.assert_no_source_deleted()
        self.assertEqual(self.prune(sha)["phase"], "completed")
        self.assertEqual(self.row()["identity"], self.original_row["identity"])

    def test_unbound_missing_old_intent_cannot_be_laundered_by_retry(self):
        sha = self.change_and_preview()
        with closing(relocation.connect(self.plan["manifest"])) as db:
            db.execute("UPDATE files SET deleted=2 WHERE root=0 AND rel=?", (self.row()["rel"],))
            db.commit()
        self.shm.unlink()  # Own fixture models a prior ambiguous, untyped effect.
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "intact original index"):
                self.prune(sha)
            with closing(relocation.connect(self.plan["manifest"])) as db:
                self.assertIsNone(db.execute("SELECT value FROM state WHERE key='derived_shm_proof_sha256'").fetchone())
        self.assertTrue((self.original / "data/runtime.sqlite").exists())
        self.assertTrue((self.original / "data/runtime.sqlite-wal").exists())


if __name__ == "__main__":
    unittest.main()
