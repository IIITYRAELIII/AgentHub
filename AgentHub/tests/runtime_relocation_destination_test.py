"""Windows root initialization/custody behavior. Disposable explicitly selected drive only."""

import ctypes as c
from ctypes import wintypes as w
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
import runtime_relocation_process as processes


@unittest.skipUnless(os.name == "nt", "Windows directory custody")
class DestinationTest(unittest.TestCase):
    def setUp(self):
        selected = os.environ.get("AGENT_HUB_TEST_TMP")
        if not selected:
            self.skipTest("Set AGENT_HUB_TEST_TMP to a disposable fixture volume")
        self.parent = relocation.plain_directory(selected)
        self.temp = Path(
            tempfile.mkdtemp(prefix="hub143-destination-", dir=self.parent)
        )
        self.source, self.target = self.temp / "source", self.temp / "target"
        self.source.mkdir()
        self.plan_file = self.temp / "plan.json"
        self.aliases = []

    def tearDown(self):
        for alias in self.aliases:
            if os.path.lexists(alias) and relocation.reparse(alias):
                os.rmdir(alias)
        if (
            self.temp.parent.resolve() != self.parent.resolve()
            or not self.temp.name.startswith("hub143-destination-")
        ):
            raise ValueError("Fixture cleanup escaped selected root")
        shutil.rmtree(relocation.long_path(self.temp))

    def plan(self, mappings=None):
        relocation.create_plan(self.plan_file, mappings or [(self.source, self.target)])
        self.plan_sha = relocation.digest(self.plan_file)
        self.value = relocation.load_plan(self.plan_file, self.plan_sha)
        return self.value

    def receipt(self, index=0):
        return self.temp / f"root-init-{self.value['operation']}-{index}.json"

    def fail_marker(self):
        real = relocation.write_json

        def failing(path, value):
            if Path(path).name == ".agent-hub-relocation-owner.json":
                # A real Windows FileNotFoundError before any marker write.
                with (self.temp / "absent" / "file").open("rb"):
                    pass
            return real(path, value)

        with patch.object(relocation, "write_json", failing):
            with self.assertRaises(FileNotFoundError):
                relocation.ensure_destination(self.value, 0)
        return json.loads(self.receipt().read_text(encoding="utf-8"))

    def preview(self, index=0, quarantine=None):
        self.preview_file = self.temp / "preview.json"
        self.quarantine = quarantine or self.temp / "retained-unowned"
        value = relocation.preview_unowned_root(
            self.plan_file, self.plan_sha, index, self.quarantine, self.preview_file
        )
        self.preview_sha = relocation.digest(self.preview_file)
        return value

    def confirm(self):
        # Isolated control boundary; filesystem IDs, ACL and rename are REAL.
        with patch.object(processes, "process_snapshot", return_value=[]):
            return relocation.custody_unowned_root(
                self.plan_file, self.plan_sha, self.preview_file, self.preview_sha
            )

    def test_initializer_is_independent_of_failing_acl_child_process(self):
        plan = self.plan()
        real_run, failures = subprocess.run, []

        def injected_native_child_status(command, *args, **kwargs):
            if str(command[0]).lower() != "icacls":
                return real_run(command, *args, **kwargs)
            # A real own process exit with the historical code, NOT a claim
            # that the historical DLL loader failure has been reproduced.
            result = real_run(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    "import ctypes,sys; print('injected-status-out',flush=True); "
                    "print('injected-status-err',file=sys.stderr,flush=True); "
                    "ctypes.WinDLL('kernel32').ExitProcess(0xC0000142)",
                ],
                capture_output=True,
            )
            failures.append(result.returncode)
            raise subprocess.CalledProcessError(
                result.returncode, command, result.stdout, result.stderr
            )

        try:
            with patch.object(subprocess, "run", injected_native_child_status):
                relocation.ensure_destination(plan, 0)
        finally:
            print(
                json.dumps(
                    {
                        "injected_acl_process_status": failures,
                        "target_exists": self.target.exists(),
                        "marker_exists": (
                            self.target / ".agent-hub-relocation-owner.json"
                        ).exists(),
                    }
                ),
                flush=True,
            )
        self.assertEqual(failures, [])
        with relocation.held_root_directory(self.target, delete=False) as held:
            self.assertTrue(
                relocation.private_root_acl_matches(relocation.root_directory_acl(held))
            )
        receipt = json.loads(self.receipt().read_text())
        self.assertEqual(receipt["phase"], "published")
        self.assertEqual(
            receipt["identity"]["ino"], relocation.info(self.target)["ino"]
        )

    def test_failed_marker_keeps_target_absent_and_exact_created_stage_resumes(self):
        self.plan()
        failed = self.fail_marker()
        self.assertEqual(failed["phase"], "failed")
        self.assertEqual(failed["error"]["type"], "FileNotFoundError")
        self.assertEqual(failed["error"]["errno"], 2)
        self.assertFalse(self.target.exists())
        stage = Path(failed["stage"])
        self.assertEqual(list(stage.iterdir()), [])
        identity = relocation.info(stage)
        relocation.ensure_destination(self.value, 0)
        self.assertEqual(relocation.info(self.target)["ino"], identity["ino"])
        self.assertFalse(stage.exists())
        relocation.ensure_destination(self.value, 0)

    def test_genuine_rename_access_denied_is_saved_and_marker_ready_stage_resumes(self):
        self.plan()
        real_publish = relocation.publish_root_directory

        def query_only_publish(descriptor, target, parent):
            import msvcrt

            stage = Path(json.loads(self.receipt().read_text())["stage"])
            kernel = c.WinDLL("kernel32", use_last_error=True)
            kernel.CreateFileW.argtypes = [
                w.LPCWSTR,
                w.DWORD,
                w.DWORD,
                c.c_void_p,
                w.DWORD,
                w.DWORD,
                w.HANDLE,
            ]
            kernel.CreateFileW.restype = w.HANDLE
            handle = kernel.CreateFileW(str(stage), 0x80, 7, None, 3, 0x02200000, None)
            self.assertNotEqual(handle, c.c_void_p(-1).value)
            query = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            try:
                return real_publish(query, target, parent)
            finally:
                os.close(query)

        with patch.object(relocation, "publish_root_directory", query_only_publish):
            with self.assertRaises(OSError) as caught:
                relocation.ensure_destination(self.value, 0)
        self.assertEqual(caught.exception.winerror, 5)
        failed = json.loads(self.receipt().read_text())
        self.assertEqual(failed["error"]["winerror"], 5)
        self.assertIsNotNone(failed["error"]["ntstatus"])
        self.assertFalse(self.target.exists())
        identity = relocation.info(failed["stage"])
        relocation.ensure_destination(self.value, 0)
        self.assertEqual(relocation.info(self.target)["ino"], identity["ino"])

    def test_unknown_empty_and_nonempty_destinations_are_preserved(self):
        self.plan()
        self.target.mkdir()
        identity = relocation.info(self.target)
        for content in (False, True):
            if content:
                (self.target / "foreign").write_bytes(b"preserve")
            with self.assertRaisesRegex(ValueError, "Unowned destination"):
                relocation.ensure_destination(self.value, 0)
            self.assertEqual(relocation.info(self.target)["ino"], identity["ino"])
            self.assertFalse(self.receipt().exists())
        self.assertEqual((self.target / "foreign").read_bytes(), b"preserve")

    def test_created_stage_substitution_and_unknown_children_are_refused(self):
        self.plan()
        failed = self.fail_marker()
        stage = Path(failed["stage"])
        (stage / "foreign").write_bytes(b"retain")
        with self.assertRaisesRegex(ValueError, "Unknown root initialization child"):
            relocation.ensure_destination(self.value, 0)
        self.assertEqual((stage / "foreign").read_bytes(), b"retain")
        retained = stage.with_name("retained-stage")
        stage.rename(retained)
        stage.mkdir()
        with self.assertRaisesRegex(ValueError, "native directory identity"):
            relocation.ensure_destination(self.value, 0)
        self.assertEqual((retained / "foreign").read_bytes(), b"retain")
        self.assertFalse(self.target.exists())

    def test_late_directory_ads_refuses_publication_and_preserves_stream(self):
        self.plan()
        real_write = relocation.write_json

        def late(path, value):
            real_write(path, value)
            if Path(path) == self.receipt() and value["phase"] == "marker_ready":
                kernel = c.WinDLL("kernel32", use_last_error=True)
                kernel.CreateFileW.argtypes = [
                    w.LPCWSTR,
                    w.DWORD,
                    w.DWORD,
                    c.c_void_p,
                    w.DWORD,
                    w.DWORD,
                    w.HANDLE,
                ]
                kernel.CreateFileW.restype = w.HANDLE
                kernel.WriteFile.argtypes = [
                    w.HANDLE,
                    c.c_void_p,
                    w.DWORD,
                    c.c_void_p,
                    c.c_void_p,
                ]
                kernel.CloseHandle.argtypes = [w.HANDLE]
                handle = kernel.CreateFileW(
                    value["stage"] + ":retained",
                    0x40000000,
                    7,
                    None,
                    2,
                    0x02000000,
                    None,
                )
                self.assertNotEqual(handle, c.c_void_p(-1).value)
                written = w.DWORD()
                try:
                    self.assertTrue(
                        kernel.WriteFile(
                            handle, b"directory ADS", 13, c.byref(written), None
                        )
                    )
                    self.assertEqual(written.value, 13)
                finally:
                    kernel.CloseHandle(handle)

        with patch.object(relocation, "write_json", late):
            with self.assertRaisesRegex(ValueError, "directory data streams"):
                relocation.ensure_destination(self.value, 0)
        failed = json.loads(self.receipt().read_text())
        self.assertFalse(self.target.exists())
        self.assertEqual(
            Path(failed["stage"] + ":retained").read_bytes(), b"directory ADS"
        )

    def test_parent_junction_refuses_before_creating_foreign_child(self):
        foreign = self.temp / "foreign"
        foreign.mkdir()
        alias = self.temp / "alias"
        self.target = alias / "new-parent" / "target"
        self.plan()
        self.aliases.append(alias)
        relocation.make_link(str(foreign), alias, 0xA0000003, True)
        with self.assertRaisesRegex(ValueError, "reparse"):
            relocation.ensure_destination(self.value, 0)
        self.assertEqual(list(foreign.iterdir()), [])

    def test_publication_collision_preserves_foreign_empty_directory(self):
        self.plan()
        real_publish = relocation.publish_root_directory
        foreign = []

        def collide(descriptor, target, parent):
            Path(target).mkdir()
            foreign.append(relocation.info(target))
            return real_publish(descriptor, target, parent)

        with patch.object(relocation, "publish_root_directory", collide):
            with self.assertRaises(OSError):
                relocation.ensure_destination(self.value, 0)
        self.assertEqual(relocation.info(self.target)["ino"], foreign[0]["ino"])
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertTrue(Path(json.loads(self.receipt().read_text())["stage"]).is_dir())

    def test_explicit_unproven_custody_preserves_identity_and_manifest_then_reuses_cache(
        self,
    ):
        second = self.temp / "second"
        second.mkdir()
        target2 = self.temp / "target2"
        (self.source / "cached.bin").write_bytes(b"unchanged cached bytes")
        (second / "dirty.txt").write_bytes(b"dirty\r\n")
        database = sqlite3.connect(second / "journal.sqlite")
        try:
            database.execute("CREATE TABLE retained(v)")
            database.execute("INSERT INTO retained VALUES('original')")
            database.commit()
        finally:
            database.close()
        self.plan([(self.source, self.target), (second, target2)])
        target2.mkdir()
        with self.assertRaisesRegex(ValueError, "Unowned destination"):
            relocation.copy_roots(self.value)
        cached_id = relocation.info(self.target / "cached.bin")["ino"]
        self.preview(index=1)
        old_id = relocation.info(target2)["ino"]
        manifest_hash = relocation.digest(self.value["manifest"])
        result = self.confirm()
        self.assertEqual(result["ownership"], "UNPROVEN")
        self.assertEqual(result["phase"], "completed")
        self.assertEqual(relocation.info(self.quarantine)["ino"], old_id)
        self.assertEqual(relocation.digest(self.value["manifest"]), manifest_hash)
        self.assertTrue(self.confirm()["resumed"])
        # Root-only preparation before the next offline window copies NO source.
        for index in range(2):
            relocation.ensure_destination(self.value, index)
        self.assertEqual(relocation.digest(self.value["manifest"]), manifest_hash)
        self.assertFalse((target2 / "dirty.txt").exists())
        relocation.copy_roots(self.value, offline=True)
        self.assertEqual(relocation.info(self.target / "cached.bin")["ino"], cached_id)
        self.assertEqual((target2 / "dirty.txt").read_bytes(), b"dirty\r\n")
        self.assertEqual(
            relocation.validate_databases(self.value)["databases_checked"], 1
        )
        self.assertEqual(relocation.info(self.quarantine)["ino"], old_id)
        with self.assertRaisesRegex(ValueError, "pre-copy recovery"):
            self.confirm()

    def test_custody_intent_precedes_rename_and_interrupted_readback_resumes(self):
        self.plan()
        self.target.mkdir()
        self.preview()
        real_publish = relocation.publish_root_directory
        receipt_file = (
            self.temp / f"unowned-root-custody-{self.value['operation']}-0.json"
        )

        def interrupted(descriptor, target, parent):
            record = json.loads(receipt_file.read_text())
            self.assertEqual(record["phase"], "intent")
            self.assertEqual(
                record["identity"]["ino"], relocation.info(self.target)["ino"]
            )
            real_publish(descriptor, target, parent)
            raise RuntimeError("injected interruption after actual rename")

        with patch.object(relocation, "publish_root_directory", interrupted):
            with self.assertRaisesRegex(RuntimeError, "interruption"):
                self.confirm()
        self.assertFalse(self.target.exists())
        self.assertTrue(self.quarantine.is_dir())
        self.assertTrue(self.confirm()["resumed"])
        self.target.mkdir()
        (self.target / "foreign").write_bytes(b"new owner")
        with self.assertRaisesRegex(ValueError, "empty directory"):
            self.confirm()
        self.assertEqual((self.target / "foreign").read_bytes(), b"new owner")

    def test_custody_occupied_quarantine_and_changed_id_refuse(self):
        self.plan()
        self.target.mkdir()
        self.preview()
        self.quarantine.mkdir()
        (self.quarantine / "foreign").write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.confirm()
        self.assertEqual((self.quarantine / "foreign").read_bytes(), b"keep")
        self.quarantine.rename(self.temp / "other-evidence")
        self.target.rename(self.temp / "original-unowned")
        self.target.mkdir()
        with self.assertRaisesRegex(ValueError, "exact preview changed"):
            self.confirm()
        self.assertEqual(list(self.target.iterdir()), [])

    def test_custody_nonempty_or_ads_drift_preserves_target(self):
        self.plan()
        self.target.mkdir()
        self.preview()
        (self.target / "foreign").write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "empty directory"):
            self.confirm()
        (self.target / "foreign").unlink()  # Only this test's own sentinel.
        Path(str(self.target) + ":foreign").write_bytes(b"stream")
        with self.assertRaisesRegex(ValueError, "directory data streams"):
            self.confirm()
        self.assertEqual(Path(str(self.target) + ":foreign").read_bytes(), b"stream")

    def test_custody_resume_refuses_quarantine_parent_junction(self):
        self.plan()
        self.target.mkdir()
        parent = self.temp / "evidence"
        parent.mkdir()
        self.preview(quarantine=parent / "retained")
        self.confirm()
        retained = self.temp / "moved-evidence"
        parent.rename(retained)
        relocation.make_link(str(retained), parent, 0xA0000003, True)
        self.aliases.append(parent)
        with self.assertRaisesRegex(ValueError, "reparse"):
            self.confirm()
        self.assertTrue((retained / "retained").is_dir())

    def test_copy_worker_and_unknown_python_refuse_before_custody(self):
        self.plan()
        self.target.mkdir()
        self.preview()
        for command in (
            'python runtime_relocation.py "stage" --plan x',
            "python runtime_relocation_cutover.py --config x",
            None,
        ):
            row = {
                "pid": 0xFFFFFFF,
                "parent": 1,
                "created": "1",
                "name": "python.exe",
                "command": command,
            }
            with patch.object(processes, "process_snapshot", return_value=[row]):
                with self.assertRaisesRegex(ValueError, "copy worker|Unknown Python"):
                    relocation.custody_unowned_root(
                        self.plan_file,
                        self.plan_sha,
                        self.preview_file,
                        self.preview_sha,
                    )
            self.assertTrue(self.target.is_dir())
            self.assertFalse(self.quarantine.exists())

    def test_unknown_stage_has_no_automatic_empty_directory_adoption(self):
        self.plan()
        stage = self.target.parent / f".relocation-root-{self.value['operation']}-0"
        stage.mkdir()
        identity = relocation.info(stage)
        with self.assertRaisesRegex(ValueError, "Unowned root initialization stage"):
            relocation.ensure_destination(self.value, 0)
        self.assertEqual(relocation.info(stage)["ino"], identity["ino"])
        self.assertEqual(list(stage.iterdir()), [])
        self.assertFalse(self.receipt().exists())

    def test_actual_extra_acl_grant_refuses_without_changing_owned_payload(self):
        self.plan()
        widened = relocation.private_root_sddl() + "(A;OICI;GR;;;WD)"
        with patch.object(relocation, "private_root_sddl", return_value=widened):
            with relocation.held_root_directory(self.target, create=True):
                pass
        relocation.write_json(
            self.target / ".agent-hub-relocation-owner.json",
            {
                "operation": self.value["operation"],
                "source": str(self.source),
                "target": str(self.target),
            },
        )
        (self.target / "existing").write_bytes(b"private payload")
        identity = relocation.info(self.target)
        with self.assertRaisesRegex(ValueError, "private ACL changed"):
            relocation.ensure_destination(self.value, 0)
        self.assertEqual(relocation.info(self.target)["ino"], identity["ino"])
        self.assertEqual((self.target / "existing").read_bytes(), b"private payload")

    def test_failed_native_child_status_and_raw_output_are_preserved_in_receipt(self):
        self.plan()

        def fail(descriptor, target, parent):
            return subprocess.run(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    "import ctypes,sys; print('fault-out',flush=True); "
                    "print('fault-err',file=sys.stderr,flush=True); "
                    "ctypes.WinDLL('kernel32').ExitProcess(0xC0000142)",
                ],
                check=True,
                capture_output=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )

        with patch.object(relocation, "publish_root_directory", fail):
            with self.assertRaises(subprocess.CalledProcessError):
                relocation.ensure_destination(self.value, 0)
        error = json.loads(self.receipt().read_text())["error"]
        self.assertEqual(error["returncode"], 0xC0000142)
        self.assertEqual(bytes.fromhex(error["stdout_hex"]).strip(), b"fault-out")
        self.assertEqual(bytes.fromhex(error["stderr_hex"]).strip(), b"fault-err")
        self.assertIsNone(error["winerror"])
        self.assertFalse(self.target.exists())
        relocation.ensure_destination(self.value, 0)


if __name__ == "__main__":
    unittest.main()
