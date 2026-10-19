"""Behavioral filesystem tests. Fixtures stay on the explicitly selected drive."""

import importlib.util
import base64
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
import runtime_relocation_process as process_custody
import runtime_relocation_cutover as cutover

spec = importlib.util.spec_from_file_location(
    "runtime_relocation", Path(__file__).parents[1] / "runtime_relocation.py"
)
relocation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relocation)


class RelocationTest(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows volume comparison")
    def test_different_volumes_do_not_overlap(self):
        self.assertFalse(relocation.inside("C:/AgentHub", "D:/AgentHub"))

    def setUp(self):
        self.temp = Path(
            tempfile.mkdtemp(
                prefix="hub143-relocation-test-",
                dir=os.environ.get("AGENT_HUB_TEST_TMP"),
            )
        )
        self.source = self.temp / "AgentHub-source"
        self.target = self.temp / "destination"
        self.source.mkdir()
        self.plan_file = self.temp / "plan.json"

    def tearDown(self):
        # Never traverse a compatibility junction while cleaning an owned fixture.
        if self.source.exists() and relocation.reparse(self.source):
            os.rmdir(self.source)
        expected_parent = Path(
            os.environ.get("AGENT_HUB_TEST_TMP", tempfile.gettempdir())
        ).resolve()
        if (
            self.temp.parent.resolve() != expected_parent
            or not self.temp.name.startswith("hub143-relocation-test-")
        ):
            raise ValueError("Fixture cleanup escaped its exact selected root")
        shutil.rmtree(relocation.long_path(self.temp))

    def plan(self):
        relocation.create_plan(self.plan_file, [(self.source, self.target)])
        return relocation.load_plan(self.plan_file, relocation.digest(self.plan_file))

    def test_existing_foreign_target_is_refused(self):
        self.target.mkdir()
        (self.target / "foreign").write_text("keep")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.plan()
        self.assertEqual((self.target / "foreign").read_text(), "keep")

    def test_exact_plan_digest_is_required(self):
        self.plan()
        with self.assertRaisesRegex(ValueError, "digest changed"):
            relocation.load_plan(self.plan_file, "0" * 64)

    def test_stage_defers_sqlite_offline_copy_preserves_dirty_and_links(self):
        (self.source / "dirty.txt").write_bytes(b"uncommitted\r\n")
        (self.source / "untracked.txt").write_bytes(b"useful WIP")
        os.link(self.source / "dirty.txt", self.source / "hardlink.txt")
        db = sqlite3.connect(self.source / "journal.sqlite")
        db.execute("CREATE TABLE preserved(v)")
        db.execute("INSERT INTO preserved VALUES('original identity')")
        db.commit()
        db.close()
        plan = self.plan()
        relocation.copy_roots(plan)
        self.assertFalse((self.target / "journal.sqlite").exists())
        self.assertEqual((self.target / "untracked.txt").read_bytes(), b"useful WIP")
        relocation.copy_roots(plan, offline=True)
        self.assertEqual(
            relocation.info(self.target / "dirty.txt")["ino"],
            relocation.info(self.target / "hardlink.txt")["ino"],
        )
        self.assertEqual(relocation.validate_databases(plan)["databases_checked"], 1)
        db = sqlite3.connect(self.target / "journal.sqlite")
        self.assertEqual(
            db.execute("SELECT v FROM preserved").fetchone()[0], "original identity"
        )
        db.close()

    def test_wrong_destination_link_is_not_followed(self):
        (self.source / "directory").mkdir()
        (self.source / "directory/file").write_text("source")
        plan = self.plan()
        relocation.ensure_destination(plan, 0)
        foreign = self.temp / "foreign"
        foreign.mkdir()
        relocation.make_link(str(foreign), self.target / "directory", 0xA0000003, True)
        with self.assertRaisesRegex(ValueError, "reparse"):
            relocation.copy_roots(plan, offline=True)
        self.assertEqual(list(foreign.iterdir()), [])

    def test_pre_start_switch_can_rollback_without_data_loss(self):
        (self.source / "file").write_text("original")
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        relocation.validate_databases(plan)
        relocation.switch_roots(plan)
        self.assertTrue(relocation.reparse(self.source))
        self.assertEqual((self.source / "file").read_text(), "original")
        relocation.rollback_roots(plan)
        self.assertFalse(relocation.reparse(self.source))
        self.assertEqual((self.source / "file").read_text(), "original")
        self.assertEqual((self.target / "file").read_text(), "original")

    def test_after_start_admission_automatic_rollback_is_forbidden(self):
        (self.source / "file").write_text("original")
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        relocation.validate_databases(plan)
        relocation.switch_roots(plan)
        relocation.admit_start(plan)
        (self.target / "file").write_text("new runtime write")
        with self.assertRaisesRegex(ValueError, "pre-start"):
            relocation.rollback_roots(plan)
        self.assertEqual((self.source / "file").read_text(), "new runtime write")

    @unittest.skipUnless(os.name == "nt", "Windows handle deletion")
    def test_same_handle_checksum_prevents_changed_file_deletion(self):
        file = self.source / "file"
        file.write_bytes(b"original")
        before = relocation.info(file)
        with self.assertRaisesRegex(ValueError, "checksum"):
            relocation.delete_verified_file(file, before, "0" * 64)
        self.assertEqual(file.read_bytes(), b"original")
        relocation.delete_verified_file(file, before, relocation.digest(file))
        self.assertFalse(file.exists())

    @unittest.skipUnless(os.name == "nt", "Windows CopyFile named streams")
    def test_copy_preserves_named_stream(self):
        file = self.source / "file"
        file.write_bytes(b"body")
        with open(str(file) + ":test-metadata", "wb") as f:
            f.write(b"named stream")
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        with open(str(self.target / "file") + ":test-metadata", "rb") as f:
            self.assertEqual(f.read(), b"named stream")

    @unittest.skipUnless(os.name == "nt", "Windows directory streams")
    def test_directory_streams_fail_closed_before_verified_including_root(self):
        for directory in (self.source, self.source / "nested"):
            directory.mkdir(exist_ok=True)
            with open(str(directory) + ":valuable", "wb") as stream:
                stream.write(b"directory user data")
        plan = self.plan()
        with self.assertRaisesRegex(ValueError, "directory data streams"):
            relocation.copy_roots(plan, offline=True)
        with self.assertRaisesRegex(ValueError, "Offline verified"):
            relocation.validate_databases(plan)
        for directory in (self.source, self.source / "nested"):
            with open(str(directory) + ":valuable", "rb") as stream:
                self.assertEqual(stream.read(), b"directory user data")
        with self.assertRaisesRegex(ValueError, "verified transfer"):
            relocation.switch_roots(plan)

    @unittest.skipUnless(os.name == "nt", "Windows directory handle")
    def test_directory_delete_handle_denies_late_stream_write(self):
        directory = self.source / "empty"
        directory.mkdir()
        original_streams = relocation.named_streams

        def attempt_write(value):
            with self.assertRaises(OSError):
                with open(str(value) + ":late", "wb") as stream:
                    stream.write(b"must not be lost")
            return original_streams(value)

        with patch.object(relocation, "named_streams", side_effect=attempt_write):
            relocation.delete_verified_file(
                directory, relocation.info(directory), None, directory=True
            )
        self.assertFalse(directory.exists())

    @unittest.skipUnless(os.name == "nt", "Windows no-follow stream metadata")
    def test_junction_stream_query_and_pruning_never_follow_foreign_target(self):
        foreign = self.temp / "foreign"
        foreign.mkdir()
        (foreign / "valuable").write_bytes(b"keep foreign body")
        with open(str(foreign) + ":valuable", "wb") as stream:
            stream.write(b"keep foreign stream")
        relocation.make_link(str(foreign), self.source / "link", 0xA0000003, True)
        self.assertEqual(relocation.named_streams(self.source / "link"), [])
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        relocation.validate_databases(plan)
        relocation.switch_roots(plan)
        db = relocation.connect(plan["manifest"])
        relocation.set_phase(db, "accepted")
        db.close()
        relocation.prune_originals(plan)
        self.assertEqual((foreign / "valuable").read_bytes(), b"keep foreign body")
        with open(str(foreign) + ":valuable", "rb") as stream:
            self.assertEqual(stream.read(), b"keep foreign stream")

    @unittest.skipUnless(os.name == "nt", "Windows directory stream late mutation")
    def test_directory_stream_added_after_verification_blocks_switch(self):
        (self.source / "file").write_bytes(b"keep")
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        relocation.validate_databases(plan)
        with open(str(self.source) + ":late", "wb") as stream:
            stream.write(b"valuable late stream")
        with self.assertRaisesRegex(ValueError, "directory data streams"):
            relocation.switch_roots(plan)
        self.assertFalse(self.source.is_junction())
        self.assertFalse(Path(plan["roots"][0]["original"]).exists())
        with open(str(self.source) + ":late", "rb") as stream:
            self.assertEqual(stream.read(), b"valuable late stream")

    def test_final_copy_reconciles_updated_hardlinks_and_write_through(self):
        a, b = self.source / "a", self.source / "b"
        a.write_bytes(b"before")
        os.link(a, b)
        plan = self.plan()
        relocation.copy_roots(plan)
        a.write_bytes(b"updated after stage")
        relocation.copy_roots(plan, offline=True)
        self.assertEqual(
            relocation.info(self.target / "a")["ino"],
            relocation.info(self.target / "b")["ino"],
        )
        (self.target / "a").write_bytes(b"write through")
        self.assertEqual((self.target / "b").read_bytes(), b"write through")
        self.assertEqual(a.read_bytes(), b"updated after stage")

    def test_foreign_modified_hardlink_destination_is_preserved_and_refused(self):
        a, b = self.source / "a", self.source / "b"
        a.write_bytes(b"before")
        os.link(a, b)
        plan = self.plan()
        relocation.copy_roots(plan)
        a.write_bytes(b"source update")
        (self.target / "b").write_bytes(b"foreign useful WIP")
        with self.assertRaisesRegex(ValueError, "destination contents changed"):
            relocation.copy_roots(plan, offline=True)
        self.assertEqual((self.target / "a").read_bytes(), b"foreign useful WIP")
        self.assertEqual(a.read_bytes(), b"source update")

    @unittest.skipUnless(os.name == "nt", "Windows read-only hardlink recovery")
    def test_interrupted_readonly_hardlink_replacement_resumes_owned_temporary(self):
        a, b = self.source / "a", self.source / "b"
        a.write_bytes(b"before")
        os.link(a, b)
        plan = self.plan()
        relocation.copy_roots(plan)
        a.write_bytes(b"updated after stage")
        os.chmod(self.target / "b", 0o444)
        original_replace = os.replace

        def interrupted(source, target):
            if ".relocation-hardlink-" in str(source):
                raise OSError("injected link-rename interruption")
            return original_replace(source, target)

        with patch.object(relocation.os, "replace", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "link-rename"):
                relocation.copy_roots(plan, offline=True)
        self.assertEqual(a.read_bytes(), b"updated after stage")
        relocation.copy_roots(plan, offline=True)
        self.assertEqual(
            relocation.info(self.target / "a")["ino"],
            relocation.info(self.target / "b")["ino"],
        )
        self.assertEqual((self.target / "b").read_bytes(), b"updated after stage")
        self.assertFalse(list(self.target.glob("*.relocation-hardlink-*")))

    def test_failure_does_not_claim_verified_or_delete_sources(self):
        file = self.source / "file"
        file.write_bytes(b"original")
        plan = self.plan()
        with patch.object(
            relocation, "copy_file", side_effect=OSError("injected copy failure")
        ):
            with self.assertRaisesRegex(OSError, "injected"):
                relocation.copy_roots(plan, offline=True)
        db = relocation.connect(plan["manifest"])
        self.assertEqual(relocation.phase(db), "planned")
        db.close()
        self.assertEqual(file.read_bytes(), b"original")
        relocation.copy_roots(plan, offline=True)
        self.assertEqual((self.target / "file").read_bytes(), b"original")

    @unittest.skipUnless(os.name == "nt", "Windows source pruning")
    def test_accepted_runtime_prunes_only_verified_originals_and_keeps_new_writes(self):
        (self.source / "file").write_text("original")
        (self.source / "nested").mkdir()
        (self.source / "nested/dirty").write_bytes(b"dirty")
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        relocation.validate_databases(plan)
        relocation.switch_roots(plan)
        relocation.admit_start(plan)
        proof = self.temp / "runtime-proof.json"
        proof.write_text(
            json.dumps(
                {
                    "operation": plan["operation"],
                    "runtime_verified": True,
                    "physical_runtime_root": str(self.target),
                    "logical_runtime_root": str(self.source),
                    "release": "fixture-release",
                    "node_pid": 1,
                    "host_pid": 2,
                    "history": True,
                    "attachments": True,
                    "mcp": True,
                    "queue_recovery": True,
                    "readonly_legacy_ipc": True,
                    "physical_file_handles": True,
                }
            )
        )
        relocation.accept_started(plan, proof)
        (self.target / "new-runtime-file").write_text("new")
        result = relocation.prune_originals(plan)
        self.assertEqual(result["phase"], "completed")
        self.assertFalse(Path(plan["roots"][0]["original"]).exists())
        self.assertEqual((self.source / "nested/dirty").read_bytes(), b"dirty")
        self.assertEqual((self.source / "new-runtime-file").read_text(), "new")

    @unittest.skipUnless(os.name == "nt", "Windows directory stream late mutation")
    def test_late_original_directory_stream_blocks_prune_before_any_deletion(self):
        (self.source / "valuable-file").write_bytes(b"keep")
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        relocation.validate_databases(plan)
        relocation.switch_roots(plan)
        # Fixture-only operator acceptance isolates the pruning boundary.
        db = relocation.connect(plan["manifest"])
        relocation.set_phase(db, "accepted")
        db.close()
        original = Path(plan["roots"][0]["original"])
        with open(str(original) + ":late", "wb") as stream:
            stream.write(b"late useful data")
        with self.assertRaisesRegex(ValueError, "directory data streams"):
            relocation.prune_originals(plan)
        self.assertEqual((original / "valuable-file").read_bytes(), b"keep")
        with open(str(original) + ":late", "rb") as stream:
            self.assertEqual(stream.read(), b"late useful data")

    def test_switch_is_refused_before_database_validation(self):
        (self.source / "file").write_text("original")
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        with self.assertRaisesRegex(ValueError, "verified transfer"):
            relocation.switch_roots(plan)

    def test_writer_reappearance_does_not_admit_switch_and_copy_can_resume(self):
        (self.source / "file").write_text("original")
        plan = self.plan()
        with patch.object(
            relocation,
            "assert_no_source_processes",
            side_effect=ValueError("writer returned"),
        ):
            with self.assertRaisesRegex(ValueError, "writer returned"):
                relocation.copy_roots(plan, offline=True)
        with self.assertRaisesRegex(ValueError, "Offline verified"):
            relocation.validate_databases(plan)
        relocation.copy_roots(plan, offline=True)
        self.assertEqual(relocation.validate_databases(plan)["databases_checked"], 0)

    def test_departed_staged_file_is_retained_but_not_current(self):
        old = self.source / "old.txt"
        old.write_text("old useful evidence")
        plan = self.plan()
        relocation.copy_roots(plan)
        old.unlink()
        (self.source / "new.txt").write_text("current")
        relocation.copy_roots(plan, offline=True)
        self.assertFalse((self.target / "old.txt").exists())
        self.assertEqual((self.target / "new.txt").read_text(), "current")
        db = relocation.connect(plan["manifest"])
        retained = db.execute(
            "SELECT quarantine FROM departed WHERE rel='old.txt'"
        ).fetchone()[0]
        db.close()
        self.assertEqual(Path(retained).read_text(), "old useful evidence")

    def test_critical_invalid_db_blocks_switch_retained_fixture_failure_is_explicit(
        self,
    ):
        broken = b"SQLite format 3\x00" + b"invalid" * 100
        (self.source / "fixture.sqlite").write_bytes(broken)
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        relocation.validate_databases(plan)
        report = json.loads(
            Path(plan["manifest"]).with_suffix(".integrity.json").read_text()
        )
        self.assertEqual(report["databases"][0]["integrity"], "failed")
        self.assertFalse(report["databases"][0]["critical"])
        # A current data DB is a required recovery invariant.
        db = relocation.connect(plan["manifest"])
        relocation.set_phase(db, "staged")
        db.close()
        (self.source / "data").mkdir()
        (self.source / "data/journal.sqlite").write_bytes(broken)
        relocation.copy_roots(plan, offline=True)
        with self.assertRaisesRegex(ValueError, "Critical"):
            relocation.validate_databases(plan)
        with self.assertRaisesRegex(ValueError, "verified transfer"):
            relocation.switch_roots(plan)

    def test_preview_extension_preserves_operation_and_empty_spool_alias_rolls_back(
        self,
    ):
        plan = self.plan()
        other = self.temp / "other-source"
        other.mkdir()
        (other / "saved").write_text("keep")
        spool = self.temp / "old-spool"
        result = relocation.extend_plan(
            self.plan_file,
            relocation.digest(self.plan_file),
            [(other, self.target / "external")],
            [(spool, self.target / "temp/spool")],
        )
        extended = relocation.load_plan(self.plan_file, result["plan_sha256"])
        self.assertEqual(plan["operation"], extended["operation"])
        relocation.copy_roots(extended, offline=True)
        relocation.validate_databases(extended)
        relocation.switch_roots(extended)
        self.assertTrue(spool.is_junction())
        self.assertEqual((other / "saved").read_text(), "keep")
        relocation.rollback_roots(extended)
        self.assertFalse(spool.exists())
        self.assertFalse(other.is_junction())

    @unittest.skipUnless(os.name == "nt", "Windows named streams")
    def test_named_stream_mutation_blocks_original_deletion(self):
        file = self.source / "file"
        file.write_bytes(b"body")
        with open(str(file) + ":metadata", "wb") as stream:
            stream.write(b"original")
        expected = relocation.content_digest(file)
        before = relocation.info(file)
        with open(str(file) + ":metadata", "wb") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            relocation.delete_verified_file(file, before, expected)
        self.assertTrue(file.exists())

    def test_long_paths_are_copied_without_truncation(self):
        deep = self.source
        for _ in range(8):
            deep = deep / ("long-directory-" + "x" * 32)
        os.makedirs(relocation.long_path(deep))
        file = deep / "file.txt"
        with open(relocation.long_path(file), "wb") as f:
            f.write(b"exact long path")
        plan = self.plan()
        relocation.copy_roots(plan, offline=True)
        copied = self.target / file.relative_to(self.source)
        with open(relocation.long_path(copied), "rb") as f:
            self.assertEqual(f.read(), b"exact long path")

    @unittest.skipUnless(os.name == "nt", "Windows held process identity")
    def test_process_identity_mismatch_refuses_before_stop_and_exact_handle_stops_fixture(
        self,
    ):
        plan = self.plan()
        job_proof = self.source / "independent.json"
        command = subprocess.list2cmdline(
            [
                str(Path(sys.executable).with_name("pythonw.exe")),
                "-c",
                "import ctypes as c,json,time; from pathlib import Path; k=c.WinDLL('kernel32'); v=c.c_int(); ok=k.IsProcessInJob(c.c_void_p(-1),None,c.byref(v)); Path("
                + repr(str(job_proof))
                + ").write_text(json.dumps({'in_job':v.value,'query_ok':ok})); time.sleep(30)",
                str(self.source / "fixture"),
            ]
        )
        script = (
            "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='"
            + command.replace("'", "''")
            + "';CurrentDirectory='"
            + str(self.temp).replace("'", "''")
            + "'} | Select-Object ProcessId,ReturnValue | ConvertTo-Json -Compress"
        )
        result = subprocess.run(
            [
                str(
                    Path(os.environ["SystemRoot"])
                    / "System32/WindowsPowerShell/v1.0/powershell.exe"
                ),
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                base64.b64encode(script.encode("utf-16le")).decode(),
            ],
            check=True,
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        created = json.loads(result.stdout)
        self.assertEqual(created["ReturnValue"], 0)
        pid = created["ProcessId"]
        row = next(r for r in process_custody.process_snapshot() if r["pid"] == pid)
        cleanup_handle = process_custody.HeldProcess(row)
        try:
            proof_value = json.loads(job_proof.read_text())
            self.assertEqual(proof_value, {"in_job": 0, "query_ok": 1})
            process_file = self.temp / "processes.json"
            process_custody.capture(plan, process_file)
            captured = json.loads(process_file.read_text())
            expected = next(r for r in captured["processes"] if r["pid"] == pid)
            with self.assertRaisesRegex(ValueError, "creation identity"):
                process_custody.HeldProcess(
                    {**expected, "created": str(int(expected["created"]) + 10_000_000)}
                )
            self.assertEqual(
                cleanup_handle.kernel.WaitForSingleObject(cleanup_handle.handle, 0), 258
            )
            proof = self.temp / "saved.json"
            proof.write_text(
                json.dumps(
                    {
                        "operation": plan["operation"],
                        "all_streams_saved_stopped": True,
                        "streams": ["fixture"],
                        "durable_readback_sha256": "0" * 64,
                        "checked_at": time.time(),
                    }
                )
            )
            result = process_custody.stop(
                plan,
                process_file,
                relocation.digest(process_file),
                proof,
                self.temp / "stopped.json",
            )
            self.assertTrue(result["all_writers_stopped"])
            self.assertEqual(
                cleanup_handle.kernel.WaitForSingleObject(cleanup_handle.handle, 5000),
                0,
            )
        finally:
            cleanup_handle.stop()
            cleanup_handle.close()

    def test_observer_subtree_is_never_part_of_the_stop_set(self):
        own = {
            "pid": os.getpid(),
            "parent": 1,
            "name": "python.exe",
            "executable": str(self.source / "python.exe"),
            "command": "",
            "created": "2",
        }
        child = {**own, "pid": 987654, "parent": os.getpid(), "created": "3"}
        parent = {**own, "pid": 1, "parent": 0, "created": "1"}
        self.assertEqual(
            [
                r["pid"]
                for r in process_custody.owned_processes(
                    [parent, own, child], [str(self.source)]
                )
            ],
            [1],
        )

    def test_foreign_editor_is_not_owned_because_it_mentions_a_hub_path(self):
        row = {
            "pid": 123456,
            "parent": 0,
            "name": "Code.exe",
            "executable": "C:/Program Files/Code/Code.exe",
            "command": 'Code.exe "' + str(self.source / "file") + '"',
            "created": "1",
        }
        self.assertEqual(process_custody.owned_processes([row], [str(self.source)]), [])

    def test_terminal_row_alone_is_not_quiescence_and_queued_input_is_preserved(self):
        (self.source / "data").mkdir()
        db = sqlite3.connect(self.source / "data/runtime.sqlite")
        db.executescript(
            "CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value_json TEXT); CREATE TABLE provider_run_terminals(provider TEXT,thread_id TEXT,turn_id TEXT,status TEXT,committed_at TEXT);"
        )
        identity = {"provider": "codex", "thread_id": "thread", "turn_id": "exact-arm"}
        state = {
            "activeRuns": [
                {"provider": "codex", "threadId": "thread", "turnId": "exact-arm"}
            ],
            "queuedInputs": [{"id": "original-queued"}],
            "pendingInputs": [{"id": "original-unknown"}],
        }
        db.execute("INSERT INTO runtime_state VALUES('main',?)", (json.dumps(state),))
        db.execute(
            "INSERT INTO provider_run_terminals VALUES('codex','thread','exact-arm','completed','2026-10-19T00:00:00Z')"
        )
        db.commit()
        self.assertIsNone(cutover.terminal_barrier(self.source, [identity]))
        state["activeRuns"] = []
        db.execute("UPDATE runtime_state SET value_json=?", (json.dumps(state),))
        db.commit()
        result = cutover.terminal_barrier(self.source, [identity])
        self.assertEqual(result["queued_ids"], ["original-queued"])
        self.assertEqual(result["pending_ids"], ["original-unknown"])
        self.assertEqual(
            json.loads(
                db.execute("SELECT value_json FROM runtime_state").fetchone()[0]
            ),
            state,
        )
        self.assertIsNone(
            cutover.terminal_barrier(
                self.source, [{**identity, "turn_id": "other-turn"}]
            )
        )
        db.close()


if __name__ == "__main__":
    unittest.main()
