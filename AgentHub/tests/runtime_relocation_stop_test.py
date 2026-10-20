"""Real Windows process-stop boundaries; only disposable, explicitly rooted fixtures."""

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
import time
import unittest
from unittest.mock import patch

import runtime_relocation as relocation
import runtime_relocation_process as custody


class NativeKernelEdge:
    """Coordinate a real native race or a real denied handle; never synthesize results."""

    def __init__(self, kernel, *, concurrent_exit=False, denied_handle=None):
        self.kernel = kernel
        self.concurrent_exit = concurrent_exit
        self.denied_handle = denied_handle
        self.observed = {}

    def __getattr__(self, name):
        return getattr(self.kernel, name)

    def TerminateProcess(self, handle, code):
        if self.concurrent_exit:
            first = bool(self.kernel.TerminateProcess(handle, code))
            first_error = None if first else c.get_last_error()
            self.observed.update(first_return=first, first_error=first_error)
        result = self.kernel.TerminateProcess(
            self.denied_handle if self.denied_handle is not None else handle, code
        )
        error = None if result else c.get_last_error()
        immediate = self.kernel.WaitForSingleObject(handle, 0)
        self.observed.update(
            terminate_return=bool(result),
            terminate_error=error,
            immediate_wait=immediate,
        )
        if error is not None:
            c.set_last_error(error)  # Preserve the actual failing call's error.
        return result


