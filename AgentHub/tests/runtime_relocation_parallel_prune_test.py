"""Actual native deletion, bounded coordination and same-plan crash recovery."""

from contextlib import closing, redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import runtime_relocation as relocation


@unittest.skipUnless(os.name == "nt", "Windows held-file deletion")
class ParallelPruneTests(unittest.TestCase):
    FILE_COUNT = 24

    def setUp(self):
        parent = os.environ.get("AGENT_HUB_TEST_TMP")
        if not parent:
            self.skipTest("Set AGENT_HUB_TEST_TMP to an owned destination-volume fixture root")
        self.parent = relocation.plain_directory(parent)
        self.temp = Path(tempfile.mkdtemp(prefix="hub143-parallel-prune-", dir=self.parent))
        self.source, self.target = self.temp / "source", self.temp / "target"
        self.source.mkdir()
        (self.source / "nested").mkdir()
        for index in range(self.FILE_COUNT):
            (self.source / f"z{index:03}.bin").write_bytes(bytes([index]) * (512 + index))
        (self.source / "nested" / "useful-WIP.txt").write_bytes(b"retained untracked work")
        (self.source / "hard-a").write_bytes(b"real hardlink group")
        os.link(self.source / "hard-a", self.source / "hard-b")
        with closing(sqlite3.connect(self.source / "state.sqlite")) as db:
            db.execute("CREATE TABLE useful(value)")
            db.execute("INSERT INTO useful VALUES('saved')")
            db.commit()
        self.plan_file = self.temp / "plan.json"
        relocation.create_plan(self.plan_file, [(self.source, self.target)])
        self.plan = relocation.load_plan(self.plan_file, relocation.digest(self.plan_file))
        relocation.copy_roots(self.plan, offline=True)
        relocation.validate_databases(self.plan)
        relocation.switch_roots(self.plan)
        relocation.admit_start(self.plan)
        proof = self.temp / "runtime-proof.json"
        relocation.write_json(proof, {
            "operation": self.plan["operation"], "runtime_verified": True,
            "physical_runtime_root": self.plan["roots"][0]["target"],
            "logical_runtime_root": self.plan["roots"][0]["source"],
            **{key: "fixture" for key in (
                "release", "node_pid", "host_pid", "history", "attachments", "mcp",
                "queue_recovery", "readonly_legacy_ipc", "physical_file_handles",
            )},
        })
        relocation.accept_started(self.plan, proof)
        self.original = Path(self.plan["roots"][0]["original"])
        self.before = self.rows()

    def tearDown(self):
        if not hasattr(self, "temp"):
            return
        self.assertEqual(self.temp.parent.resolve(), self.parent.resolve())
        self.assertTrue(self.temp.name.startswith("hub143-parallel-prune-"))
        if os.path.lexists(self.source):
            self.assertTrue(relocation.reparse(self.source))
            os.rmdir(self.source)
        relocation.plain_directory(self.temp)
        for _, kind, _, _ in relocation.tree(self.temp):
            self.assertNotEqual(kind, "link", "Preserve an unexpected fixture link")
        shutil.rmtree(relocation.long_path(self.temp))

    def rows(self):
        with closing(relocation.connect(self.plan["manifest"])) as db:
            return {row["rel"]: dict(row) for row in db.execute("SELECT * FROM files")}

    def assert_retained_target(self):
        self.assertFalse(self.original.exists())
        self.assertEqual((self.target / "nested/useful-WIP.txt").read_bytes(), b"retained untracked work")
        self.assertEqual(relocation.info(self.target / "hard-a")["ino"],
                         relocation.info(self.target / "hard-b")["ino"])
        with closing(sqlite3.connect((self.target / "state.sqlite").as_uri() + "?mode=ro", uri=True)) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
            self.assertEqual(db.execute("SELECT value FROM useful").fetchone()[0], "saved")
        for rel, row in self.rows().items():
            self.assertEqual(row["deleted"], 1)
            self.assertEqual((row["identity"], row["sha256"]),
                             (self.before[rel]["identity"], self.before[rel]["sha256"]))

    def test_default_remains_serial(self):
        native_delete = relocation.delete_verified_file
        caller = threading.get_ident()
        observed = []

        def delete(file, *args, **kwargs):
            self.assertEqual(threading.get_ident(), caller)
            self.assertNotIn("single_link", kwargs)
            observed.append(str(file))
            return native_delete(file, *args, **kwargs)

        with patch.object(relocation, "delete_verified_file", side_effect=delete):
            self.assertEqual(relocation.prune_originals(self.plan)["phase"], "completed")
        self.assertTrue(observed)
        self.assert_retained_target()

    def test_bounded_parallel_intents_and_hardlink_directory_barriers(self):
        native_delete = relocation.delete_verified_file
        lock, gate = threading.Lock(), threading.Barrier(8)
        active, maximum, admitted, ordinary = 0, 0, 0, 0
        caller = threading.get_ident()

        def delete(file, *args, **kwargs):
            nonlocal active, maximum, admitted, ordinary
            file = Path(file)
            if kwargs.get("single_link"):
                self.assertNotEqual(threading.get_ident(), caller)
                identity = relocation.info(file)
                self.assertEqual(identity["links"], 1)
                with closing(sqlite3.connect(Path(self.plan["manifest"]).as_uri() + "?mode=ro", uri=True)) as db:
                    rel = str(file.relative_to(self.original))
                    self.assertEqual(db.execute("SELECT deleted FROM files WHERE rel=?", (rel,)).fetchone()[0], 2)
                with lock:
                    active += 1
                    admitted += 1
                    ordinal = admitted
                    maximum = max(maximum, active)
                    self.assertLessEqual(active, 8)
                try:
                    if ordinal <= 8:
                        gate.wait(timeout=10)
                    return native_delete(file, *args, **kwargs)
                finally:
                    with lock:
                        active -= 1
            self.assertEqual(threading.get_ident(), caller)
            with lock:
                self.assertEqual(active, 0)
                ordinary += 1
            return native_delete(file, *args, **kwargs)

        with patch.object(relocation, "delete_verified_file", side_effect=delete):
            result = relocation.prune_originals(self.plan, prune_workers=8)
        self.assertEqual(result["phase"], "completed")
        self.assertEqual(maximum, 8)
        self.assertGreater(admitted, 8)
        self.assertGreaterEqual(ordinary, 4)  # Two links and both directories.
        self.assert_retained_target()

    def test_real_write_lock_drains_successes_and_same_plan_resumes(self):
        locked = self.original / "z023.bin"
        with locked.open("r+b"):
            with self.assertRaises(OSError):
                relocation.prune_originals(self.plan, prune_workers=8)
        after = self.rows()
        self.assertEqual(after["z023.bin"]["deleted"], 2)
        self.assertTrue(locked.exists())
        self.assertEqual(sum(row["deleted"] == 1 for row in after.values()), 7)
        self.assertEqual(after["."]["deleted"], 0)
        for rel, row in after.items():
            if row["deleted"] == 1:
                self.assertFalse((self.original / rel).exists())
        self.assertEqual(relocation.prune_originals(self.plan, prune_workers=8)["phase"], "completed")
        self.assert_retained_target()

    def test_new_link_between_admission_and_handle_refuses_preserves_both_names(self):
        native_delete = relocation.delete_verified_file
        failed = self.original / "z023.bin"
        foreign = self.temp / "new-link-preserved"
        payload = failed.read_bytes()

        def link_before_delete(file, *args, **kwargs):
            if Path(file) == failed:
                os.link(file, foreign)  # Real native link after coordinator admission.
            return native_delete(file, *args, **kwargs)

        with patch.object(relocation, "delete_verified_file", side_effect=link_before_delete):
            with self.assertRaisesRegex(ValueError, "identity changed"):
                relocation.prune_originals(self.plan, prune_workers=8)
        self.assertEqual(failed.read_bytes(), payload)
        self.assertEqual(foreign.read_bytes(), payload)
        self.assertEqual(self.rows()["z023.bin"]["deleted"], 2)
        self.assertEqual(self.rows()["."]["deleted"], 0)
        foreign.unlink()  # Only this own fixture link; production never unlinks it.
        self.assertEqual(relocation.prune_originals(self.plan, prune_workers=8)["phase"], "completed")
        self.assert_retained_target()

    def test_actual_child_crash_after_native_effect_resumes_original_intent(self):
        code = """
import os, sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
import runtime_relocation as r
plan = r.load_plan(sys.argv[2], sys.argv[3])
native = r.delete_verified_file
def crash(file, *args, **kwargs):
    result = native(file, *args, **kwargs)
    if Path(file).name == 'z023.bin':
        os._exit(73)
    return result
r.delete_verified_file = crash
r.prune_originals(plan, prune_workers=8)
"""
        result = subprocess.run([
            sys.executable, "-X", "utf8", "-B", "-c", code,
            str(Path(relocation.__file__).parent), str(self.plan_file), relocation.digest(self.plan_file),
        ], capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 73, result.stderr.decode("utf-8"))
        self.assertFalse((self.original / "z023.bin").exists())
        rows = self.rows()
        self.assertEqual(rows["z023.bin"]["deleted"], 2)
        self.assertEqual(rows["."]["deleted"], 0)
        with closing(relocation.connect(self.plan["manifest"])) as db:
            self.assertEqual(relocation.phase(db), "pruning")
        self.assertEqual(relocation.prune_originals(self.plan, prune_workers=8)["phase"], "completed")
        self.assert_retained_target()

    def test_new_link_during_same_handle_hash_refuses_before_disposition(self):
        native_digest = relocation.content_digest
        failed = self.original / "z023.bin"
        foreign = self.temp / "link-during-held-hash"
        payload = failed.read_bytes()

        def add_during_hash(file, default_hash=None):
            if Path(file) == failed and default_hash is not None:
                os.link(file, foreign)  # Native operation while the delete handle is held.
            return native_digest(file, default_hash)

        with patch.object(relocation, "content_digest", side_effect=add_during_hash):
            with self.assertRaisesRegex(ValueError, "Parallel source deletion link count changed"):
                relocation.prune_originals(self.plan, prune_workers=8)
        self.assertEqual(failed.read_bytes(), payload)
        self.assertEqual(foreign.read_bytes(), payload)
        self.assertEqual(self.rows()["z023.bin"]["deleted"], 2)
        self.assertEqual(self.rows()["."]["deleted"], 0)
        foreign.unlink()
        self.assertEqual(relocation.prune_originals(self.plan, prune_workers=8)["phase"], "completed")
        self.assert_retained_target()

    def test_coordinator_cancellation_joins_effect_and_persists_only_known_success(self):
        native_delete, native_info = relocation.delete_verified_file, relocation.info
        effect, release = threading.Event(), threading.Event()
        native_effects, lock = set(), threading.Lock()
        inspections = 0

        def delete(file, *args, **kwargs):
            result = native_delete(file, *args, **kwargs)
            with lock:
                native_effects.add(str(Path(file).relative_to(self.original)))
            if Path(file).name == "z023.bin":
                effect.set()
                self.assertTrue(release.wait(timeout=10))
            return result

        def info(file):
            nonlocal inspections
            if Path(file) == self.original / "z022.bin":
                inspections += 1
                if inspections == 2:  # Whole-root preflight, then admission.
                    self.assertTrue(effect.wait(timeout=10))
                    release.set()
                    raise KeyboardInterrupt("cancel own coordinator")
            return native_info(file)

        try:
            with patch.object(relocation, "delete_verified_file", side_effect=delete), \
                    patch.object(relocation, "info", side_effect=info):
                with self.assertRaisesRegex(KeyboardInterrupt, "cancel own coordinator"):
                    relocation.prune_originals(self.plan, prune_workers=8)
        finally:
            release.set()
        rows = self.rows()
        self.assertEqual({rel for rel, row in rows.items() if row["deleted"] == 1}, native_effects)
        self.assertIn("z023.bin", native_effects)
        self.assertEqual(rows["z023.bin"]["deleted"], 1)
        self.assertFalse((self.original / "z023.bin").exists())
        self.assertEqual(rows["."]["deleted"], 0)
        self.assertTrue((self.original / "z022.bin").exists())
        self.assertEqual(relocation.prune_originals(self.plan, prune_workers=8)["phase"], "completed")
        self.assert_retained_target()

    def test_opt_in_bound_rejects_other_worker_counts(self):
        for value in (0, 2, 9, True, 8.0):
            with self.assertRaisesRegex(ValueError, "Prune workers"):
                relocation.prune_originals(self.plan, prune_workers=value)
        self.assertTrue(self.original.exists())

    def test_cli_explicit_eight_uses_same_plan_and_completion_contract(self):
        result = subprocess.run([
            sys.executable, "-X", "utf8", "-B", str(Path(relocation.__file__)),
            "prune-originals", "--plan", str(self.plan_file),
            "--expected-plan-sha256", relocation.digest(self.plan_file),
            "--prune-workers", "8",
        ], capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8"))
        self.assertEqual(json.loads(result.stdout)["phase"], "completed")
        self.assert_retained_target()

    def test_parallel_reports_existing_coordinator_progress_contract(self):
        output = io.StringIO()
        with patch.object(relocation, "PRUNE_PROGRESS_INTERVAL", 8), redirect_stdout(output):
            result = relocation.prune_originals(self.plan, prune_workers=8)
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([row["entries"] for row in records], list(range(8, result["entries"] + 1, 8)))
        self.assertTrue(all(row["phase"] == "pruning" and row["logical_deleted_bytes"] > 0 for row in records))
        self.assert_retained_target()


@unittest.skipUnless(os.name == "nt", "Windows typed cohort custody")
class ParallelTypedShmTests(unittest.TestCase):
    def test_typed_index_remains_first_serial_effect_with_same_proof(self):
        if not os.environ.get("AGENT_HUB_TEST_TMP"):
            self.skipTest("Set AGENT_HUB_TEST_TMP to an owned destination-volume fixture root")
        from runtime_relocation_prune_test import DerivedShmPruneTests

        fixture = DerivedShmPruneTests("test_before_refuses_drift_after_typed_proof_prunes_preserving_old_rows_and_live_target")
        fixture.setUp()
        try:
            sha = fixture.change_and_preview()
            old = fixture.row()
            native_delete, events = relocation.delete_verified_file, []
            caller = threading.get_ident()

            def delete(file, *args, **kwargs):
                events.append(Path(file))
                if Path(file) == fixture.shm:
                    self.assertEqual(len(events), 1)
                    self.assertEqual(threading.get_ident(), caller)
                    self.assertTrue(kwargs.get("strict_identity"))
                    self.assertNotIn("single_link", kwargs)
                return native_delete(file, *args, **kwargs)

            with patch.object(relocation, "delete_verified_file", side_effect=delete):
                result = relocation.prune_originals(fixture.plan, fixture.preview, sha, prune_workers=8)
            self.assertEqual(result["phase"], "completed")
            row = fixture.row()
            self.assertEqual((row["identity"], row["sha256"]), (old["identity"], old["sha256"]))
            self.assertEqual(row["deleted"], 1)
            self.assertFalse(fixture.original.exists())
            self.assertTrue(fixture.kept.exists())
        finally:
            fixture.tearDown()


if __name__ == "__main__":
    unittest.main()