@unittest.skipUnless(os.name == "nt", "Windows retained process handles")
class RetainedStopTest(unittest.TestCase):
    def setUp(self):
        selected = os.environ.get("AGENT_HUB_TEST_TMP")
        if not selected:
            self.skipTest("Select a disposable fixture volume with AGENT_HUB_TEST_TMP")
        self.parent = relocation.plain_directory(selected)
        self.temp = Path(tempfile.mkdtemp(prefix="hub143-stop-", dir=self.parent))
        self.children = []
        self.held = []

    def tearDown(self):
        for handle in self.held:
            if handle.handle:
                # Only our newly created exact fixture identity, via retained handle.
                handle.stop()
                handle.close()
        for child in self.children:
            child.wait(timeout=10)
            if child.stdout:
                child.stdout.close()
            if child.stderr:
                child.stderr.close()
        if (
            self.temp.parent.resolve() != self.parent.resolve()
            or not self.temp.name.startswith("hub143-stop-")
        ):
            raise ValueError("Fixture cleanup escaped selected parent")
        shutil.rmtree(relocation.long_path(self.temp))

    def child(self, *, threaded=False):
        code = "import time; "
        if threaded:
            code += (
                "import threading; "
                "threads=[threading.Thread(target=time.sleep,args=(90,),daemon=True) "
                "for _ in range(128)]; [t.start() for t in threads]; "
            )
        code += "print('ready',flush=True); time.sleep(90)"
        child = subprocess.Popen(
            [sys.executable, "-X", "utf8", "-B", "-c", code],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW,
            env=dict(os.environ, TEMP=str(self.temp), TMP=str(self.temp)),
        )
        self.children.append(child)
        self.assertEqual(child.stdout.readline().strip(), b"ready")
        kernel = c.WinDLL("kernel32", use_last_error=True)
        kernel.GetProcessTimes.argtypes = [
            w.HANDLE,
            *([c.POINTER(c.c_ulonglong)] * 4),
        ]
        values = [c.c_ulonglong() for _ in range(4)]
        self.assertTrue(
            kernel.GetProcessTimes(
                w.HANDLE(int(child._handle)), *(c.byref(value) for value in values)
            )
        )
        handle = custody.HeldProcess(
            {
                "pid": child.pid,
                "created": str(values[0].value),
                "native_creation": True,
                "executable": sys.executable,
            }
        )
        self.held.append(handle)
        return handle

    def test_actual_pending_exit_access_denied_settles_same_held_object(self):
        handle = self.child(threaded=True)
        kernel = handle.kernel
        edge = NativeKernelEdge(kernel, concurrent_exit=True)
        handle.kernel = edge
        try:
            result = handle.stop()
        finally:
            handle.kernel = kernel
            print(json.dumps({"native_exit_race": edge.observed}), flush=True)
        self.assertEqual(edge.observed["terminate_error"], 5)
        self.assertEqual(edge.observed["immediate_wait"], 258)
        self.assertEqual(result, "exited_held_identity_after_termination_error")
        self.assertEqual(handle.stop_details["settlement_wait"], 0)
        self.assertEqual(handle.stop_details["terminate_winerror"], 5)
        self.assertEqual(kernel.WaitForSingleObject(handle.handle, 0), 0)
        self.assertNotEqual(handle.exit_time(), "0")

    def test_actual_access_denied_live_object_refuses_after_bound(self):
        handle = self.child()
        query = custody.HeldProcess(
            {
                "pid": self.children[-1].pid,
                "created": handle.created,
                "native_creation": True,
                "executable": handle.executable,
            },
            terminate=False,
        )
        kernel = handle.kernel
        custody._same_kernel_object(handle.handle, query.handle)
        edge = NativeKernelEdge(kernel, denied_handle=query.handle)
        handle.kernel = edge
        try:
            with patch.object(custody, "PROCESS_STOP_SETTLE_MS", 100):
                with self.assertRaises(OSError) as caught:
                    handle.stop()
            self.assertEqual(caught.exception.winerror, 5)
            self.assertEqual(edge.observed["terminate_error"], 5)
            self.assertEqual(handle.stop_details["stage"], "settlement_timeout")
            self.assertEqual(handle.stop_details["settlement_wait"], 258)
            self.assertEqual(kernel.WaitForSingleObject(handle.handle, 0), 258)
            print(json.dumps({"native_live_denial": handle.stop_details}), flush=True)
        finally:
            handle.kernel = kernel
            query.close()

    def test_already_exited_held_identity_is_observed_without_termination(self):
        handle = self.child()
        self.assertEqual(handle.stop(), "stopped_held_identity")
        with patch.object(
            NativeKernelEdge, "TerminateProcess", side_effect=AssertionError
        ):
            original = handle.kernel
            handle.kernel = NativeKernelEdge(original)
            try:
                self.assertEqual(handle.stop(), "already_exited_held_identity")
            finally:
                handle.kernel = original

    def test_query_only_handle_cannot_terminate_live_fixture(self):
        handle = self.child()
        query = custody.HeldProcess(
            {
                "pid": self.children[-1].pid,
                "created": handle.created,
                "native_creation": True,
                "executable": handle.executable,
            },
            terminate=False,
        )
        try:
            with self.assertRaisesRegex(ValueError, "QUERY-only"):
                query.stop()
            self.assertEqual(handle.kernel.WaitForSingleObject(handle.handle, 0), 258)
        finally:
            query.close()

    def independent_child(self, source):
        command = subprocess.list2cmdline(
            [
                str(Path(sys.executable).with_name("pythonw.exe")),
                "-B",
                "-c",
                "import time; time.sleep(90)",
                str(source / "fixture"),
            ]
        )
        script = (
            "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments "
            "@{CommandLine='"
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
                "-Command",
                script,
            ],
            check=True,
            capture_output=True,
            encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        created = json.loads(result.stdout)
        self.assertEqual(created["ReturnValue"], 0)
        row = next(
            r for r in custody.process_snapshot() if r["pid"] == created["ProcessId"]
        )
        handle = custody.HeldProcess(row)
        self.held.append(handle)
        return row["pid"]

    def test_partial_receipt_blocks_copy_then_fresh_same_operation_recovers(self):
        source, target = self.temp / "source", self.temp / "target"
        source.mkdir()
        (source / "dirty.txt").write_bytes(b"uncommitted\r\n")
        (source / "untracked.txt").write_bytes(b"useful WIP")
        db = sqlite3.connect(source / "journal.sqlite")
        try:
            db.execute("CREATE TABLE retained(v)")
            db.execute("INSERT INTO retained VALUES('original')")
            db.commit()
        finally:
            db.close()
        plan_file = self.temp / "plan.json"
        relocation.create_plan(plan_file, [(source, target)])
        plan = relocation.load_plan(plan_file, relocation.digest(plan_file))
        relocation.copy_roots(plan)  # Existing same-operation destination cache.
        fixture_pids = {self.independent_child(source), self.independent_child(source)}
        process_file, saved_file = (
            self.temp / "processes.json",
            self.temp / "saved.json",
        )
        custody.capture(plan, process_file)
        captured = json.loads(process_file.read_text())
        self.assertEqual({r["pid"] for r in captured["processes"]}, fixture_pids)
        relocation.write_json(
            saved_file,
            {
                "operation": plan["operation"],
                "all_streams_saved_stopped": True,
                "streams": ["fixture"],
                "durable_readback_sha256": "0" * 64,
                "protected_processes": [],
                "checked_at": time.time(),
            },
        )
        output = self.temp / "failed-stop.json"
        original_stop = custody.HeldProcess.stop
        intents = []

        def stop_fixture(handle):
            receipt = json.loads(output.read_text())
            intent = receipt["attempts"][-1]
            self.assertEqual(intent["status"], "intent")
            self.assertEqual(intent["stage"], "stop_intent")
            self.assertEqual(intent["created"], handle.created)
            intents.append(intent["pid"])
            if len(intents) == 1:
                return original_stop(handle)
            query = custody.HeldProcess(
                {
                    "pid": intent["pid"],
                    "created": handle.created,
                    "native_creation": True,
                    "executable": handle.executable,
                },
                terminate=False,
            )
            custody._same_kernel_object(handle.handle, query.handle)
            kernel = handle.kernel
            handle.kernel = NativeKernelEdge(kernel, denied_handle=query.handle)
            try:
                return original_stop(handle)
            finally:
                handle.kernel = kernel
                query.close()

        with patch.object(custody.HeldProcess, "stop", stop_fixture):
            with patch.object(custody, "PROCESS_STOP_SETTLE_MS", 100):
                with self.assertRaises(OSError) as caught:
                    custody.stop(
                        plan,
                        process_file,
                        relocation.digest(process_file),
                        saved_file,
                        output,
                    )
        self.assertEqual(caught.exception.winerror, 5)
        failed = json.loads(output.read_text())
        self.assertFalse(failed["all_writers_stopped"])
        self.assertEqual(len(failed["results"]), 1)
        self.assertEqual(
            [a["status"] for a in failed["attempts"]], ["completed", "failed"]
        )
        self.assertEqual(failed["failure"]["pid"], intents[1])
        self.assertEqual(failed["failure"]["stage"], "settlement_timeout")
        self.assertEqual(failed["failure"]["error"]["winerror"], 5)
        with self.assertRaisesRegex(ValueError, "quiescence"):
            relocation.require_stopped(output, plan)
        failed_hash = relocation.digest(output)
        # Fresh normal custody of CURRENT owned processes; never replay old PIDs.
        fresh = self.temp / "fresh-processes.json"
        custody.capture(plan, fresh)
        remaining = json.loads(fresh.read_text())["processes"]
        self.assertEqual([row["pid"] for row in remaining], [intents[1]])
        new_output = self.temp / "recovered-stop.json"
        result = custody.stop(
            plan, fresh, relocation.digest(fresh), saved_file, new_output
        )
        self.assertTrue(result["all_writers_stopped"])
        relocation.require_stopped(new_output, plan)
        relocation.copy_roots(plan, offline=True)
        self.assertEqual(relocation.validate_databases(plan)["databases_checked"], 1)
        self.assertEqual((target / "dirty.txt").read_bytes(), b"uncommitted\r\n")
        self.assertEqual((target / "untracked.txt").read_bytes(), b"useful WIP")
        self.assertEqual(relocation.digest(output), failed_hash)
        self.assertEqual(
            json.loads(plan_file.read_text())["operation"], plan["operation"]
        )
        print(
            json.dumps({"partial_failure": failed, "fresh_recovery": result}),
            flush=True,
        )


if __name__ == "__main__":
    unittest.main()
